import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportClosedFixtureArchive } from "../server/icloud/archive.js";
import { ARCHIVE_TABLES } from "../server/icloud/archive-policy.js";
import {
  fixture,
  addHistory,
  digest,
  excludedCanary,
  contentCanary,
  fileOne,
  fileTwo,
  resourceId,
  snapshotId,
} from "./fixtures/icloud/archive-fixtures.js";

void test("fresh synthetic export excludes all authority rows and exact orphan files, preserves every version", (t) => {
  const f = fixture(t);
  f.close();
  const before = digest(fs.readFileSync(f.database));
  const result = exportClosedFixtureArchive(f.input());
  assert.equal(result.ok, true);
  assert.equal(result.manifest.scope, "synthetic-fixture-only");
  assert.equal(result.manifest.activation, "unsupported");
  assert.equal(result.manifest.attribution, "untrusted-historical-content");
  const target = result.outputRoot;
  assert.deepEqual(fs.readdirSync(target).sort(), [
    "manifest.json",
    "sticker.sqlite",
    "uploads",
  ]);
  assert.deepEqual(fs.readdirSync(join(target, "uploads")).sort(), [
    fileOne,
    fileTwo,
  ]);
  assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(target, "sticker.sqlite")).mode & 0o777, 0o600);
  const db = new DatabaseSync(join(target, "sticker.sqlite"), {
    readOnly: true,
  });
  try {
    for (const [table, policy] of Object.entries(ARCHIVE_TABLES))
      if (!policy.copy)
        assert.equal(
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
          0,
          table,
        );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM resource_versions").get()?.n,
      3,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM template_versions").get()?.n,
      2,
    );
    assert.equal(
      db.prepare("SELECT resourceVersion FROM issue_resource_links").get()
        ?.resourceVersion,
      1,
    );
    assert.equal(
      db.prepare("SELECT authorId FROM comments").get()?.authorId,
      "reused-agent",
    );
    assert.equal(
      db.prepare("SELECT status FROM issues WHERE id='i'").get()?.status,
      "closed",
    );
    assert.equal(
      db.prepare("SELECT isGuidance FROM resources WHERE id=?").get(resourceId)
        ?.isGuidance,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM issue_changes").get()?.n,
      3,
    );
  } finally {
    db.close();
  }
  for (const name of [
    "manifest.json",
    "sticker.sqlite",
    `uploads/${fileOne}`,
    `uploads/${fileTwo}`,
  ])
    assert.equal(
      fs.readFileSync(join(target, name)).includes(Buffer.from(excludedCanary)),
      false,
      name,
    );
  assert.equal(
    fs.readFileSync(join(target, "uploads", fileOne), "utf8"),
    contentCanary,
  );
  assert.equal(digest(fs.readFileSync(f.database)), before);
  assert.notEqual(
    fs.statSync(f.database).ino,
    fs.statSync(join(target, "sticker.sqlite")).ino,
  );
});
void test("freelist credential canary remains in source bytes but never reaches fresh output", (t) => {
  const f = fixture(t);
  f.db
    .prepare(
      "INSERT INTO resource_operations VALUES('owner','trash','trash','p','hash',?)",
    )
    .run(excludedCanary.repeat(10000));
  f.db.exec("DELETE FROM resource_operations WHERE kind='trash'");
  assert.ok(
    Number(f.db.prepare("PRAGMA freelist_count").get()?.freelist_count) > 0,
  );
  f.close();
  assert.ok(fs.readFileSync(f.database).includes(Buffer.from(excludedCanary)));
  const result = exportClosedFixtureArchive(f.input());
  assert.equal(result.ok, true);
  assert.equal(
    fs
      .readFileSync(join(result.outputRoot, "sticker.sqlite"))
      .includes(Buffer.from(excludedCanary)),
    false,
  );
});
void test("live WAL and stray sidecars are refused without changing source", (t) => {
  const f = fixture(t);
  f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  f.db.prepare("UPDATE comments SET body=?").run(excludedCanary);
  const wal = fs.readFileSync(f.database + "-wal");
  assert.deepEqual(exportClosedFixtureArchive(f.input()), {
    ok: false,
    error: { code: "ARCHIVE_SOURCE_NOT_QUIESCENT" },
  });
  assert.deepEqual(fs.readFileSync(f.database + "-wal"), wal);
  f.close();
  const g = fixture(t);
  g.close();
  fs.writeFileSync(g.database + "-journal", excludedCanary);
  assert.deepEqual(exportClosedFixtureArchive(g.input()), {
    ok: false,
    error: { code: "ARCHIVE_SOURCE_NOT_QUIESCENT" },
  });
});
void test("bad schema and missing/hash-mismatched files leave no completed output", (t) => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.db.exec("ALTER TABLE agent_sessions ADD COLUMN secret TEXT");
    },
    (f: ReturnType<typeof fixture>) => {
      fs.unlinkSync(join(f.sourceRoot, "uploads", fileTwo));
    },
    (f: ReturnType<typeof fixture>) => {
      fs.writeFileSync(join(f.sourceRoot, "uploads", fileTwo), "x".repeat(22));
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    f.close();
    const result = exportClosedFixtureArchive(f.input());
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(f.outputParent), []);
    assert.equal(JSON.stringify(result).includes(f.root), false);
  }
});
void test("preexisting output, root/upload symlinks, aliases and hardlinked files fail closed", (t) => {
  const f = fixture(t);
  f.close();
  const child = join(f.outputParent, `fixture-archive-${snapshotId}`);
  fs.mkdirSync(child);
  fs.writeFileSync(join(child, "keep"), "foreign");
  assert.deepEqual(exportClosedFixtureArchive(f.input()), {
    ok: false,
    error: { code: "ARCHIVE_TARGET_UNSAFE" },
  });
  assert.equal(fs.readFileSync(join(child, "keep"), "utf8"), "foreign");
  const g = fixture(t);
  g.close();
  const original = join(g.sourceRoot, "uploads");
  fs.renameSync(original, original + "-real");
  fs.symlinkSync(original + "-real", original);
  assert.equal(exportClosedFixtureArchive(g.input()).ok, false);
  const h = fixture(t);
  h.close();
  fs.linkSync(join(h.sourceRoot, "uploads", fileOne), join(h.root, "hardlink"));
  assert.equal(exportClosedFixtureArchive(h.input()).ok, false);
  const i = fixture(t);
  i.close();
  assert.equal(
    exportClosedFixtureArchive({ ...i.input(), outputParent: i.sourceRoot }).ok,
    false,
  );
  const j = fixture(t);
  j.close();
  fs.symlinkSync(j.sourceRoot, join(j.root, "source-link"));
  assert.equal(
    exportClosedFixtureArchive({
      ...j.input(),
      sourceRoot: join(j.root, "source-link"),
    }).ok,
    false,
  );
});
void test("capacity unknown/insufficient and oversized file fail without a partial completion", (t) => {
  const f = fixture(t);
  f.close();
  for (const availableBytes of [null, 0]) {
    assert.equal(
      exportClosedFixtureArchive({ ...f.input(), availableBytes }).ok,
      false,
    );
    assert.deepEqual(fs.readdirSync(f.outputParent), []);
  }
  const g = fixture(t);
  g.db.exec("UPDATE attachments SET size=20971521");
  g.close();
  assert.equal(exportClosedFixtureArchive(g.input()).ok, false);
  assert.deepEqual(fs.readdirSync(g.outputParent), []);
});
void test("write failure removes only owned incomplete output and reports a bounded error", (t) => {
  const f = fixture(t);
  f.close();
  const mock = t.mock.method(fs, "writeSync", (() => {
    throw Object.assign(new Error("SECRET /private/path"), { code: "ENOSPC" });
  }) as typeof fs.writeSync);
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.deepEqual(result, {
    ok: false,
    error: { code: "INSUFFICIENT_LOCAL_SPACE" },
  });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
  assert.ok(fs.existsSync(f.database));
});
void test("replaced output root is never recursively deleted on failure", (t) => {
  const f = fixture(t);
  f.close();
  const child = join(f.outputParent, `fixture-archive-${snapshotId}`),
    moved = join(f.outputParent, "retained-original");
  const original = fs.writeSync;
  let replaced = false;
  const mock = t.mock.method(fs, "writeSync", ((
    ...args: Parameters<typeof original>
  ) => {
    if (!replaced) {
      replaced = true;
      fs.renameSync(child, moved);
      fs.mkdirSync(child);
      fs.writeFileSync(join(child, "foreign"), "keep");
      throw new Error("injected replacement");
    }
    return Reflect.apply<typeof fs, Parameters<typeof original>, number>(
      original,
      fs,
      args,
    );
  }) as typeof original);
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(join(child, "foreign"), "utf8"), "keep");
  assert.ok(fs.existsSync(moved));
});

void test("failure setting newly created file permissions cleans the owned file", (t) => {
  const f = fixture(t);
  f.close();
  const mock = t.mock.method(fs, "fchmodSync", () => {
    throw new Error("injected chmod failure");
  });
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.deepEqual(result, { ok: false, error: { code: "ARCHIVE_IO" } });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});

void test("a replaced newly created file is retained as foreign during cleanup", (t) => {
  const f = fixture(t);
  f.close();
  const child = join(f.outputParent, `fixture-archive-${snapshotId}`);
  const db = join(child, "sticker.sqlite");
  const original = fs.fchmodSync;
  const mock = t.mock.method(fs, "fchmodSync", (fd: number, mode: fs.Mode) => {
    original(fd, mode);
    fs.renameSync(db, join(child, "moved-original"));
    fs.writeFileSync(db, "foreign replacement");
  });
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.deepEqual(result, {
    ok: false,
    error: { code: "ARCHIVE_TARGET_UNSAFE" },
  });
  assert.equal(fs.readFileSync(db, "utf8"), "foreign replacement");
  assert.ok(fs.existsSync(join(child, "moved-original")));
});
void test("output parent symlinks and upload aliases are rejected without touching their targets", (t) => {
  const f = fixture(t);
  f.close();
  const alias = join(f.root, "alias");
  fs.symlinkSync(f.outputParent, alias);
  assert.deepEqual(
    exportClosedFixtureArchive({ ...f.input(), outputParent: alias }),
    {
      ok: false,
      error: { code: "ARCHIVE_TARGET_UNSAFE" },
    },
  );
  const upload = join(f.sourceRoot, "uploads", fileTwo);
  fs.renameSync(upload, upload + "-real");
  fs.symlinkSync(upload + "-real", upload);
  assert.deepEqual(exportClosedFixtureArchive(f.input()), {
    ok: false,
    error: { code: "ARCHIVE_FILE_UNSAFE" },
  });
  assert.equal(
    fs.readFileSync(upload + "-real", "utf8"),
    "historical version two",
  );
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});
void test("independent verification rejects corrupted copied upload bytes", (t) => {
  const f = fixture(t);
  f.close();
  const original = fs.writeSync;
  let modified = false;
  const mock = t.mock.method(fs, "writeSync", ((
    fd: number,
    data: Uint8Array,
    offset: number,
    length: number,
  ) => {
    if (!modified) {
      modified = true;
      const corrupted = Buffer.from(data);
      corrupted[0] ^= 1;
      return original(fd, corrupted, offset, length);
    }
    return original(fd, data, offset, length);
  }) as typeof fs.writeSync);
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.equal(modified, true);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "ARCHIVE_VALIDATION_FAILED" },
  });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});
void test("changed source database is detected after copying and cannot complete", (t) => {
  const f = fixture(t);
  f.close();
  const original = fs.fsyncSync;
  let modified = false;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    original(fd);
    if (!modified) {
      modified = true;
      const sourceFd = fs.openSync(f.database, "r+");
      // Alter an unused SQLite header byte through the fixture, never the exporter.
      fs.writeSync(sourceFd, Buffer.from([1]), 0, 1, 80);
      fs.closeSync(sourceFd);
    }
  });
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.deepEqual(result, {
    ok: false,
    error: { code: "ARCHIVE_SOURCE_CHANGED" },
  });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});
void test("manifest inventory is bounded before missing uploads are opened", (t) => {
  const f = fixture(t);
  f.db
    .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8000)
    INSERT INTO attachments SELECT 'many-'||x,'i','file','small',NULL,
      printf('%08x-1111-4111-8111-111111111111',x),'text/plain',0,'owner','Old owner','now' FROM n;`);
  f.close();
  assert.deepEqual(exportClosedFixtureArchive(f.input()), {
    ok: false,
    error: { code: "BACKUP_TOO_LARGE" },
  });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});
void test("many small history rows survive source and independent output verification", (t) => {
  const f = fixture(t);
  addHistory(f.db, 8000);
  f.close();
  const result = exportClosedFixtureArchive(f.input());
  assert.equal(result.ok, true);
  const output = new DatabaseSync(join(result.outputRoot, "sticker.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(
      output.prepare("SELECT count(*) AS n FROM issue_changes").get()?.n,
      8003,
    );
    assert.equal(
      output
        .prepare(
          "SELECT count(*) AS n FROM issue_field_changes WHERE beforeJson='\"before\"' AND afterJson='\"after\"'",
        )
        .get()?.n,
      8000,
    );
    assert.equal(
      output
        .prepare("SELECT defaults FROM template_versions WHERE version=1")
        .get()?.defaults,
      '{ "status" : "ready" }',
    );
    assert.equal(
      output.prepare("SELECT labels FROM issues WHERE id='i'").get()?.labels,
      '[ "kept" ]',
    );
  } finally {
    output.close();
  }
});

void test("corrupted final manifest bytes cannot mark an archive complete", (t) => {
  const f = fixture(t);
  f.close();
  const original = fs.writeSync;
  const mock = t.mock.method(fs, "writeSync", ((
    fd: number,
    data: Uint8Array,
    offset: number,
    length: number,
  ) => {
    const bytes = Buffer.from(data);
    if (bytes.subarray(0, 16).toString().startsWith('{"formatVersion"'))
      bytes[0] = 33;
    return original(fd, bytes, offset, length);
  }) as typeof fs.writeSync);
  const result = exportClosedFixtureArchive(f.input());
  mock.mock.restore();
  assert.deepEqual(result, {
    ok: false,
    error: { code: "ARCHIVE_VALIDATION_FAILED" },
  });
  assert.deepEqual(fs.readdirSync(f.outputParent), []);
});
