import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrate, migrations } from "../server/migrations/index.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { FileStorage } from "../server/file-storage.js";
import { sessionOwner as owner } from "./session-fixture.js";
void test("additive10 preserves valid9 backup and rolls back DDL/version on failed upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-attachment-migrate-"));
  try {
    const path = join(dir, "sticker.sqlite"),
      db = new DatabaseSync(path);
    migrate(
      db,
      migrations.filter((m) => m.version <= 9),
    );
    db.close();
    const before = readFileSync(path);
    assert.equal(validateBackup(dir).schemaVersion, 9);
    assert.deepEqual(readFileSync(path), before);
    const fail = new DatabaseSync(path);
    assert.throws(() => {
      migrate(fail, [
        ...migrations.filter((m) => m.version <= 9),
        {
          version: 10,
          run: (d) => {
            d.exec("CREATE TABLE failed_upgrade(id TEXT)");
            throw new Error("controlled upgrade failure");
          },
        },
      ]);
    });
    assert.equal(fail.prepare("PRAGMA user_version").get()?.user_version, 9);
    assert.equal(
      fail
        .prepare("SELECT name FROM sqlite_schema WHERE name='failed_upgrade'")
        .get(),
      undefined,
    );
    migrate(fail);
    assert.equal(fail.prepare("PRAGMA user_version").get()?.user_version, 10);
    fail.close();
    assert.equal(validateBackup(dir).schemaVersion, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
void test("copied restore and recreated store retain one keyed file/activity, while future schema is refused without writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-attachment-restore-")),
    restored = join(dir, "restored"),
    source = join(dir, "source");
  try {
    const store = new Store(source),
      project = store.createProject(owner, {
        key: "AJ",
        name: "attachment journal",
      }),
      issue = store.createIssue(owner, {
        projectId: project.id,
        title: "restore",
      }),
      files = new FileStorage(source),
      key = randomUUID(),
      bytes = Buffer.from("durable bytes");
    const first = files.withUpload(bytes, "data.bin", (file) => {
      const value = store.addFileAttachment(owner, issue.id, file, key);
      assert.ok(value.storageKey);
      return { storageKey: value.storageKey, value };
    });
    store.close();
    cpSync(source, restored, { recursive: true });
    assert.equal(validateBackup(restored).schemaVersion, 10);
    const fresh = new Store(restored),
      freshFiles = new FileStorage(restored);
    try {
      const replay = freshFiles.withUpload(bytes, "data.bin", (file) => {
        const value = fresh.addFileAttachment(owner, issue.id, file, key);
        assert.ok(value.storageKey);
        return { storageKey: value.storageKey, value };
      });
      assert.deepEqual(replay, first);
      assert.equal(readdirSync(join(restored, "uploads")).length, 1);
      assert.equal(
        fresh
          .getIssue(owner, issue.id)
          .activity.filter((a) => a.action === "attachment_added").length,
        1,
      );
    } finally {
      fresh.close();
    }
    const path = join(restored, "sticker.sqlite"),
      db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=11");
    db.close();
    const before = readFileSync(path);
    assert.throws(() => new Store(restored), /newer/);
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
