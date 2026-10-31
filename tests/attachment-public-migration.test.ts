import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "../server/migrations/index.js";
import { schemaManifests } from "../server/schema-manifest.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { sessionOwner as owner } from "./session-fixture.js";

function rows(db: DatabaseSync) {
  return Object.fromEntries(
    Object.keys(schemaManifests[9]).map((name) => [
      name,
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
}

void test("public 9 to 10 preserves all prior tables and file bytes without unpublished GitHub tables", (t) => {
  assert.deepEqual(
    migrations.map((m) => m.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    Object.keys(schemaManifests).map(Number),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    Object.keys(schemaManifests[10]).filter(
      (name) => !(name in schemaManifests[9]),
    ),
    ["attachment_operations"],
  );
  const dir = mkdtempSync(join(tmpdir(), "sticker-public-upgrade-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  migrate(
    db,
    migrations.filter((m) => m.version <= 8),
  );
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "INSERT INTO projects VALUES ('p','UP','기존','','#d6ed61',2,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO issues(id,projectId,key,title,description,status,priority,assignee,targetVersionId,fixedVersionId,foundVersionId,labels,revision,createdAt,updatedAt) VALUES ('i','p','UP-1','기존','본문','done','high','',NULL,NULL,NULL,'[]',7,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO activity VALUES ('legacy','i','updated','변경: description','agent','기존','time')",
  ).run();
  db.prepare(
    "INSERT INTO comments VALUES ('comment','i','댓글','owner','나','time')",
  ).run();
  db.prepare(
    "INSERT INTO github_connections VALUES ('p','example','fixture','public',NULL,1,3,NULL,NULL)",
  ).run();
  const key = randomUUID(),
    bytes = Buffer.from("preserved attachment bytes");
  mkdirSync(join(dir, "uploads"));
  writeFileSync(join(dir, "uploads", key), bytes);
  db.prepare(
    "INSERT INTO attachments VALUES ('file','i','file','original.bin',NULL,?,'application/octet-stream',?,'owner','나','time')",
  ).run(key, bytes.length);
  migrate(
    db,
    migrations.filter((m) => m.version <= 9),
  );
  const before = rows(db);
  db.close();
  const oldBytes = readFileSync(path);
  assert.deepEqual(validateBackup(dir), { schemaVersion: 9, fileCount: 1 });
  assert.deepEqual(readFileSync(path), oldBytes);
  const store = new Store(dir);
  assert.equal(store.getIssue(owner, "i").comments[0].body, "댓글");
  assert.equal(
    store.history.get(owner, "i", "legacy").unavailableReason,
    "legacy",
  );
  store.close();
  const upgraded = new DatabaseSync(path, { readOnly: true });
  assert.equal(upgraded.prepare("PRAGMA user_version").get()?.user_version, 10);
  assert.deepEqual(rows(upgraded), before);
  assert.equal(
    upgraded.prepare("SELECT count(*) AS n FROM attachment_operations").get()
      ?.n,
    0,
  );
  assert.deepEqual(
    upgraded
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'github_app_%'",
      )
      .all(),
    [],
  );
  assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  upgraded.close();
  assert.deepEqual(readFileSync(join(dir, "uploads", key)), bytes);
  assert.deepEqual(validateBackup(dir), { schemaVersion: 10, fileCount: 1 });
});

void test("a schema10 label without the attachment journal is rejected without changing bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-public-schema-mismatch-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  migrate(
    db,
    migrations.filter((m) => m.version <= 9),
  );
  db.exec("PRAGMA user_version=10");
  db.close();
  const before = readFileSync(path);
  assert.throws(() => validateBackup(dir), /attachment_operations/);
  assert.deepEqual(readFileSync(path), before);
});
