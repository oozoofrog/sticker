import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initial } from "../server/migrations/001-initial.js";
import { sessions } from "../server/migrations/002-sessions.js";
import { Store } from "../server/domain.js";
import { validateBackup } from "../server/backup-validation.js";
import { sessionOwner as owner } from "./session-fixture.js";
void test("v2 backups remain read-only valid; upgrade preserves sessions/issues and v3 relationships restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-relations-migrate-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  initial(db);
  const stamp = "2026-10-28T12:00:00.000Z";
  db.prepare(
    "INSERT INTO projects VALUES ('old-project','OP','보존 프로젝트','','#d6ed61',2,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO issues VALUES ('old-issue','old-project','OP-1','보존 이슈','기존 본문','done','none','',NULL,NULL,NULL,'[]',4,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO agent_reports VALUES ('old-report','agent','보존 에이전트','old-project','old-issue','working','보존 보고',?)",
  ).run(stamp);
  sessions(db);
  db.exec("PRAGMA user_version=2");
  db.close();
  const before = readFileSync(path);
  assert.equal(validateBackup(dir).schemaVersion, 2);
  assert.deepEqual(readFileSync(path), before);
  let store = new Store(dir);
  assert.equal(
    store.getIssue(owner, "old-issue").issue.description,
    "기존 본문",
  );
  assert.equal(store.getIssue(owner, "old-issue").issue.revision, 4);
  assert.equal(store.sessions.list(owner)[0]?.lastMessage, "보존 보고");
  const p = store.createProject(owner, { key: "RM", name: "migration" }),
    a = store.createIssue(owner, { projectId: p.id, title: "A" }),
    b = store.createIssue(owner, { projectId: p.id, title: "B" });
  store.relations.add(owner, a.id, {
    kind: "parent",
    targetIssueId: b.id,
    sourceRevision: 1,
    targetRevision: 1,
  });
  store.close();
  assert.equal(validateBackup(dir).schemaVersion, 9);
  store = new Store(dir);
  try {
    assert.equal(store.relations.get(owner, a.id).children[0]?.issue.id, b.id);
  } finally {
    store.close();
  }
});
