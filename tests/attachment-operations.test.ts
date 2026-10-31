import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachmentSchema } from "../server/response-schemas.js";
import { validateBackup } from "../server/backup-validation.js";
import {
  sessionHttpFixture,
  sessionOwner as owner,
} from "./session-fixture.js";
async function upload(
  f: Awaited<ReturnType<typeof sessionHttpFixture>>,
  key: string | undefined,
  bytes = Buffer.from("journal file"),
  name = "sample.bin",
  issueId = f.issue.id,
  fields: [string, string][] = [],
) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  if (key !== undefined) form.append("operationId", key);
  for (const [field, value] of fields) form.append(field, value);
  return fetch(`${f.base}/api/issues/${issueId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.tokens.agent}` },
    body: form,
  });
}
void test("shared keyed attachment multipart persists one outcome/activity and rejects changed payload with safe owned-file cleanup", async () => {
  const f = await sessionHttpFixture();
  try {
    const key = randomUUID(),
      first = await upload(f, key);
    assert.equal(first.status, 201);
    const attachment = attachmentSchema.parse(await first.json());
    const responses = await Promise.all([upload(f, key), upload(f, key)]);
    for (const response of responses) {
      assert.equal(response.status, 201);
      assert.deepEqual(
        attachmentSchema.parse(await response.json()),
        attachment,
      );
    }
    const detail = f.instance.store.getIssue(owner, f.issue.id);
    assert.equal(detail.attachments.length, 1);
    assert.equal(
      detail.activity.filter((a) => a.action === "attachment_added").length,
      1,
    );
    assert.equal(readdirSync(join(f.dir, "uploads")).length, 1);
    for (const [bytes, name] of [
      [Buffer.from("changed file"), "sample.bin"],
      [Buffer.from("journal file"), "renamed.bin"],
    ] as const)
      assert.equal((await upload(f, key, bytes, name)).status, 409);
    const secondIssue = f.instance.store.createIssue(owner, {
      projectId: f.project.id,
      title: "another",
    });
    assert.equal(
      (await upload(f, key, undefined, undefined, secondIssue.id)).status,
      409,
    );
    assert.equal(readdirSync(join(f.dir, "uploads")).length, 1);
    const db = new DatabaseSync(join(f.dir, "sticker.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT count(*) n FROM attachment_operations").get()?.n,
        1,
      );
    } finally {
      db.close();
    }
    assert.equal(validateBackup(f.dir).schemaVersion, 10);
    writeFileSync(
      join(f.dir, "uploads", attachment.storageKey ?? ""),
      Buffer.from("broken! file"),
    );
    assert.throws(() => validateBackup(f.dir), /checksum/i);
  } finally {
    await f.close();
  }
});
void test("legacy attachment callers remain unkeyed; optional operationId is the only accepted multipart text field", async () => {
  const f = await sessionHttpFixture();
  try {
    assert.equal((await upload(f, undefined)).status, 201);
    assert.equal((await upload(f, undefined)).status, 201);
    for (const key of ["", "not-a-uuid", "x".repeat(37)])
      assert.equal((await upload(f, key)).status, 400);
    assert.equal(
      (
        await upload(f, randomUUID(), undefined, undefined, undefined, [
          ["operationId", randomUUID()],
        ])
      ).status,
      400,
    );
    assert.equal(
      (
        await upload(f, randomUUID(), undefined, undefined, undefined, [
          ["issueRevision", "1"],
        ])
      ).status,
      400,
    );
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      2,
    );
  } finally {
    await f.close();
  }
});
void test("deleted keyed attachments stay deleted after replay; historical journal survives issue deletion and validates read-only", async () => {
  const f = await sessionHttpFixture();
  try {
    const key = randomUUID(),
      response = await upload(f, key);
    assert.equal(response.status, 201);
    const original = attachmentSchema.parse(await response.json());
    assert.equal(
      (await f.call(`/attachments/${original.id}`, "owner", "DELETE")).status,
      204,
    );
    const replay = await upload(f, key);
    assert.equal(replay.status, 201);
    assert.deepEqual(attachmentSchema.parse(await replay.json()), original);
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      0,
    );
    assert.deepEqual(readdirSync(join(f.dir, "uploads")), []);
    assert.equal(validateBackup(f.dir).schemaVersion, 10);
    assert.equal(
      (await f.call(`/issues/${f.issue.id}`, "owner", "DELETE")).status,
      204,
    );
    assert.equal((await upload(f, key)).status, 404);
    const before = readFileSync(join(f.dir, "sticker.sqlite"));
    validateBackup(f.dir);
    assert.deepEqual(readFileSync(join(f.dir, "sticker.sqlite")), before);
  } finally {
    await f.close();
  }
});

void test("replay rechecks current writer/closed/scope before allocating new disk bytes", async () => {
  const f = await sessionHttpFixture();
  try {
    const key = randomUUID();
    assert.equal((await upload(f, key)).status, 201);
    const original = f.instance.store.getIssue(owner, f.issue.id).issue;
    f.instance.store.updateIssue(owner, f.issue.id, {
      revision: original.revision,
      status: "closed",
    });
    assert.equal((await upload(f, key)).status, 403);
    const open = f.instance.store.getIssue(owner, f.issue.id).issue;
    f.instance.store.updateIssue(owner, f.issue.id, {
      revision: open.revision,
      status: "ready",
    });
    assert.equal(
      (await upload(f, key, undefined, undefined, f.foreign.id)).status,
      403,
    );
    const body = new FormData();
    body.append("file", new Blob(["journal file"]), "sample.bin");
    body.append("operationId", key);
    const read = await fetch(`${f.base}/api/issues/${f.issue.id}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.tokens.read}` },
      body,
    });
    assert.equal(read.status, 403);
    assert.equal(readdirSync(join(f.dir, "uploads")).length, 1);
  } finally {
    await f.close();
  }
});
void test("backup rejects bounded journal corruption while retaining original bytes and historical semantics", async () => {
  const f = await sessionHttpFixture();
  try {
    const key = randomUUID();
    assert.equal((await upload(f, key)).status, 201);
    const db = new DatabaseSync(join(f.dir, "sticker.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT payload,result,payloadHash,attachmentId FROM attachment_operations",
        )
        .get();
      assert.ok(row);
      for (const [column, value] of [
        ["payload", "{"],
        ["payload", " ".repeat(8193)],
        ["payloadHash", "f".repeat(64)],
        ["result", "{}"],
        ["attachmentId", null],
      ] as const) {
        db.prepare(`UPDATE attachment_operations SET ${column}=?`).run(value);
        assert.throws(() => validateBackup(f.dir));
        db.prepare(`UPDATE attachment_operations SET ${column}=?`).run(
          row[column],
        );
      }
    } finally {
      db.close();
    }
    assert.equal(validateBackup(f.dir).fileCount, 1);
  } finally {
    await f.close();
  }
});
