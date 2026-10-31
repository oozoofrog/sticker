import test from "node:test";
import assert from "node:assert/strict";
import { fixture, owner, scope } from "./fixtures/icloud/outbox-fixture.js";

void test("ordinary edits atomically retain normalized content, history and one allowlisted outbox envelope", (t) => {
  const f = fixture(t);
  f.edit({ title: " after ", description: "new body" });
  const rows = f.rows();
  assert.equal(rows.length, 1);
  const value: unknown = JSON.parse(String(rows[0].payload));
  assert.deepEqual(value, {
    version: 1,
    operationId: rows[0].operationId,
    scope,
    issueId: f.issue.id,
    projectId: f.project.id,
    baseRevision: 1,
    revision: 2,
    base: { title: "before", description: "old body" },
    content: { title: "after", description: "new body" },
  });
  const history = f.store.history.list(owner, f.issue.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].id, rows[0].operationId);
  assert.equal(
    f.transport.sends,
    0,
    "nothing sent inside mutation transaction",
  );
});

void test("outbox insertion failure rolls back issue, activity and field history", (t) => {
  const f = fixture(t);
  f.db.exec(
    "CREATE TRIGGER reject_cloud BEFORE INSERT ON fixture_cloud_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  assert.throws(() => f.edit(), /fixture failure/);
  assert.equal(f.store.getIssue(owner, f.issue.id).issue.title, "before");
  assert.equal(f.store.getIssue(owner, f.issue.id).issue.revision, 1);
  assert.equal(f.store.history.list(owner, f.issue.id).length, 1);
  assert.equal(f.rows().length, 0);
});

void test("later observer failure also rolls back capture and no committed notification runs", async (t) => {
  const f = fixture(t);
  let notifications = 0;
  f.store.observeIssueMutations(() => ({
    record() {
      throw new Error("later observer failed");
    },
    committed() {
      notifications++;
    },
  }));
  assert.throws(() => f.edit(), /later observer failed/);
  await f.clock.settle();
  assert.equal(f.rows().length, 0);
  assert.equal(f.store.history.list(owner, f.issue.id).length, 1);
  assert.equal(f.transport.records.size, 0);
  assert.equal(notifications, 0);
});

void test("postcommit notification failure cannot turn accepted content into a rollback", (t) => {
  const f = fixture(t);
  f.store.observeIssueMutations(() => ({
    record() {},
    committed() {
      throw new Error("wake failed");
    },
  }));
  assert.doesNotThrow(() => f.edit());
  assert.equal(f.store.getIssue(owner, f.issue.id).issue.title, "after");
  assert.equal(f.rows().length, 1);
});

void test("unsupported changes, creation, closed issue edits do not claim sync coverage", (t) => {
  const f = fixture(t);
  f.store.createIssue(owner, { projectId: f.project.id, title: "new" });
  f.edit({ priority: "high" });
  f.edit({ title: "mixed", priority: "low" });
  f.edit({ title: "mixed" });
  assert.equal(f.rows().length, 0);
  f.edit({ title: "ordinary" });
  assert.equal(f.rows().length, 1);
  f.edit({ status: "closed" });
  f.edit({ title: "protected" });
  assert.equal(f.rows().length, 1);
});

void test("unauthorized or stale issue writes never enqueue", (t) => {
  const f = fixture(t);
  const denied = { ...owner, role: "agent" as const, canWrite: false };
  assert.throws(() =>
    f.store.updateIssue(denied, f.issue.id, { revision: 1, title: "denied" }),
  );
  assert.throws(() =>
    f.store.updateIssue(owner, f.issue.id, { revision: 2, title: "stale" }),
  );
  assert.equal(f.rows().length, 0);
});
