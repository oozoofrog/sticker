import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initial } from "../server/migrations/001-initial.js";
import { migrate, migrations } from "../server/migrations/index.js";
import { openDatabase } from "../server/db.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { randomUUID } from "node:crypto";
import type { Actor } from "../server/types.js";
const owner: Actor = {
  id: "owner",
  name: "나",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
void test("true v1 backup validates read-only and migrates issues, comments, file bytes and labeled legacy report", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-v1-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path),
    key = randomUUID(),
    opaqueKey = randomUUID(),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXf8AAAAASUVORK5CYII=",
      "base64",
    ),
    stamp = "2026-01-01T00:00:00.000Z";
  initial(db);
  db.exec("PRAGMA user_version=1");
  db.prepare(
    "INSERT INTO projects VALUES ('p','PV','기존','설명','#d6ed61',2,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO issues VALUES ('i','p','PV-1','기존 이슈','설명','backlog','none','',NULL,NULL,NULL,'[]',1,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO comments VALUES ('c','i','기존 댓글','owner','나',?)",
  ).run(stamp);
  db.prepare(
    "INSERT INTO attachments VALUES ('a','i','file','fixture.png',NULL,?,'image/png',?,'owner','나',?)",
  ).run(key, png.length, stamp);
  db.prepare(
    "INSERT INTO attachments VALUES ('opaque','i','file','fixture.bin',NULL,?,'application/octet-stream',4,'owner','나',?)",
  ).run(opaqueKey, stamp);
  db.prepare(
    "INSERT INTO agent_reports VALUES ('r','agent','기존 에이전트','p','i','working','이전 단일 보고',?)",
  ).run(stamp);
  db.prepare(
    "INSERT INTO agent_reports VALUES ('rb','blocked-agent','이전 막힘','p','i','blocked','입력 요청인지 알 수 없는 이전 막힘',?)",
  ).run(stamp);
  db.close();
  mkdirSync(join(dir, "uploads"));
  writeFileSync(join(dir, "uploads", key), png);
  writeFileSync(join(dir, "uploads", opaqueKey), Buffer.from([0, 255, 0, 128]));
  const before = readFileSync(path);
  assert.equal(validateBackup(dir).schemaVersion, 1);
  assert.deepEqual(readFileSync(path), before);
  const store = new Store(dir, () => Date.parse(stamp));
  try {
    assert.equal(store.getIssue(owner, "i").comments[0].body, "기존 댓글");
    assert.equal(store.getIssue(owner, "i").attachments[0].storageKey, key);
    const migrated = store.sessions.list(owner),
      original = migrated.find((s) => s.agentId === "agent"),
      blocked = migrated.find((s) => s.agentId === "blocked-agent");
    assert.ok(original);
    assert.ok(blocked);
    assert.equal(original.legacy, true);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.pendingInput, 0);
    assert.equal(blocked.pendingReview, 0);
    assert.equal(
      store.sessions.get(owner, original.id).events[0].message,
      "이전 단일 보고",
    );
  } finally {
    store.close();
  }
  assert.equal(validateBackup(dir).schemaVersion, 8);
  assert.deepEqual(
    readFileSync(join(dir, "uploads", opaqueKey)),
    Buffer.from([0, 255, 0, 128]),
  );
  assert.deepEqual(readFileSync(join(dir, "uploads", key)), png);
});
void test("fresh and v1-upgraded databases have identical schema", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-migration-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const fresh = openDatabase(join(dir, "fresh")),
    old = new DatabaseSync(":memory:");
  try {
    initial(old);
    old.exec("PRAGMA user_version=1");
    migrate(old);
    const sql =
      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    assert.deepEqual(fresh.prepare(sql).all(), old.prepare(sql).all());
  } finally {
    fresh.close();
    old.close();
  }
});
void test("migration failure rolls back every DDL and version change; future version is untouched", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => {
      migrate(db, [
        {
          version: 1,
          run: (d) => {
            d.exec("CREATE TABLE first(id TEXT)");
          },
        },
        {
          version: 2,
          run: (d) => {
            d.exec("CREATE TABLE second(id TEXT)");
            throw new Error("injected failure");
          },
        },
      ]);
    }, /injected failure/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()
        .length,
      0,
    );
    db.exec("PRAGMA user_version=999");
    assert.throws(() => {
      migrate(db);
    }, /newer/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 999);
  } finally {
    db.close();
  }
});
void test("opening an unsupported future database refuses before changing its bytes or journal mode", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-future-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path);
  db.exec("CREATE TABLE future_only(value TEXT); PRAGMA user_version=999;");
  db.close();
  const before = readFileSync(path);
  assert.throws(() => openDatabase(dir), /newer/);
  assert.deepEqual(readFileSync(path), before);
});
void test("a true v5 backup upgrades saved predicates and issues without rewriting their values", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-v5-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "sticker.sqlite"),
    db = new DatabaseSync(path),
    stamp = "2026-10-01T00:00:00.000Z";
  migrate(
    db,
    migrations.filter((step) => step.version <= 5),
  );
  db.prepare(
    "INSERT INTO projects VALUES ('p','OLD','이전 프로젝트','설명','#d6ed61',2,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO issues VALUES ('i','p','OLD-1','보존할 이슈','원래 본문','ready','none','',NULL,NULL,NULL,'[]',1,?,?)",
  ).run(stamp, stamp);
  db.prepare(
    "INSERT INTO saved_views VALUES ('view','owner','p','이전 뷰',?,1,?,?)",
  ).run(
    JSON.stringify({
      projectId: "p",
      status: ["ready"],
      sort: "key_asc",
      mode: "list",
    }),
    stamp,
    stamp,
  );
  db.prepare(
    "INSERT INTO view_preferences VALUES ('owner','p',1,'view','[\"view\"]')",
  ).run();
  db.close();
  const before = readFileSync(path);
  assert.equal(validateBackup(dir).schemaVersion, 5);
  assert.deepEqual(readFileSync(path), before);
  const store = new Store(dir);
  try {
    assert.equal(store.getIssue(owner, "i").issue.description, "원래 본문");
    assert.equal(store.views.get(owner, "view").query.mode, "list");
    assert.equal(
      store.views.query(owner, { projectId: "p", status: ["ready"] }).issues
        .length,
      1,
    );
    const template = store.templates.create(owner, {
      projectId: "p",
      name: "양식",
      body: "보존된 양식",
      requiredFields: [],
      defaults: {},
      operationId: randomUUID(),
    });
    assert.equal(template.template.currentVersion, 1);
  } finally {
    store.close();
  }
  assert.equal(validateBackup(dir).schemaVersion, 8);
});
void test("a failed v6 upgrade rolls back new tables, provenance columns and user_version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const prior = migrations.filter((step) => step.version <= 5);
    migrate(db, prior);
    const sixth = migrations.find((step) => step.version === 6);
    assert.ok(sixth);
    assert.throws(() => {
      migrate(db, [
        ...prior,
        {
          version: 6,
          run: (database) => {
            sixth.run(database);
            throw new Error("injected v6 failure");
          },
        },
      ]);
    }, /injected v6 failure/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 5);
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name='issue_templates'")
        .all().length,
      0,
    );
    assert.equal(
      db
        .prepare("PRAGMA table_info(issues)")
        .all()
        .some((column) => column.name === "templateId"),
      false,
    );
  } finally {
    db.close();
  }
});
