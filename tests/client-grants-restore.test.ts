import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Store } from "../server/domain.js";
import { sessionOwner as owner } from "./session-fixture.js";
import { invalidateRestoredClientGrants } from "../server/client-grants-restore.js";
import { validateBackup } from "../server/backup-validation.js";
import { migrate, migrations } from "../server/migrations/index.js";
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-grant-restore-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  store.clientGrants.attachStatic([]);
  const p = store.createProject(owner, { key: "RS", name: "Restore" });
  const input = {
    clientId: "codex-local",
    installationId: randomUUID(),
    connectionId: randomUUID(),
    projectId: p.id,
    requestedCanWrite: true,
    tokenHash: "a".repeat(64),
    operationId: randomUUID(),
    approvalDigest: "b".repeat(64),
    planExpiresAt: new Date(Date.now() + 240_000).toISOString(),
    confirm: true,
  };
  const grant = store.clientGrants.provision(owner, input);
  const phase = {
    clientId: input.clientId,
    installationId: input.installationId,
    connectionId: input.connectionId,
    approvalDigest: input.approvalDigest,
    operationId: input.operationId,
    revision: 1,
    confirm: true,
  };
  store.clientGrants.activate(owner, grant.current.grantId, phase);
  store.clientGrants.provision(owner, {
    ...input,
    operationId: randomUUID(),
    connectionId: randomUUID(),
    tokenHash: "c".repeat(64),
  });
  store.close();
  return { dir, path: join(dir, "sticker.sqlite"), input, phase, grant };
}
void test("schema11 read-only validation preserves bytes; restore invalidates all authority without replay resurrection", (t) => {
  const f = fixture(t),
    before = readFileSync(f.path);
  assert.equal(validateBackup(f.dir).schemaVersion, 11);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(invalidateRestoredClientGrants(f.dir).invalidated, 2);
  const restored = new Store(f.dir);
  t.after(() => {
    restored.close();
  });
  restored.clientGrants.attachStatic([]);
  assert.equal(restored.clientGrants.resolveHash(f.input.tokenHash), null);
  assert.equal(
    restored.clientGrants.activate(owner, f.grant.current.grantId, f.phase)
      .current.state,
    "revoked",
  );
  assert.equal(
    restored.clientGrants.provision(owner, f.input).current.state,
    "revoked",
  );
  assert.equal(invalidateRestoredClientGrants(f.dir).invalidated, 0);
  const db = new DatabaseSync(f.path, { readOnly: true });
  assert.deepEqual(
    db
      .prepare("SELECT state,reason FROM managed_client_grants")
      .all()
      .map((row) => ({ ...row })),
    [
      { state: "revoked", reason: "restore" },
      { state: "revoked", reason: "restore" },
    ],
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM client_grant_audit WHERE action='restore'",
      )
      .get()?.n,
    2,
  );
  db.close();
});
void test("restore transaction failure rolls back all authority and future schema is never mutated/upgraded", (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.path);
  db.exec(
    "CREATE TRIGGER fixture_fail BEFORE INSERT ON client_grant_audit WHEN NEW.action='restore' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  db.close();
  assert.throws(() => invalidateRestoredClientGrants(f.dir));
  const check = new DatabaseSync(f.path);
  assert.equal(
    check
      .prepare(
        "SELECT COUNT(*) n FROM managed_client_grants WHERE state='revoked'",
      )
      .get()?.n,
    0,
  );
  check.exec("PRAGMA user_version=999");
  check.close();
  const before = readFileSync(f.path);
  assert.throws(() => invalidateRestoredClientGrants(f.dir));
  assert.deepEqual(readFileSync(f.path), before);
});
void test("pre11 restore stages remain their version and ordinary reopen preserves active managed grants", (t) => {
  const f = fixture(t),
    reopened = new Store(f.dir);
  reopened.clientGrants.attachStatic([]);
  assert.equal(
    reopened.clientGrants.resolveHash(f.input.tokenHash)?.actor.canWrite,
    true,
  );
  reopened.close();
  const dir = mkdtempSync(join(tmpdir(), "sticker-pre11-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  migrate(
    db,
    migrations.filter((m) => m.version <= 10),
  );
  db.close();
  const before = readFileSync(path);
  assert.deepEqual(invalidateRestoredClientGrants(dir), {
    schemaVersion: 10,
    invalidated: 0,
  });
  assert.deepEqual(readFileSync(path), before);
});
void test("malformed managed backup rows and phase receipts fail read-only validation without secret echo", (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.path);
  db.prepare(
    "UPDATE client_grant_operations SET receipt=? WHERE phase='activate'",
  ).run('{"rawToken":"private-fixture-canary"}');
  db.close();
  const before = readFileSync(f.path);
  assert.throws(
    () => validateBackup(f.dir),
    (error) =>
      error instanceof Error &&
      !error.message.includes("private-fixture-canary"),
  );
  assert.deepEqual(readFileSync(f.path), before);
});
void test("post-transaction validation failure stays an error with authority already terminal", (t) => {
  const f = fixture(t),
    db = new DatabaseSync(f.path);
  db.exec(
    "CREATE TRIGGER fixture_bad_audit AFTER INSERT ON client_grant_audit WHEN NEW.action='restore' BEGIN UPDATE client_grant_audit SET authorId='invalid' WHERE id=NEW.id; END;",
  );
  db.close();
  assert.throws(() => invalidateRestoredClientGrants(f.dir));
  const check = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(
    check
      .prepare(
        "SELECT COUNT(*) n FROM managed_client_grants WHERE state<>'revoked'",
      )
      .get()?.n,
    0,
  );
  check.close();
});
