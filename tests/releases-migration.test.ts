import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../server/migrations/index.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { sessionOwner as owner } from "./session-fixture.js";
for (const version of [1, 2, 3, 4])
  void test(`schema ${String(version)} backup remains read-only valid and upgrades without inventing release events`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "sticker-releases-migration-"));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const path = join(dir, "sticker.sqlite"),
      db = new DatabaseSync(path);
    for (const migration of migrations) {
      if (migration.version <= version) migration.run(db);
    }
    db.exec(`PRAGMA user_version=${String(version)}`);
    db.prepare(
      "INSERT INTO projects VALUES ('p','RV','기존','','#d6ed61',1,'time','time')",
    ).run();
    db.prepare(
      "INSERT INTO versions(id,projectId,name,description,state,dueDate,createdAt,updatedAt) VALUES ('v','p','기존 출시','','released',NULL,'time','time')",
    ).run();
    db.close();
    const bytes = readFileSync(path);
    assert.equal(validateBackup(dir).schemaVersion, version);
    assert.deepEqual(readFileSync(path), bytes);
    const store = new Store(dir);
    try {
      const ready = store.releases.readiness(owner, "v");
      assert.equal(ready.version.state, "released");
      assert.equal(ready.version.revision, 1);
      assert.equal(ready.releaseHistory.length, 0);
    } finally {
      store.close();
    }
    assert.equal(validateBackup(dir).schemaVersion, 8);
  });
void test("future backup refusal reports only implemented schemas v1–v8 without modifying bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-future-release-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  store.close();
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=999");
  db.close();
  const before = readFileSync(path);
  assert.throws(() => validateBackup(dir), /Expected 1, 2, 3, 4, 5, 6, 7, 8/);
  assert.deepEqual(readFileSync(path), before);
});
