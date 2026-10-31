import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../server/migrations/index.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { sessionOwner as owner } from "./session-fixture.js";
void test("v7 migrates preserving issue data; v8 GitHub configuration and cached evidence survive backup and restart without network", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sticker-github-migration-")),
    dir = join(root, "data"),
    restore = join(root, "restore");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  // Create an actual older schema, not a current database with a changed version tag.
  const initial = new Store(dir);
  initial.close();
  rmSync(join(dir, "sticker.sqlite"));
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  for (const migration of migrations)
    if (migration.version <= 7) migration.run(db);
  db.exec("PRAGMA user_version=7");
  db.prepare(
    "INSERT INTO projects VALUES ('p','GH','보존','','#d6ed61',2,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO issues(id,projectId,key,title,description,status,priority,assignee,targetVersionId,fixedVersionId,foundVersionId,labels,revision,createdAt,updatedAt) VALUES ('i','p','GH-1','기존','본문','done','high','',NULL,NULL,NULL,'[]',7,'time','time')",
  ).run();
  db.close();
  const before = readFileSync(path);
  assert.equal(validateBackup(dir).schemaVersion, 7);
  assert.deepEqual(readFileSync(path), before);
  const store = new Store(dir);
  assert.equal(store.getIssue(owner, "i").issue.revision, 7);
  const connection = store.github.connect(owner, "p", {
    repository: { owner: "octocat", name: "project" },
    mode: "public",
    revision: 0,
    confirm: true,
  });
  const evidence = store.github.add(owner, "i", {
    url: "https://github.com/octocat/project/pull/1",
    issueRevision: 7,
  });
  assert.equal(connection.providerEnabled, false);
  store.close();
  assert.equal(validateBackup(dir).schemaVersion, 10);
  cpSync(dir, restore, { recursive: true });
  for (const location of [dir, restore]) {
    const reopened = new Store(location);
    try {
      assert.equal(reopened.github.connection(owner, "p").revision, 1);
      const restored = reopened.github.get(owner, evidence.id);
      assert.equal(restored.url, evidence.url);
      assert.equal(restored.disconnected, true);
      assert.equal(restored.snapshot, null);
      assert.equal(reopened.getIssue(owner, "i").issue.revision, 7);
      assert.equal(reopened.getIssue(owner, "i").issue.status, "done");
    } finally {
      reopened.close();
    }
  }
});
