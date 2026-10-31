import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  sessionHttpFixture,
  sessionOwner as owner,
} from "./session-fixture.js";
const compact = z.object({
  kind: z.enum(["attachment", "resource"]),
  operationId: z.uuid(),
  projectId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  checksum: z.string(),
  historicalCommitted: z.literal(true),
  currentPresent: z.boolean(),
});
void test("fixed upload HEAD authorization uses the same writer/closed/project checks without creating files", async () => {
  const f = await sessionHttpFixture();
  try {
    assert.equal(
      (await f.call(`/issues/${f.issue.id}/attachments`, "agent", "HEAD"))
        .status,
      204,
    );
    assert.equal(
      (await f.call(`/issues/${f.issue.id}/attachments`, "read", "HEAD"))
        .status,
      403,
    );
    assert.equal(
      (await f.call(`/issues/${f.foreign.id}/attachments`, "agent", "HEAD"))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `/projects/${f.project.id}/resources/files`,
          "agent",
          "HEAD",
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await f.call(
          `/projects/${f.project.id}/resources/files`,
          "read",
          "HEAD",
        )
      ).status,
      403,
    );
    f.instance.store.updateIssue(owner, f.issue.id, {
      revision: 1,
      status: "closed",
    });
    assert.equal(
      (await f.call(`/issues/${f.issue.id}/attachments`, "agent", "HEAD"))
        .status,
      403,
    );
    assert.equal(
      (await f.call(`/issues/${f.issue.id}/attachments`, "owner", "HEAD"))
        .status,
      204,
    );
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      0,
    );
  } finally {
    await f.close();
  }
});
void test("attachment compact receipt, bounded hash metadata, exact Range and own durable outcome distinguish current deletion", async () => {
  const f = await sessionHttpFixture();
  try {
    const key = randomUUID(),
      bytes = Buffer.from("bounded file bytes"),
      form = new FormData();
    form.append("operationId", key);
    form.append("file", new Blob([bytes]), "item.bin");
    const response = await fetch(
      `${f.base}/api/issues/${f.issue.id}/attachments?receipt=1`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${f.tokens.agent}` },
        body: form,
      },
    );
    assert.equal(response.status, 201);
    const raw: unknown = await response.json(),
      receipt = compact
        .extend({ attachmentId: z.string(), issueId: z.string() })
        .parse(raw);
    assert.ok(!JSON.stringify(raw).includes("storageKey"));
    assert.equal(
      receipt.checksum,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const metadata = await f.call(
      `/attachments/${receipt.attachmentId}/metadata`,
      "agent",
    );
    assert.equal(metadata.status, 200);
    const meta = z
      .object({
        attachmentId: z.string(),
        projectId: z.string(),
        checksum: z.string(),
        size: z.number(),
      })
      .parse(await metadata.json());
    assert.equal(meta.checksum, receipt.checksum);
    assert.equal(meta.size, bytes.length);
    assert.equal(
      (await f.call(`/attachments/${receipt.attachmentId}/metadata`, "other"))
        .status,
      200,
    );
    const ranged = await fetch(
      `${f.base}/api/attachments/${receipt.attachmentId}/file`,
      {
        headers: {
          authorization: `Bearer ${f.tokens.agent}`,
          range: "bytes=2-6",
        },
      },
    );
    assert.equal(ranged.status, 206);
    assert.equal(
      ranged.headers.get("content-range"),
      `bytes 2-6/${String(bytes.length)}`,
    );
    assert.deepEqual(
      Buffer.from(await ranged.arrayBuffer()),
      bytes.subarray(2, 7),
    );
    const outcomePath = `/projects/${f.project.id}/attachment-operations/${key}`;
    const result = await f.call(outcomePath, "agent");
    assert.equal(result.status, 200);
    assert.equal(
      z.object({ recorded: z.boolean() }).parse(await result.json()).recorded,
      true,
    );
    assert.equal(
      z
        .object({ recorded: z.boolean() })
        .parse(await (await f.call(outcomePath, "other")).json()).recorded,
      false,
    );
    await f.call(`/attachments/${receipt.attachmentId}`, "owner", "DELETE");
    assert.equal(
      (await f.call(`/attachments/${receipt.attachmentId}/metadata`, "agent"))
        .status,
      404,
    );
    const deleted = z
      .object({ recorded: z.literal(true), receipt: compact })
      .parse(await (await f.call(outcomePath, "agent")).json());
    assert.equal(deleted.receipt.currentPresent, false);
    await f.call(`/issues/${f.issue.id}`, "owner", "DELETE");
    assert.equal((await f.call(outcomePath, "agent")).status, 200);
  } finally {
    await f.close();
  }
});
void test("resource file compact responses preserve historical version on replay and explicit old versions after tombstone", async () => {
  const f = await sessionHttpFixture();
  try {
    const bytes = Buffer.from("resource version one"),
      operationId = randomUUID();
    const send = async (path: string, metadata: unknown, data: Buffer) => {
      const form = new FormData();
      form.append("metadata", JSON.stringify(metadata));
      form.append("file", new Blob([new Uint8Array(data)]), "resource.bin");
      return fetch(`${f.base}/api${path}?receipt=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.tokens.agent}` },
        body: form,
      });
    };
    const response = await send(
      `/projects/${f.project.id}/resources/files`,
      { title: "file", operationId },
      bytes,
    );
    assert.equal(response.status, 201);
    const original = compact
      .extend({
        resourceId: z.uuid(),
        resourceVersion: z.number(),
        revision: z.number(),
      })
      .parse(await response.json());
    assert.equal(original.resourceVersion, 1);
    assert.equal(
      (await f.call(`/resources/${original.resourceId}/files`, "agent", "HEAD"))
        .status,
      204,
    );
    const replaced = await send(
      `/resources/${original.resourceId}/files`,
      { revision: original.revision, operationId: randomUUID() },
      Buffer.from("resource two"),
    );
    assert.equal(replaced.status, 200);
    const replay = compact
      .extend({ resourceId: z.uuid(), resourceVersion: z.number() })
      .parse(
        await (
          await send(
            `/projects/${f.project.id}/resources/files`,
            { title: "file", operationId },
            bytes,
          )
        ).json(),
      );
    assert.equal(replay.resourceVersion, 1);
    const detail = f.instance.store.resources.get(owner, original.resourceId);
    f.instance.store.resources.remove(owner, original.resourceId, {
      revision: detail.resource.revision,
      operationId: randomUUID(),
    });
    const file = await f.call(
      `/resources/${original.resourceId}/versions/1/file`,
      "agent",
    );
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  } finally {
    await f.close();
  }
});

void test("compact receipt after deleted-attachment replay stays historical, unkeyed receipt hashes bytes, and invalid receipt option cannot commit", async () => {
  const f = await sessionHttpFixture();
  try {
    const send = async (key: string | undefined, receipt = "1") => {
      const form = new FormData();
      if (key) form.append("operationId", key);
      form.append("file", new Blob(["receipt bytes"]), "file.bin");
      return fetch(
        `${f.base}/api/issues/${f.issue.id}/attachments?receipt=${receipt}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${f.tokens.agent}` },
          body: form,
        },
      );
    };
    const key = randomUUID(),
      created = await send(key);
    assert.equal(created.status, 201);
    const first = compact
      .extend({ attachmentId: z.uuid() })
      .parse(await created.json());
    await f.call(`/attachments/${first.attachmentId}`, "owner", "DELETE");
    const replay = await send(key);
    assert.equal(replay.status, 201);
    assert.equal(compact.parse(await replay.json()).currentPresent, false);
    const unkeyed = await send(undefined);
    assert.equal(unkeyed.status, 201);
    assert.equal(
      z
        .object({ checksum: z.string(), operationId: z.null() })
        .parse(await unkeyed.json()).checksum,
      createHash("sha256").update("receipt bytes").digest("hex"),
    );
    const count = f.instance.store.getIssue(owner, f.issue.id).attachments
      .length;
    assert.equal((await send(randomUUID(), "invalid")).status, 400);
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      count,
    );
  } finally {
    await f.close();
  }
});
