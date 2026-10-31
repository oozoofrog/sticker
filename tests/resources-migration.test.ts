import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../server/migrations/index.js";
import { validateBackup } from "../server/backup-validation.js";
import { Store } from "../server/domain.js";
import { FileStorage } from "../server/file-storage.js";
import { sessionOwner as owner } from "./session-fixture.js";
void test("v6 resource migration preserves legacy issue/file/template provenance and v7 restore retains historical shared bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sticker-resource-migrate-")),
    restore = mkdtempSync(join(tmpdir(), "sticker-resource-restore-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(restore, { recursive: true, force: true });
  });
  const path = join(root, "sticker.sqlite"),
    db = new DatabaseSync(path),
    key = randomUUID(),
    templateId = randomUUID();
  for (const step of migrations) if (step.version <= 6) step.run(db);
  db.exec("PRAGMA user_version=6");
  db.prepare(
    "INSERT INTO projects VALUES ('p','RM','보존','','#d6ed61',2,'2026-10-28T12:00:00.000Z','2026-10-28T12:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO issue_templates VALUES (?,'p','원본',1,1,NULL,'2026-10-28T12:00:00.000Z','2026-10-28T12:00:00.000Z')",
  ).run(templateId);
  db.prepare(
    "INSERT INTO template_versions VALUES (?,1,'# 보존','[]','{}','owner','나','2026-10-28T12:00:00.000Z')",
  ).run(templateId);
  db.prepare(
    "INSERT INTO issues(id,projectId,key,title,description,status,priority,assignee,targetVersionId,foundVersionId,fixedVersionId,labels,revision,createdAt,updatedAt,templateId,templateVersion) VALUES ('i','p','RM-1','기존','원문','done','high','',NULL,NULL,NULL,'[]',7,'2026-10-28T12:00:00.000Z','2026-10-28T12:00:00.000Z',?,1)",
  ).run(templateId);
  db.prepare(
    "INSERT INTO attachments VALUES ('a','i','file','old.txt',NULL,?,'text/plain',4,'owner','나','2026-10-28T12:00:00.000Z')",
  ).run(key);
  db.close();
  mkdirSync(join(root, "uploads"));
  writeFileSync(join(root, "uploads", key), "old!");
  const before = readFileSync(path);
  assert.equal(validateBackup(root).schemaVersion, 6);
  assert.deepEqual(readFileSync(path), before);
  const store = new Store(root),
    files = new FileStorage(root);
  let resourceId: string, firstKey: string;
  try {
    const issue = store.getIssue(owner, "i").issue;
    assert.equal(issue.revision, 7);
    assert.equal(issue.description, "원문");
    assert.equal(issue.templateId, templateId);
    assert.equal(
      store.templates.get(owner, templateId).selectedVersion.body,
      "# 보존",
    );
    assert.equal(store.getIssue(owner, "i").attachments[0].storageKey, key);
    const first = files.write(Buffer.from("first version"), "v1.bin"),
      resource = store.resources.createFile(
        owner,
        { projectId: "p", title: "shared", operationId: randomUUID() },
        first,
      );
    resourceId = resource.resource.id;
    firstKey = first.storageKey;
    store.resources.link(owner, "i", {
      resourceId,
      resourceVersion: 1,
      issueRevision: 7,
      operationId: randomUUID(),
    });
    store.resources.updateFile(
      owner,
      resourceId,
      { revision: 1, operationId: randomUUID() },
      files.write(Buffer.from("later version"), "v2.bin"),
    );
    store.resources.remove(owner, resourceId, {
      revision: 2,
      operationId: randomUUID(),
    });
  } finally {
    store.close();
  }
  assert.deepEqual(validateBackup(root), { schemaVersion: 10, fileCount: 3 });
  cpSync(root, restore, { recursive: true });
  const reopened = new Store(restore);
  try {
    assert.equal(reopened.resources.get(owner, resourceId).current, null);
    assert.equal(reopened.resources.get(owner, resourceId).history.length, 2);
    assert.equal(
      reopened.resources.issueLinks(owner, "i")[0].version.version,
      1,
    );
    assert.equal(
      readFileSync(
        join(
          restore,
          "uploads",
          reopened.resources.fileRecord(owner, resourceId, 1).storageKey,
        ),
        "utf8",
      ),
      "first version",
    );
  } finally {
    reopened.close();
  }
  unlinkSync(join(root, "uploads", firstKey));
  assert.throws(() => validateBackup(root), /missing/i);
  writeFileSync(join(root, "uploads", firstKey), "other content");
  assert.throws(() => validateBackup(root), /checksum/i);
});
void test("resource schema backup accepts only actually implemented versions 1–10 and refuses future bytes unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sticker-resource-future-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const store = new Store(root);
  store.close();
  assert.equal(validateBackup(root).schemaVersion, 10);
  const path = join(root, "sticker.sqlite"),
    db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=999");
  db.close();
  const before = readFileSync(path);
  assert.throws(
    () => validateBackup(root),
    /Expected 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\./,
  );
  assert.deepEqual(readFileSync(path), before);
});
