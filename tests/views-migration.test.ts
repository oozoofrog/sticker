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
void test("v4 restores read-only, preserves existing issue/release metadata and persists v5 views/preferences", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-views-migrate-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  for (const migration of migrations)
    if (migration.version <= 4) migration.run(db);
  db.exec("PRAGMA user_version=4");
  db.prepare(
    "INSERT INTO projects VALUES ('p','VV','보존','','#d6ed61',2,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO issues VALUES ('i','p','VV-1','기존','본문','done','high','',NULL,NULL,NULL,'[]',7,'time','time')",
  ).run();
  db.prepare(
    "INSERT INTO versions(id,projectId,name,description,state,dueDate,createdAt,updatedAt,revision) VALUES ('v','p','출시','','released',NULL,'time','time',3)",
  ).run();
  db.close();
  const before = readFileSync(path);
  assert.equal(validateBackup(dir).schemaVersion, 4);
  assert.deepEqual(readFileSync(path), before);
  let store = new Store(dir);
  assert.equal(store.getIssue(owner, "i").issue.revision, 7);
  assert.equal(store.releases.readiness(owner, "v").version.revision, 3);
  const view = store.views.create(owner, {
    name: "검토",
    query: { projectId: "p", status: ["done"] },
  });
  store.views.setPreferences(owner, "p", {
    revision: 0,
    defaultViewId: view.id,
    favoriteIds: [view.id],
  });
  store.close();
  assert.equal(validateBackup(dir).schemaVersion, 8);
  store = new Store(dir);
  try {
    assert.equal(
      store.views.query(owner, store.views.get(owner, view.id).query).issues[0]
        ?.id,
      "i",
    );
    assert.equal(store.views.preferences(owner, "p").defaultViewId, view.id);
  } finally {
    store.close();
  }
});
