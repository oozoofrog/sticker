import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StoreContext } from "../server/store-context.js";
import { ClientGrantService } from "../server/features/client-grants.js";
import { sessionOwner as owner } from "./session-fixture.js";
import { Store } from "../server/domain.js";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-grants-"));
  const seed = new Store(dir);
  const project = seed.createProject(owner, {
    key: "CG",
    name: "Grant fixture",
  });
  seed.close();
  let time = Date.parse("2026-10-31T12:00:00Z");
  const ctx = new StoreContext(dir, () => time);
  const service = new ClientGrantService(ctx);
  service.attachStatic([]);
  t.after(() => {
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const input = () => ({
    clientId: "codex-local",
    installationId: randomUUID(),
    connectionId: randomUUID(),
    projectId: project.id,
    requestedCanWrite: true,
    tokenHash: "a".repeat(64),
    operationId: randomUUID(),
    approvalDigest: "b".repeat(64),
    planExpiresAt: new Date(time + 240_000).toISOString(),
    confirm: true,
  });
  return {
    dir,
    ctx,
    service,
    project,
    input,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
void test("provisional is one-project read-only proof, activates by CAS and never resurrects on replay", (t) => {
  const f = fixture(t),
    input = f.input();
  const p = f.service.provision(owner, input);
  assert.equal(p.current.state, "provisional");
  assert.equal(p.current.canWrite, false);
  assert.deepEqual(p.current.projectIds, [f.project.id]);
  assert.equal(f.service.directory().length, 0);
  assert.deepEqual(f.service.provision(owner, input), p);
  const phase = {
    operationId: input.operationId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    approvalDigest: input.approvalDigest,
    revision: 1,
    confirm: true,
  };
  const active = f.service.activate(owner, p.current.grantId, phase);
  assert.equal(active.current.canWrite, true);
  assert.equal(f.service.directory().length, 1);
  assert.throws(
    () =>
      f.service.revoke(owner, p.current.grantId, {
        ...phase,
        operationId: randomUUID(),
      }),
    { code: "REVISION_CONFLICT" },
  );
  const revoked = f.service.revoke(owner, p.current.grantId, {
    ...phase,
    operationId: randomUUID(),
    revision: 2,
  });
  assert.equal(revoked.current.state, "revoked");
  assert.equal(f.service.resolveHash(input.tokenHash), null);
  assert.equal(
    f.service.activate(owner, p.current.grantId, phase).current.state,
    "revoked",
  );
  assert.equal(f.service.provision(owner, input).current.state, "revoked");
  assert.equal(f.service.operation(owner, input.operationId).phases.length, 2);
  const exposed = JSON.stringify([
    p,
    active,
    revoked,
    f.service.operation(owner, input.operationId),
    f.ctx.db.prepare("SELECT * FROM client_grant_audit").all(),
    f.ctx.db.prepare("SELECT * FROM client_grant_operations").all(),
  ]);
  assert.ok(!exposed.includes(input.tokenHash));
  assert.ok(!exposed.includes("tokenHash"));
});
void test("strict input, owner, bounded plan, immutable replay and retained verifier collisions fail closed", (t) => {
  const f = fixture(t),
    input = f.input();
  for (const change of [
    { confirm: false },
    { projectId: "missing" },
    { planExpiresAt: "2026-02-30T12:00:00Z" },
    { planExpiresAt: "2026-11-01T00:00:00Z" },
    { token: "canary-raw-secret" },
    { projectIds: null },
    { clientId: "claude-desktop" },
  ])
    assert.throws(() => f.service.provision(owner, { ...input, ...change }));
  assert.throws(() => f.service.provision({ ...owner, role: "agent" }, input), {
    code: "OWNER_REQUIRED",
  });
  const p = f.service.provision(owner, input);
  assert.throws(
    () => f.service.provision(owner, { ...input, requestedCanWrite: false }),
    { code: "OPERATION_CONFLICT" },
  );
  assert.throws(
    () =>
      f.service.provision(owner, { ...f.input(), tokenHash: input.tokenHash }),
    { code: "CREDENTIAL_COLLISION" },
  );
  f.advance(240_000);
  assert.equal(f.service.provision(owner, input).current.state, "expired");
  assert.equal(f.service.resolveHash(input.tokenHash), null);
  assert.throws(
    () =>
      f.service.activate(owner, p.current.grantId, { ...input, revision: 1 }),
    { code: "VALIDATION" },
  );
  assert.throws(
    () =>
      f.service.provision(owner, { ...f.input(), tokenHash: input.tokenHash }),
    { code: "CREDENTIAL_COLLISION" },
  );
});
void test("static collisions, attach single-use and total capacity are enforced before provision", (t) => {
  const f = fixture(t);
  assert.throws(() => {
    f.service.attachStatic([]);
  });
  const other = new ClientGrantService(f.ctx);
  other.attachStatic(
    Array.from({ length: 100 }, (_, i) => ({
      id: `static-${String(i)}`,
      tokenHash: i.toString(16).padStart(64, "0"),
    })),
  );
  assert.throws(() => other.provision(owner, f.input()), {
    code: "AGENT_CAPACITY",
  });
  const third = new ClientGrantService(f.ctx);
  third.attachStatic([{ id: "static", tokenHash: "a".repeat(64) }]);
  assert.throws(() => third.provision(owner, f.input()), {
    code: "CREDENTIAL_COLLISION",
  });
  const p = f.service.provision(owner, f.input());
  assert.throws(() => {
    new ClientGrantService(f.ctx).attachStatic([
      { id: p.current.agentId, tokenHash: "c".repeat(64) },
    ]);
  });
});
void test("active survives ordinary service reopen; expiry and lost replies use current state", (t) => {
  const f = fixture(t),
    input = f.input();
  const p = f.service.provision(owner, input);
  const phase = {
    operationId: input.operationId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    approvalDigest: input.approvalDigest,
    revision: 1,
    confirm: true,
  };
  f.service.activate(owner, p.current.grantId, phase);
  const reopened = new ClientGrantService(f.ctx);
  reopened.attachStatic([]);
  assert.equal(reopened.resolveHash(input.tokenHash)?.actor.canWrite, true);
  f.advance(300_000);
  assert.equal(reopened.resolveHash(input.tokenHash)?.actor.canWrite, true);
  assert.equal(
    reopened.operation(owner, input.operationId).current.state,
    "active",
  );
});
void test("project deletion atomically revokes active and provisional grants, rolls back on delete failure", (t) => {
  const f = fixture(t),
    store = new Store(f.dir);
  t.after(() => {
    store.close();
  });
  store.clientGrants.attachStatic([]);
  const input = f.input();
  const a = f.service.provision(owner, input);
  f.service.activate(owner, a.current.grantId, {
    operationId: input.operationId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    approvalDigest: input.approvalDigest,
    revision: 1,
    confirm: true,
  });
  f.service.provision(owner, { ...f.input(), tokenHash: "d".repeat(64) });
  f.ctx.db.exec(
    "CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  assert.throws(() => {
    store.deleteProject(owner, f.project.id);
  });
  assert.equal(
    f.service.operation(owner, input.operationId).current.state,
    "active",
  );
  f.ctx.db.exec("DROP TRIGGER fixture_delete_failure");
  store.deleteProject(owner, f.project.id);
  assert.equal(f.service.resolveHash("a".repeat(64)), null);
  assert.equal(
    f.ctx.db
      .prepare("SELECT state FROM managed_client_grants WHERE grantId=?")
      .get(a.current.grantId)?.state,
    "revoked",
  );
  assert.equal(
    f.ctx.db
      .prepare(
        "SELECT COUNT(*) n FROM client_grant_audit WHERE action='project_deleted'",
      )
      .get()?.n,
    2,
  );
});
void test("AuthManager consults registry every admission, preserves static and rejects expired without owner fallback", async (t) => {
  const { AuthManager } = await import("../server/auth.js");
  const { createHash } = await import("node:crypto");
  const f = fixture(t),
    input = f.input(),
    fake = "synthetic-live-grant-only";
  input.tokenHash = createHash("sha256").update(fake).digest("hex");
  const registry = new ClientGrantService(f.ctx);
  const auth = new AuthManager({
    ownerPassword: "synthetic-owner-password",
    agents: [
      {
        id: "static",
        name: "Static",
        canWrite: false,
        projectIds: null,
        tokenHash: "c".repeat(64),
      },
    ],
  });
  auth.attachManagedRegistry(registry);
  const p = registry.provision(owner, input),
    cookie = `sticker_session=${auth.login("synthetic-owner-password", "fixture") ?? ""}`;
  assert.equal(auth.resolve(`Bearer ${fake}`)?.access?.state, "provisional");
  f.advance(240_000);
  assert.equal(auth.authenticate(`Bearer ${fake}`, cookie), null);
  assert.equal(auth.directory().length, 2);
  const phase = {
    operationId: input.operationId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    clientId: input.clientId,
    approvalDigest: input.approvalDigest,
    revision: 1,
    confirm: true,
  };
  assert.throws(() => registry.activate(owner, p.current.grantId, phase), {
    code: "ACTIVATION_UNAVAILABLE",
  });
  assert.equal(auth.authenticate(undefined, cookie)?.role, "owner");
});
void test("phase receipt uses one timestamp across advancing clock ticks", (t) => {
  const f = fixture(t);
  let ticks = 0;
  const ctx = new StoreContext(
    f.dir,
    () => Date.parse("2026-10-31T12:00:00Z") + ticks++,
  );
  t.after(() => {
    ctx.db.close();
  });
  const service = new ClientGrantService(ctx);
  service.attachStatic([]);
  const input = f.input();
  service.provision(owner, input);
  const row = ctx.db
    .prepare("SELECT receipt,createdAt FROM client_grant_operations")
    .get();
  assert.ok(row);
  assert.equal(
    (JSON.parse(String(row.receipt)) as { recordedAt: string }).recordedAt,
    row.createdAt,
  );
});
void test("provision deadline and all durable phase timestamps use one accepted clock capture", async (t) => {
  const { validateBackup } = await import("../server/backup-validation.js"),
    f = fixture(t),
    start = Date.parse("2026-10-31T12:00:00Z");
  let calls = 0;
  const ctx = new StoreContext(f.dir, () => start + calls++ * 2);
  t.after(() => {
    ctx.db.close();
  });
  const service = new ClientGrantService(ctx);
  service.attachStatic([]);
  const input = {
    ...f.input(),
    planExpiresAt: new Date(start + 1).toISOString(),
  };
  service.provision(owner, input);
  const row = ctx.db
      .prepare("SELECT createdAt,updatedAt FROM managed_client_grants")
      .get(),
    op = ctx.db
      .prepare("SELECT createdAt,receipt FROM client_grant_operations")
      .get(),
    audit = ctx.db.prepare("SELECT createdAt FROM client_grant_audit").get();
  assert.ok(row && op && audit);
  assert.equal(row.createdAt, new Date(start).toISOString());
  assert.equal(row.updatedAt, row.createdAt);
  assert.equal(op.createdAt, row.createdAt);
  assert.equal(audit.createdAt, row.createdAt);
  assert.equal(
    (JSON.parse(String(op.receipt)) as { recordedAt: string }).recordedAt,
    row.createdAt,
  );
  assert.doesNotThrow(() => {
    new ClientGrantService(ctx).attachStatic([]);
  });
  assert.equal(validateBackup(f.dir).schemaVersion, 11);
});
void test("deadline crossed during existing-grant capacity checks rejects with zero durable changes", (t) => {
  const f = fixture(t);
  f.service.provision(owner, f.input());
  const start = Date.parse("2026-10-31T12:00:00Z");
  let calls = 0;
  const ctx = new StoreContext(f.dir, () => start + calls++ * 2);
  t.after(() => {
    ctx.db.close();
  });
  const service = new ClientGrantService(ctx);
  service.attachStatic([]);
  calls = 0;
  const before = () =>
    [
      "managed_client_grants",
      "client_grant_operations",
      "client_grant_audit",
    ].map((table) =>
      ctx.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const saved = before();
  assert.throws(
    () =>
      service.provision(owner, {
        ...f.input(),
        tokenHash: "d".repeat(64),
        planExpiresAt: new Date(start + 1).toISOString(),
      }),
    { code: "PLAN_EXPIRED" },
  );
  assert.deepEqual(before(), saved);
  assert.doesNotThrow(() => {
    new ClientGrantService(ctx).attachStatic([]);
  });
});
void test("activation receipt audit and row share its exact accepted phase timestamp", (t) => {
  const f = fixture(t),
    input = f.input(),
    p = f.service.provision(owner, input),
    start = Date.parse("2026-10-31T12:00:00Z");
  let calls = 0;
  const ctx = new StoreContext(f.dir, () => start + calls++ * 2);
  t.after(() => {
    ctx.db.close();
  });
  const service = new ClientGrantService(ctx);
  service.attachStatic([]);
  calls = 0;
  service.activate(owner, p.current.grantId, {
    clientId: input.clientId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    approvalDigest: input.approvalDigest,
    operationId: input.operationId,
    revision: 1,
    confirm: true,
  });
  const row = ctx.db
      .prepare("SELECT updatedAt FROM managed_client_grants WHERE grantId=?")
      .get(p.current.grantId),
    op = ctx.db
      .prepare(
        "SELECT createdAt FROM client_grant_operations WHERE phase='activate'",
      )
      .get(),
    audit = ctx.db
      .prepare(
        "SELECT createdAt FROM client_grant_audit WHERE action='activate'",
      )
      .get();
  assert.ok(row && op && audit);
  assert.equal(op.createdAt, row.updatedAt);
  assert.equal(audit.createdAt, row.updatedAt);
  assert.doesNotThrow(() => {
    new ClientGrantService(ctx).attachStatic([]);
  });
});
