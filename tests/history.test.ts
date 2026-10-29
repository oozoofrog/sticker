import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store, DomainError } from "../server/domain.js";
import type { Actor } from "../server/types.js";
const owner: Actor = {
  id: "owner",
  name: "나",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-history-"));
  const store = new Store(dir);
  const db = new DatabaseSync(join(dir, "sticker.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject(owner, { key: "HI", name: "이력" });
  const other = store.createProject(owner, { key: "HO", name: "범위 밖" });
  const version = store.createVersion(owner, {
    projectId: project.id,
    name: "v1",
  });
  const next = store.createVersion(owner, {
    projectId: project.id,
    name: "v2",
  });
  const agent: Actor = {
    id: "agent",
    name: "수정 에이전트",
    role: "agent",
    canWrite: true,
    projectIds: [project.id],
  };
  const create = (title = "원래 제목") =>
    store.createIssue(owner, {
      projectId: project.id,
      title,
      description: "원래 본문",
    });
  return { store, db, dir, project, other, version, next, agent, create };
}
function denied(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof DomainError && error.code === code,
  );
}
function editedChange(f: ReturnType<typeof fixture>, id: string) {
  const summary = f.store.history
    .list(owner, id)
    .find((entry) => entry.action === "updated" && entry.comparisonAvailable);
  assert.ok(summary);
  return f.store.history.get(owner, id, summary.id);
}
void test("shared issue mutations record exact normalized changes, author and revisions; old activity never invents comparisons", (t) => {
  const f = fixture(t),
    issue = f.create();
  const created = f.store.history.list(owner, issue.id);
  assert.equal(created.length, 1);
  assert.equal(created[0].unavailableReason, "creation");
  assert.deepEqual(
    [created[0].revisionBefore, created[0].revisionAfter],
    [0, 1],
  );
  f.store.updateIssue(f.agent, issue.id, {
    revision: 1,
    title: " 새 제목 ",
    description: "",
    labels: [" red ", "red", "blue"],
    targetVersionId: f.version.id,
  });
  const change = editedChange(f, issue.id);
  assert.equal(change.authorId, f.agent.id);
  assert.equal(change.authorName, f.agent.name);
  assert.deepEqual([change.revisionBefore, change.revisionAfter], [1, 2]);
  assert.deepEqual(change.changes, [
    { field: "title", before: "원래 제목", after: "새 제목" },
    { field: "description", before: "원래 본문", after: "" },
    { field: "labels", before: [], after: ["red", "blue"] },
    { field: "targetVersionId", before: null, after: f.version.id },
  ]);
  const legacyId = randomUUID();
  f.db
    .prepare("INSERT INTO activity VALUES (?,?,?,?,?,?,?)")
    .run(
      legacyId,
      issue.id,
      "updated",
      "변경: description",
      "legacy",
      "이전 에이전트",
      "2020-01-01T00:00:00Z",
    );
  const legacy = f.store.history.get(owner, issue.id, legacyId);
  assert.equal(legacy.comparisonAvailable, false);
  assert.equal(legacy.unavailableReason, "legacy");
  assert.equal(legacy.revisionBefore, null);
  assert.equal(legacy.revisionAfter, null);
  assert.deepEqual(legacy.changes, []);
  const forbidden = { ...f.agent, projectIds: [f.other.id] };
  denied(() => f.store.history.list(forbidden, issue.id), "PROJECT_SCOPE");
  denied(
    () => f.store.history.get(forbidden, issue.id, change.id),
    "PROJECT_SCOPE",
  );
  const second = f.create("둘째");
  denied(
    () => f.store.history.get(owner, second.id, change.id),
    "HISTORY_NOT_FOUND",
  );
});
void test("owner preview and restore use recorded selected values, preserve unrelated fields and deduplicate one new revision", (t) => {
  const f = fixture(t),
    issue = f.create();
  f.store.updateIssue(f.agent, issue.id, {
    revision: 1,
    title: "새 제목",
    description: "새 본문",
  });
  const source = editedChange(f, issue.id);
  f.store.updateIssue(f.agent, issue.id, { revision: 2, priority: "urgent" });
  const input = {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 3,
    operationId: randomUUID(),
  };
  const preview = f.store.history.preview(owner, issue.id, {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 3,
  });
  assert.deepEqual(preview.changes, [
    { field: "description", before: "새 본문", after: "원래 본문" },
  ]);
  denied(
    () => f.store.history.restore(f.agent, issue.id, input),
    "OWNER_REQUIRED",
  );
  denied(
    () =>
      f.store.history.preview(f.agent, issue.id, {
        changeId: source.id,
        side: "before",
        fields: ["title"],
        revision: 3,
      }),
    "OWNER_REQUIRED",
  );
  denied(
    () =>
      f.store.history.restore({ ...owner, canWrite: false }, issue.id, input),
    "READ_ONLY",
  );
  const restored = f.store.history.restore(owner, issue.id, input);
  assert.equal(restored.issue.description, "원래 본문");
  assert.equal(restored.issue.title, "새 제목");
  assert.equal(restored.issue.priority, "urgent");
  assert.equal(restored.issue.revision, 4);
  assert.equal(restored.change.action, "restored");
  assert.equal(restored.change.sourceChangeId, source.id);
  assert.equal(restored.change.authorId, owner.id);
  assert.deepEqual(restored.change.changes, [
    { field: "description", before: "새 본문", after: "원래 본문" },
  ]);
  const count = f.store.history.list(owner, issue.id).length;
  assert.deepEqual(f.store.history.restore(owner, issue.id, input), restored);
  assert.equal(f.store.history.list(owner, issue.id).length, count);
  denied(
    () =>
      f.store.history.restore(owner, issue.id, { ...input, fields: ["title"] }),
    "OPERATION_CONFLICT",
  );
  denied(
    () =>
      f.store.history.restore(owner, issue.id, {
        ...input,
        operationId: randomUUID(),
      }),
    "REVISION_CONFLICT",
  );
  assert.equal(f.store.getIssue(owner, issue.id).issue.revision, 4);
});
void test("stale preview/commit retain current issue and historical source; deleted and foreign version targets are rejected", (t) => {
  const f = fixture(t),
    issue = f.create();
  f.store.updateIssue(owner, issue.id, {
    revision: 1,
    targetVersionId: f.version.id,
    foundVersionId: f.version.id,
    fixedVersionId: f.version.id,
  });
  const source = editedChange(f, issue.id);
  f.store.deleteVersion(owner, f.version.id);
  const current = f.store.getIssue(owner, issue.id).issue;
  assert.equal(current.revision, 3);
  const removal = f.store.history
    .list(owner, issue.id)
    .find((entry) => entry.action === "version_removed");
  assert.ok(removal);
  assert.deepEqual(
    f.store.history
      .get(owner, issue.id, removal.id)
      .changes.map((change) => change.field),
    ["targetVersionId", "foundVersionId", "fixedVersionId"],
  );
  const input = {
    changeId: source.id,
    side: "after",
    fields: ["targetVersionId"],
    revision: 3,
    operationId: randomUUID(),
  };
  denied(
    () => f.store.history.restore(owner, issue.id, input),
    "VERSION_PROJECT",
  );
  denied(
    () =>
      f.store.history.preview(owner, issue.id, {
        changeId: source.id,
        side: "after",
        fields: ["targetVersionId"],
        revision: 2,
      }),
    "REVISION_CONFLICT",
  );
  assert.deepEqual(f.store.getIssue(owner, issue.id).issue, current);
  assert.equal(
    f.store.history.get(owner, issue.id, source.id).changes.at(0)?.after,
    f.version.id,
  );
  const foreign = f.store.createVersion(owner, {
    projectId: f.other.id,
    name: "foreign",
  });
  f.db
    .prepare(
      "UPDATE issue_field_changes SET afterJson=? WHERE changeId=? AND field='targetVersionId'",
    )
    .run(JSON.stringify(foreign.id), source.id);
  denied(
    () => f.store.history.restore(owner, issue.id, input),
    "VERSION_PROJECT",
  );
  assert.equal(f.store.getIssue(owner, issue.id).issue.revision, 3);
});
void test("history write failure rolls back issue, activity and operation receipt; retries remain usable", (t) => {
  const f = fixture(t),
    issue = f.create();
  f.store.updateIssue(owner, issue.id, { revision: 1, title: "new" });
  const source = editedChange(f, issue.id),
    before = f.store.getIssue(owner, issue.id);
  const input = {
    changeId: source.id,
    side: "before",
    fields: ["title"],
    revision: 2,
    operationId: randomUUID(),
  };
  f.db.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON issue_field_changes BEGIN SELECT RAISE(ABORT, 'history failure'); END",
  );
  assert.throws(
    () => f.store.history.restore(owner, issue.id, input),
    /history failure/,
  );
  assert.deepEqual(f.store.getIssue(owner, issue.id), before);
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM issue_restore_operations").get()?.n,
    0,
  );
  assert.equal(f.store.history.list(owner, issue.id).length, 2);
  assert.throws(
    () =>
      f.store.updateIssue(owner, issue.id, {
        revision: 2,
        description: "failed",
      }),
    /history failure/,
  );
  assert.deepEqual(f.store.getIssue(owner, issue.id), before);
  f.db.exec("DROP TRIGGER fail_history");
  assert.equal(
    f.store.history.restore(owner, issue.id, input).issue.revision,
    3,
  );
});
void test("version deletion is atomic across earlier writable rows and a later owner-only closed issue", (t) => {
  const f = fixture(t);
  const a = f.store.createIssue(owner, {
    projectId: f.project.id,
    title: "first",
    targetVersionId: f.version.id,
  });
  const b = f.store.createIssue(owner, {
    projectId: f.project.id,
    title: "closed",
    status: "closed",
    fixedVersionId: f.version.id,
  });
  denied(() => {
    f.store.deleteVersion(f.agent, f.version.id);
  }, "OWNER_REQUIRED");
  for (const issue of [a, b]) {
    assert.equal(f.store.getIssue(owner, issue.id).issue.revision, 1);
    assert.equal(f.store.history.list(owner, issue.id).length, 1);
  }
  assert.equal(
    f.store
      .bootstrap(owner)
      .versions.some((version) => version.id === f.version.id),
    true,
  );
});
void test("carryover records only committed savepoint items and identical operation replay adds no history", (t) => {
  const f = fixture(t);
  const a = f.store.createIssue(owner, {
    projectId: f.project.id,
    title: "move",
    targetVersionId: f.version.id,
  });
  const b = f.store.createIssue(owner, {
    projectId: f.project.id,
    title: "stale",
    targetVersionId: f.version.id,
  });
  f.store.updateIssue(owner, b.id, { revision: 1, title: "newer" });
  const input = {
    revision: 1,
    destinationVersionId: f.next.id,
    destinationRevision: 1,
    operationId: randomUUID(),
    issues: [
      { issueId: a.id, revision: 1 },
      { issueId: b.id, revision: 1 },
    ],
  };
  const result = f.store.releases.carryover(owner, f.version.id, input);
  assert.deepEqual(
    result.items.map((item) => item.outcome),
    ["moved", "conflict"],
  );
  const changes = f.store.history.list(owner, a.id);
  const moved = changes.find((entry) => entry.action === "carryover");
  assert.ok(moved);
  assert.deepEqual(f.store.history.get(owner, a.id, moved.id).changes, [
    { field: "targetVersionId", before: f.version.id, after: f.next.id },
  ]);
  assert.equal(
    f.store.history
      .list(owner, b.id)
      .filter((entry) => entry.action === "carryover").length,
    0,
  );
  assert.deepEqual(
    f.store.releases.carryover(owner, f.version.id, input),
    result,
  );
  assert.deepEqual(f.store.history.list(owner, a.id), changes);
});
void test("template create retry records once; relation/resource revision-only and no-op changes cannot be restored", (t) => {
  const f = fixture(t);
  const template = f.store.templates.create(owner, {
    projectId: f.project.id,
    name: "기본",
    body: "본문",
    defaults: { priority: "high" },
    requiredFields: [],
    operationId: randomUUID(),
  });
  const input = {
    projectId: f.project.id,
    title: "템플릿",
    templateId: template.template.id,
    templateVersion: 1,
    operationId: randomUUID(),
  };
  const a = f.store.createIssue(owner, input),
    b = f.create("둘째");
  assert.equal(f.store.createIssue(owner, input).id, a.id);
  assert.equal(f.store.history.list(owner, a.id).length, 1);
  f.store.relations.add(owner, a.id, {
    kind: "related",
    targetIssueId: b.id,
    sourceRevision: 1,
    targetRevision: 1,
  });
  const relation = f.store.history
    .list(owner, a.id)
    .find((entry) => entry.action === "relation_added");
  assert.ok(relation);
  assert.equal(relation.unavailableReason, "revision_only");
  assert.deepEqual(relation.fields, []);
  const resource = f.store.resources.create(owner, {
    projectId: f.project.id,
    title: "자료",
    kind: "markdown",
    markdown: "내용",
    operationId: randomUUID(),
  });
  f.store.resources.link(owner, a.id, {
    resourceId: resource.resource.id,
    resourceVersion: 1,
    issueRevision: 2,
    operationId: randomUUID(),
  });
  const linked = f.store.history
    .list(owner, a.id)
    .find((entry) => entry.action === "resource_linked");
  assert.ok(linked);
  assert.equal(linked.unavailableReason, "revision_only");
  f.store.updateIssue(owner, a.id, { revision: 3, priority: "high" });
  const unchanged = f.store.history
    .list(owner, a.id)
    .find((entry) => entry.revisionAfter === 4);
  assert.equal(unchanged?.unavailableReason, "unchanged");
  denied(
    () =>
      f.store.history.restore(owner, a.id, {
        changeId: relation.id,
        side: "before",
        fields: ["title"],
        revision: 4,
        operationId: randomUUID(),
      }),
    "COMPARISON_UNAVAILABLE",
  );
  f.store.deleteIssue(owner, b.id);
  const cleanup = f.store.history
    .list(owner, a.id)
    .find((entry) => entry.action === "relation_target_deleted");
  assert.equal(cleanup?.unavailableReason, "revision_only");
});

void test("creation history insertion failure rolls back template receipt, issue counter and activity before a single retry", (t) => {
  const f = fixture(t);
  const template = f.store.templates.create(owner, {
    projectId: f.project.id,
    name: "실패 원자성",
    body: "본문",
    requiredFields: [],
    defaults: {},
    operationId: randomUUID(),
  });
  const input = {
    projectId: f.project.id,
    title: "생성",
    templateId: template.template.id,
    templateVersion: 1,
    operationId: randomUUID(),
  };
  f.db.exec(
    "CREATE TRIGGER fail_creation_history BEFORE INSERT ON issue_changes BEGIN SELECT RAISE(ABORT, 'creation history failure'); END",
  );
  assert.throws(
    () => f.store.createIssue(owner, input),
    /creation history failure/,
  );
  for (const table of [
    "issues",
    "activity",
    "issue_changes",
    "issue_creation_operations",
  ]) {
    assert.equal(
      f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
      0,
    );
  }
  assert.equal(
    f.db.prepare("SELECT nextIssue FROM projects WHERE id=?").get(f.project.id)
      ?.nextIssue,
    1,
  );
  f.db.exec("DROP TRIGGER fail_creation_history");
  const created = f.store.createIssue(owner, input);
  assert.equal(created.key, "HI-1");
  assert.equal(f.store.createIssue(owner, input).id, created.id);
  assert.equal(f.store.history.list(owner, created.id).length, 1);
});
void test("restore retry after a later edit keeps the current issue, closed-state restore remains owner-only, and actor metadata is not captured", (t) => {
  const f = fixture(t),
    issue = f.create();
  const actor = {
    ...f.agent,
    authorization: "Bearer history-secret-sentinel",
    headers: { cookie: "history-cookie-sentinel" },
  };
  f.store.updateIssue(actor, issue.id, { revision: 1, title: "edited" });
  const source = editedChange(f, issue.id);
  const input = {
    changeId: source.id,
    side: "before",
    fields: ["title"],
    revision: 2,
    operationId: randomUUID(),
  };
  const restored = f.store.history.restore(owner, issue.id, input);
  const later = f.store.updateIssue(owner, issue.id, {
    revision: 3,
    status: "closed",
    description: "owner closed",
  });
  const retry = f.store.history.restore(owner, issue.id, input);
  assert.deepEqual(retry.issue, later);
  assert.deepEqual(retry.change, restored.change);
  const closed = f.store.history
    .list(owner, issue.id)
    .find((entry) => entry.revisionAfter === 4);
  assert.ok(closed);
  const reopen = {
    changeId: closed.id,
    side: "before",
    fields: ["status"],
    revision: 4,
    operationId: randomUUID(),
  };
  denied(
    () => f.store.history.restore(f.agent, issue.id, reopen),
    "OWNER_REQUIRED",
  );
  assert.equal(
    f.store.history.restore(owner, issue.id, reopen).issue.status,
    "backlog",
  );
  assert.equal(
    f.store.getIssue(owner, issue.id).issue.description,
    "owner closed",
  );
  const serialized = JSON.stringify([
    f.db.prepare("SELECT * FROM issue_changes").all(),
    f.db.prepare("SELECT * FROM issue_field_changes").all(),
    f.db.prepare("SELECT * FROM issue_restore_operations").all(),
  ]);
  assert.equal(serialized.includes("history-secret-sentinel"), false);
  assert.equal(serialized.includes("history-cookie-sentinel"), false);
});
