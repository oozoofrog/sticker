import { validateManagedGrants } from "../client-grants-validation.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { StoreContext } from "../store-context.js";
import type { Actor } from "../types.js";
import { DomainError } from "../domain-error.js";
import { canonicalJson } from "../canonical-json.js";
import {
  grantProvisionSchema,
  grantPhaseSchema,
  grantRowSchema,
  grantReceiptSchema,
  grantOperationRowSchema,
  type GrantRow,
} from "../contracts/client-grants.js";
export interface StaticGrantIdentity {
  id: string;
  tokenHash: string;
}
export interface ManagedPrincipal {
  actor: Actor;
  access: {
    state: "provisional" | "active";
    grantId: string;
    requestedCanWrite: boolean;
    provisionalUntil: string;
    projectIds: string[];
  };
}
function fail(status: number, code: string): never {
  throw new DomainError(status, code, "관리 연결 권한 요청을 확인하세요.");
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, "VALIDATION");
  return result.data;
}
const fingerprint = (input: unknown) =>
  createHash("sha256").update(canonicalJson(input)).digest("hex");
export class ClientGrantService {
  private statics: readonly StaticGrantIdentity[] | undefined;
  constructor(private readonly context: StoreContext) {}
  private rows() {
    return this.context.db
      .prepare("SELECT * FROM managed_client_grants")
      .all()
      .map((row) => grantRowSchema.parse(row));
  }
  attachStatic(statics: readonly StaticGrantIdentity[]) {
    if (this.statics) throw new Error("Managed registry already attached");
    validateManagedGrants(this.context.db);
    const rows = this.rows();
    if (
      rows.some((r) =>
        statics.some((s) => s.id === r.agentId || s.tokenHash === r.tokenHash),
      ) ||
      statics.length + rows.filter((r) => this.live(r)).length > 100
    )
      throw new Error("Managed registry identity or capacity conflict");
    this.statics = statics.map((s) => ({ ...s }));
  }
  private live(r: GrantRow, at = this.context.clock()) {
    return (
      r.state === "active" ||
      (r.state === "provisional" && Date.parse(r.provisionalUntil) > at)
    );
  }
  private exists(r: GrantRow) {
    return Boolean(
      this.context.db
        .prepare("SELECT id FROM projects WHERE id=?")
        .get(r.projectId),
    );
  }
  private row(id: string) {
    const r = this.context.db
      .prepare("SELECT * FROM managed_client_grants WHERE grantId=?")
      .get(id);
    if (!r) fail(404, "GRANT_NOT_FOUND");
    return grantRowSchema.parse(r);
  }
  private safe(r: GrantRow) {
    const state =
      r.state === "revoked" || !this.exists(r)
        ? "revoked"
        : !this.live(r)
          ? "expired"
          : r.state;
    return {
      grantId: r.grantId,
      agentId: r.agentId,
      clientId: r.clientId,
      installationId: r.installationId,
      connectionId: r.connectionId,
      projectIds: [r.projectId],
      requestedCanWrite: r.requestedCanWrite === 1,
      canWrite: state === "active" && r.requestedCanWrite === 1,
      state,
      revision: r.revision,
      provisionalUntil: r.provisionalUntil,
      planExpiresAt: r.planExpiresAt,
    };
  }
  private result(receipt: z.infer<typeof grantReceiptSchema>, r: GrantRow) {
    return { receipt, current: this.safe(r) };
  }
  private prior(
    owner: Actor,
    operationId: string,
    phase: "provision" | "activate" | "revoke",
    input: unknown,
  ) {
    const raw = this.context.db
      .prepare(
        "SELECT * FROM client_grant_operations WHERE ownerId=? AND operationId=? AND phase=?",
      )
      .get(owner.id, operationId, phase);
    if (!raw) return;
    const row = grantOperationRowSchema.parse(raw);
    if (row.fingerprint !== fingerprint(input)) fail(409, "OPERATION_CONFLICT");
    return this.result(
      grantReceiptSchema.parse(JSON.parse(row.receipt) as unknown),
      this.row(row.grantId),
    );
  }
  private record(
    owner: Actor,
    operationId: string,
    phase: "provision" | "activate" | "revoke",
    input: unknown,
    r: GrantRow,
    stamp: string,
  ) {
    const occupied = this.context.db
      .prepare(
        "SELECT grantId FROM client_grant_operations WHERE ownerId=? AND operationId=? AND grantId<>?",
      )
      .get(owner.id, operationId, r.grantId);
    if (occupied) fail(409, "OPERATION_CONFLICT");
    const receipt = grantReceiptSchema.parse({
      grantId: r.grantId,
      phase,
      revision: r.revision,
      state: r.state,
      recordedAt: stamp,
    });
    this.context.db
      .prepare("INSERT INTO client_grant_operations VALUES (?,?,?,?,?,?,?)")
      .run(
        owner.id,
        operationId,
        phase,
        r.grantId,
        fingerprint(input),
        canonicalJson(receipt),
        receipt.recordedAt,
      );
    this.audit(r, owner.id, phase, stamp);
    return this.result(receipt, r);
  }
  private audit(r: GrantRow, author: string, action: string, stamp: string) {
    this.context.db
      .prepare("INSERT INTO client_grant_audit VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), r.grantId, author, action, r.revision, stamp);
  }
  provision(owner: Actor, input: unknown) {
    this.context.owner(owner);
    const data = parse(grantProvisionSchema, input);
    return this.context.tx(() => {
      const prior = this.prior(owner, data.operationId, "provision", data);
      if (prior) return prior;
      if (!this.statics) fail(503, "REGISTRY_UNAVAILABLE");
      this.context.project(owner, data.projectId);
      const rows = this.rows();
      if (
        this.statics.some((s) => s.tokenHash === data.tokenHash) ||
        rows.some((r) => r.tokenHash === data.tokenHash)
      )
        fail(409, "CREDENTIAL_COLLISION");
      if (this.statics.length + rows.filter((r) => this.live(r)).length >= 100)
        fail(409, "AGENT_CAPACITY");
      const grantId = randomUUID(),
        agentId = `client-${grantId}`;
      if (this.statics.some((s) => s.id === agentId))
        fail(409, "CREDENTIAL_COLLISION");
      // Capture admission only after read-only collision/capacity work. The same
      // instant governs deadline validity and every durable phase timestamp.
      const acceptedAt = this.context.clock(),
        stamp = new Date(acceptedAt).toISOString();
      const remaining = Date.parse(data.planExpiresAt) - acceptedAt;
      if (remaining <= 0 || remaining > 300_000) fail(409, "PLAN_EXPIRED");
      const r = grantRowSchema.parse({
        grantId,
        agentId,
        clientId: data.clientId,
        installationId: data.installationId,
        connectionId: data.connectionId,
        approvalDigest: data.approvalDigest,
        tokenHash: data.tokenHash,
        projectId: data.projectId,
        requestedCanWrite: Number(data.requestedCanWrite),
        ownerId: owner.id,
        planExpiresAt: data.planExpiresAt,
        provisionOperationId: data.operationId,
        revision: 1,
        provisionalUntil: data.planExpiresAt,
        state: "provisional",
        createdAt: stamp,
        updatedAt: stamp,
        reason: "provision",
      });
      const keys = Object.keys(r);
      this.context.db
        .prepare(
          `INSERT INTO managed_client_grants (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        )
        .run(...Object.values(r));
      return this.record(owner, data.operationId, "provision", data, r, stamp);
    });
  }
  activate(owner: Actor, grantId: string, input: unknown) {
    return this.phase(owner, grantId, input, "activate");
  }
  revoke(owner: Actor, grantId: string, input: unknown) {
    return this.phase(owner, grantId, input, "revoke");
  }
  private phase(
    owner: Actor,
    grantId: string,
    input: unknown,
    phase: "activate" | "revoke",
  ) {
    this.context.owner(owner);
    const data = parse(grantPhaseSchema, input);
    const payload = { grantId, ...data };
    return this.context.tx(() => {
      const prior = this.prior(owner, data.operationId, phase, payload);
      if (prior) return prior;
      const r = this.row(grantId);
      if (
        r.ownerId !== owner.id ||
        r.installationId !== data.installationId ||
        r.connectionId !== data.connectionId ||
        r.approvalDigest !== data.approvalDigest ||
        (phase === "activate" && r.provisionOperationId !== data.operationId)
      )
        fail(409, "GRANT_BINDING");
      if (r.revision !== data.revision) fail(409, "REVISION_CONFLICT");
      const acceptedAt = this.context.clock(),
        stamp = new Date(acceptedAt).toISOString();
      if (phase === "activate") {
        if (
          r.state !== "provisional" ||
          !this.live(r, acceptedAt) ||
          Date.parse(r.planExpiresAt) <= acceptedAt
        )
          fail(409, "ACTIVATION_UNAVAILABLE");
        this.context.project(owner, r.projectId);
      }
      if (r.state !== "revoked")
        this.context.db
          .prepare(
            "UPDATE managed_client_grants SET state=?,revision=revision+1,updatedAt=?,reason=? WHERE grantId=? AND revision=?",
          )
          .run(
            phase === "activate" ? "active" : "revoked",
            stamp,
            phase,
            grantId,
            data.revision,
          );
      return this.record(
        owner,
        data.operationId,
        phase,
        payload,
        this.row(grantId),
        stamp,
      );
    });
  }
  operation(owner: Actor, operationId: string) {
    this.context.owner(owner);
    if (!z.uuid().safeParse(operationId).success) fail(400, "VALIDATION");
    const rows = this.context.db
      .prepare(
        "SELECT * FROM client_grant_operations WHERE ownerId=? AND operationId=? ORDER BY createdAt,phase",
      )
      .all(owner.id, operationId)
      .map((r) => grantOperationRowSchema.parse(r));
    if (!rows.length) fail(404, "OPERATION_NOT_FOUND");
    const ids = new Set(rows.map((r) => r.grantId));
    if (ids.size !== 1) fail(409, "OPERATION_CONFLICT");
    return {
      phases: rows.map((r) =>
        grantReceiptSchema.parse(JSON.parse(r.receipt) as unknown),
      ),
      current: this.safe(this.row(rows[0].grantId)),
    };
  }
  resolveHash(hash: string): ManagedPrincipal | null {
    if (!this.statics) return null;
    const raw = this.context.db
      .prepare("SELECT * FROM managed_client_grants WHERE tokenHash=?")
      .get(hash);
    if (!raw) return null;
    const r = grantRowSchema.parse(raw);
    if (!this.live(r) || !this.exists(r)) return null;
    return {
      actor: {
        id: r.agentId,
        name: "Sticker Codex",
        role: "agent",
        canWrite: r.state === "active" && r.requestedCanWrite === 1,
        projectIds: [r.projectId],
      },
      access: {
        state: r.state === "active" ? "active" : "provisional",
        grantId: r.grantId,
        requestedCanWrite: r.requestedCanWrite === 1,
        provisionalUntil: r.provisionalUntil,
        projectIds: [r.projectId],
      },
    };
  }
  directory(): Actor[] {
    if (!this.statics) return [];
    return this.rows()
      .filter((r) => r.state === "active" && this.exists(r))
      .map((r) => ({
        id: r.agentId,
        name: "Sticker Codex",
        role: "agent",
        canWrite: r.requestedCanWrite === 1,
        projectIds: [r.projectId],
      }));
  }
  /** Caller owns the existing project-delete transaction; never commits separately. */
  revokeProject(projectId: string) {
    if (!this.context.db.isTransaction)
      throw new Error("Project revocation requires transaction");
    const stamp = this.context.now();
    for (const r of this.rows().filter(
      (r) => r.projectId === projectId && r.state !== "revoked",
    )) {
      this.context.db
        .prepare(
          "UPDATE managed_client_grants SET state='revoked',revision=revision+1,updatedAt=?,reason='project_deleted' WHERE grantId=?",
        )
        .run(stamp, r.grantId);
      this.audit(this.row(r.grantId), "owner", "project_deleted", stamp);
    }
  }
}
