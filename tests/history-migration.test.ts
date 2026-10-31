import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrations, migrate } from "../server/migrations/index.js";
import { history } from "../server/migrations/009-history.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { sessionOwner as owner } from "./session-fixture.js";
function oldDatabase(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-history-migration-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  for (const migration of migrations.filter((step) => step.version <= 8))
    migration.run(db);
  db.exec("PRAGMA user_version=8; PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects VALUES ('p','HI','기존','','#d6ed61',2,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO issues(id,projectId,key,title,description,status,priority,assignee,targetVersionId,fixedVersionId,foundVersionId,labels,revision,createdAt,updatedAt) VALUES ('i','p','HI-1','이전','본문','done','high','',NULL,NULL,NULL,'[]',7,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO activity VALUES ('legacy','i','updated','변경: description','agent','기존','time')",
  ).run();
  db.prepare(
    "INSERT INTO comments VALUES ('comment','i','댓글','owner','나','time')",
  ).run();
  const key = randomUUID();
  mkdirSync(join(dir, "uploads"));
  writeFileSync(join(dir, "uploads", key), "original bytes");
  db.prepare(
    "INSERT INTO attachments VALUES ('file','i','file','original.bin',NULL,?,'application/octet-stream',14,'owner','나','time')",
  ).run(key);
  db.close();
  return { dir, path, key };
}
void test("real v8 upgrades to v9 without invented prior values and preserves comments/files through backup and restart", (t) => {
  const f = oldDatabase(t),
    bytes = readFileSync(f.path);
  assert.equal(validateBackup(f.dir).schemaVersion, 8);
  assert.deepEqual(readFileSync(f.path), bytes);
  const store = new Store(f.dir);
  const old = store.getIssue(owner, "i");
  assert.equal(old.issue.description, "본문");
  assert.equal(old.comments[0].body, "댓글");
  assert.equal(
    store.history.get(owner, "i", "legacy").unavailableReason,
    "legacy",
  );
  assert.deepEqual(store.history.get(owner, "i", "legacy").changes, []);
  store.updateIssue(owner, "i", { revision: 7, description: "새 본문" });
  const source = store.history
    .list(owner, "i")
    .find((entry) => entry.comparisonAvailable);
  assert.ok(source);
  const input = {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 8,
    operationId: randomUUID(),
  };
  const restored = store.history.restore(owner, "i", input);
  store.close();
  assert.equal(validateBackup(f.dir).schemaVersion, 11);
  const copy = join(f.dir, "restored");
  mkdirSync(copy);
  cpSync(f.path, join(copy, "sticker.sqlite"));
  cpSync(join(f.dir, "uploads"), join(copy, "uploads"), { recursive: true });
  for (const location of [f.dir, copy]) {
    const reopened = new Store(location);
    try {
      assert.deepEqual(reopened.history.restore(owner, "i", input), restored);
      assert.equal(reopened.history.list(owner, "i").length, 3);
      assert.equal(reopened.getIssue(owner, "i").comments[0].body, "댓글");
      assert.equal(
        readFileSync(join(location, "uploads", f.key), "utf8"),
        "original bytes",
      );
    } finally {
      reopened.close();
    }
  }
});
void test("failed v9 migration rolls back every history table and user_version; future backup refusal is byte-identical", (t) => {
  const f = oldDatabase(t),
    db = new DatabaseSync(f.path);
  assert.throws(() => {
    migrate(db, [
      {
        version: 9,
        run: (database) => {
          history(database);
          throw new Error("fail v9");
        },
      },
    ]);
  }, /fail v9/);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 8);
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name='issue_changes'")
      .get(),
    undefined,
  );
  db.exec("PRAGMA user_version=999");
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => validateBackup(f.dir), /Unsupported/);
  assert.throws(() => new Store(f.dir), /newer Sticker/);
  assert.deepEqual(readFileSync(f.path), before);
});
void test("v9 backup validates strict historical values and restore receipts, not only table names", (t) => {
  const f = oldDatabase(t),
    store = new Store(f.dir);
  store.updateIssue(owner, "i", { revision: 7, description: "new" });
  const source = store.history
    .list(owner, "i")
    .find((entry) => entry.comparisonAvailable);
  assert.ok(source);
  store.history.restore(owner, "i", {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 8,
    operationId: randomUUID(),
  });
  store.close();
  assert.equal(validateBackup(f.dir).schemaVersion, 11);
  const db = new DatabaseSync(f.path);
  db.prepare(
    "UPDATE issue_field_changes SET beforeJson=? WHERE changeId=?",
  ).run('{"authorization":"secret"}', source.id);
  assert.throws(() => validateBackup(f.dir), /history/i);
  db.prepare(
    "UPDATE issue_field_changes SET beforeJson=? WHERE changeId=?",
  ).run(JSON.stringify("본문"), source.id);
  db.prepare("UPDATE issue_restore_operations SET payload=?").run(
    '{"authorization":"secret"}',
  );
  assert.throws(() => validateBackup(f.dir), /history/i);
  db.close();
});

void test("backup refuses invented field changes whose normalized before and after values are equal", (t) => {
  const f = oldDatabase(t),
    store = new Store(f.dir);
  store.updateIssue(owner, "i", { revision: 7, description: "new" });
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE issue_field_changes SET afterJson=beforeJson");
  db.close();
  assert.throws(() => validateBackup(f.dir), /history/i);
});
