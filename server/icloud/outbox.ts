import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonicalJson } from "../canonical-json.js";
import type { IssueMutationObserver } from "../store-context.js";
import {
  issueEnvelopeSchema,
  ordinaryIssueEnvelope,
  type IssueEnvelope,
} from "./mutations.js";
import { accountStateSchema, scopeSchema, type Scope } from "./contracts.js";
export type { IssueEnvelope } from "./mutations.js";

/** Supplied synthetic transport only. No default provider, filesystem or native access. */
export interface FixtureTransport {
  lookup(operationId: string): Promise<unknown>;
  send(envelope: IssueEnvelope, digest: string): Promise<unknown>;
}
interface Options {
  clock: () => number;
  schedule: (callback: () => void, delay: number) => () => void;
  transport: FixtureTransport;
}
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const savedSchema = z
  .object({
    kind: z.literal("saved"),
    operationId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const responseSchema = z.union([
  savedSchema,
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("retry"),
      code: z.enum(["OFFLINE", "QUOTA", "THROTTLED"]),
      retryAfterMs: z.number().int().min(1000).max(86400000),
    })
    .strict(),
]);
const maxBytes = 1024 * 1024;
const digestOf = (payload: string) =>
  createHash("sha256").update(payload).digest("hex");

/** Unmounted partial prototype: tables are supplied by test-owned fixture DDL. */
export class SyntheticIssueOutbox {
  private started = false;
  private online = true;
  private running = false;
  private incarnation = 0;
  private cancel: (() => void) | null = null;
  private errorCode: "LOCAL_STATE_INVALID" | null = null;
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: Options,
  ) {}

  private boundary() {
    const raw = this.db
      .prepare("SELECT * FROM fixture_cloud_boundary WHERE singleton=1")
      .get();
    if (!raw) throw new Error("CLOUD_NOT_BOUND");
    return {
      availability: accountStateSchema.parse(raw.availability),
      scope:
        raw.scope === null
          ? null
          : scopeSchema.parse(JSON.parse(String(raw.scope))),
      lastScope:
        raw.lastScope === null
          ? null
          : scopeSchema.parse(JSON.parse(String(raw.lastScope))),
      fence: integer.parse(raw.fence),
    };
  }
  observer(): IssueMutationObserver {
    return {
      record: (event) => {
        if (!this.db.isTransaction)
          throw new Error("CLOUD_TRANSACTION_REQUIRED");
        const boundary = this.boundary();
        if (!boundary.lastScope) throw new Error("CLOUD_NOT_BOUND");
        const envelope = ordinaryIssueEnvelope(event, boundary.lastScope);
        if (!envelope) return;
        const payload = canonicalJson(envelope);
        if (Buffer.byteLength(payload) > maxBytes)
          throw new Error("CLOUD_CONTENT_LIMIT");
        this.db
          .prepare(
            "INSERT INTO fixture_cloud_outbox(operationId,scope,fence,payload,digest,state) VALUES(?,?,?,?,?,?)",
          )
          .run(
            envelope.operationId,
            canonicalJson(envelope.scope),
            boundary.fence,
            payload,
            digestOf(payload),
            boundary.scope ? "pending" : "quarantined",
          );
      },
      committed: () => {
        this.wake();
      },
    };
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.errorCode = null;
    this.incarnation++;
    this.wake();
  }
  stop() {
    this.started = false;
    this.incarnation++;
    this.cancel?.();
    this.cancel = null;
  }
  setOnline(online: boolean) {
    this.online = z.boolean().parse(online);
    if (online) this.wake();
    else {
      this.cancel?.();
      this.cancel = null;
    }
  }
  private transaction(fn: () => void) {
    if (this.db.isTransaction)
      throw new Error("CLOUD_BOUNDARY_DURING_MUTATION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private quarantine() {
    this.db
      .prepare(
        "UPDATE fixture_cloud_outbox SET state='quarantined',errorCode='SCOPE_CHANGED' WHERE state IN ('pending','inflight')",
      )
      .run();
  }
  observeAccount(input: z.infer<typeof accountStateSchema>) {
    const state = accountStateSchema.parse(input);
    this.transaction(() => {
      const b = this.boundary();
      if (state === "available") {
        // Observation cannot create/recover a binding or grant dispatch.
        this.db
          .prepare(
            "UPDATE fixture_cloud_boundary SET availability=? WHERE singleton=1",
          )
          .run(state);
      } else {
        if (b.fence === Number.MAX_SAFE_INTEGER)
          throw new Error("CLOUD_FENCE_EXHAUSTED");
        this.db
          .prepare(
            "UPDATE fixture_cloud_boundary SET availability=?,scope=NULL,fence=fence+1 WHERE singleton=1",
          )
          .run(state);
        this.quarantine();
      }
    });
    this.wake();
  }
  /** Explicit fixture binding operation, never invoked by account availability. */
  bindScope(input: Scope) {
    const scope = scopeSchema.parse(input);
    this.transaction(() => {
      const b = this.boundary();
      if (b.availability !== "available")
        throw new Error("CLOUD_ACCOUNT_UNAVAILABLE");
      if (
        b.lastScope &&
        (scope.accountEpoch < b.lastScope.accountEpoch ||
          (!b.scope && scope.accountEpoch <= b.lastScope.accountEpoch))
      )
        throw new Error("CLOUD_STALE_SCOPE");
      if (b.scope && canonicalJson(b.scope) === canonicalJson(scope)) return;
      if (b.fence === Number.MAX_SAFE_INTEGER)
        throw new Error("CLOUD_FENCE_EXHAUSTED");
      this.quarantine();
      this.db
        .prepare(
          "UPDATE fixture_cloud_boundary SET scope=?,lastScope=?,fence=fence+1 WHERE singleton=1",
        )
        .run(canonicalJson(scope), canonicalJson(scope));
    });
    this.wake();
  }
  status() {
    const counts = { pending: 0, acknowledged: 0, quarantined: 0, blocked: 0 };
    let bound = false;
    try {
      const boundary = this.boundary();
      bound = boundary.availability === "available" && boundary.scope !== null;
      for (const row of this.db
        .prepare(
          "SELECT state,count(*) AS total FROM fixture_cloud_outbox GROUP BY state",
        )
        .iterate()) {
        const total = integer.parse(row.total);
        if (row.state === "pending" || row.state === "inflight")
          counts.pending += total;
        else if (
          row.state === "acknowledged" ||
          row.state === "quarantined" ||
          row.state === "blocked"
        )
          counts[row.state] = total;
        else throw new Error("CLOUD_INVALID_STATE");
      }
    } catch {
      this.errorCode = "LOCAL_STATE_INVALID";
    }
    return {
      mode: "synthetic" as const,
      bound,
      online: this.online,
      ...counts,
      errorCode: this.errorCode,
    };
  }
  private wake(delay = 0) {
    if (!this.started || !this.online || this.running || this.errorCode) return;
    this.cancel?.();
    this.cancel = this.options.schedule(() => {
      this.cancel = null;
      void this.run().catch(() => {
        this.errorCode = "LOCAL_STATE_INVALID";
      });
    }, delay);
  }
  private active() {
    return this.started && this.online;
  }
  private current(scope: string, fence: number, incarnation: number) {
    if (!this.started || !this.online || this.incarnation !== incarnation)
      return false;
    const b = this.boundary();
    return (
      b.availability === "available" &&
      b.scope !== null &&
      b.fence === fence &&
      canonicalJson(b.scope) === scope
    );
  }
  private mark(
    sequence: number,
    state: "blocked" | "acknowledged",
    code: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE fixture_cloud_outbox SET state=?,errorCode=?,retryAt=0 WHERE sequence=?",
      )
      .run(state, code, sequence);
  }
  private retry(sequence: number, code: string, delay: number) {
    const now = integer.parse(this.options.clock());
    if (now > Number.MAX_SAFE_INTEGER - delay)
      throw new Error("CLOUD_CLOCK_EXHAUSTED");
    this.db
      .prepare(
        "UPDATE fixture_cloud_outbox SET errorCode=?,retryAt=? WHERE sequence=? AND state='inflight'",
      )
      .run(code, now + delay, sequence);
  }
  private async run() {
    if (this.running || !this.started || !this.online) return;
    this.running = true;
    const incarnation = this.incarnation;
    try {
      let bytes = 0;
      for (let count = 0; count < 100; count++) {
        const b = this.boundary();
        if (
          !b.scope ||
          b.availability !== "available" ||
          !this.current(canonicalJson(b.scope), b.fence, incarnation)
        )
          break;
        // Check length before retrieving content. Only one bounded payload is resident.
        const row = this.db
          .prepare(
            "SELECT sequence,operationId,scope,fence,digest,retryAt,length(CAST(payload AS BLOB)) AS bytes FROM fixture_cloud_outbox WHERE state IN ('pending','inflight') ORDER BY sequence LIMIT 1",
          )
          .get();
        if (!row) break;
        if (integer.parse(row.retryAt) > integer.parse(this.options.clock()))
          break;
        const sequence = integer.parse(row.sequence),
          fence = integer.parse(row.fence);
        if (
          typeof row.scope !== "string" ||
          row.scope !== canonicalJson(b.scope) ||
          fence !== b.fence
        ) {
          this.mark(sequence, "blocked", "SCOPE_MISMATCH");
          continue;
        }
        if (
          typeof row.bytes !== "number" ||
          row.bytes < 1 ||
          row.bytes > maxBytes
        ) {
          this.mark(sequence, "blocked", "INVALID_ENVELOPE");
          continue;
        }
        if (bytes + row.bytes > maxBytes) break;
        bytes += row.bytes;
        const raw = this.db
          .prepare("SELECT payload FROM fixture_cloud_outbox WHERE sequence=?")
          .get(sequence);
        let envelope: IssueEnvelope;
        const payload = String(raw?.payload);
        try {
          envelope = issueEnvelopeSchema.parse(JSON.parse(payload));
          if (
            canonicalJson(envelope) !== payload ||
            digestOf(payload) !== row.digest ||
            envelope.operationId !== row.operationId ||
            canonicalJson(envelope.scope) !== row.scope
          )
            throw new Error("CLOUD_INVALID_ENVELOPE");
        } catch {
          this.mark(sequence, "blocked", "INVALID_ENVELOPE");
          continue;
        }
        const digest = row.digest;
        if (!this.current(row.scope, fence, incarnation)) break;
        this.db
          .prepare(
            "UPDATE fixture_cloud_outbox SET state='inflight',attempts=attempts+1 WHERE sequence=?",
          )
          .run(sequence);
        try {
          // Always read back first: a prior attempt may have succeeded before crashing.
          let response = responseSchema.parse(
            await this.options.transport.lookup(envelope.operationId),
          );
          if (!this.current(row.scope, fence, incarnation)) break;
          if (response.kind === "missing") {
            response = responseSchema.parse(
              await this.options.transport.send(envelope, digest),
            );
            if (!this.current(row.scope, fence, incarnation)) break;
          }
          if (response.kind === "retry")
            this.retry(sequence, response.code, response.retryAfterMs);
          else if (
            response.kind === "saved" &&
            response.operationId === envelope.operationId &&
            response.digest === digest
          )
            this.mark(sequence, "acknowledged", null);
          else this.mark(sequence, "blocked", "REMOTE_MISMATCH");
        } catch {
          if (!this.current(row.scope, fence, incarnation)) break;
          this.retry(sequence, "TRANSPORT_UNAVAILABLE", 1000);
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.active()) return;
    if (this.incarnation !== incarnation) {
      this.wake();
      return;
    }
    const b = this.boundary();
    if (!b.scope || b.availability !== "available") return;
    const next = this.db
      .prepare(
        "SELECT retryAt AS at FROM fixture_cloud_outbox WHERE state IN ('pending','inflight') ORDER BY sequence LIMIT 1",
      )
      .get();
    if (next?.at !== null && next?.at !== undefined)
      this.wake(
        Math.max(
          0,
          integer.parse(next.at) - integer.parse(this.options.clock()),
        ),
      );
  }
}
