import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const upload = z.object({
  handle: z.uuid(),
  offset: z.number(),
  size: z.number(),
});
const read = z.object({
  handle: z.uuid(),
  size: z.number(),
  checksum: z.string(),
});
const chunk = z.object({
  offset: z.number(),
  length: z.number(),
  base64: z.string(),
  checksum: z.string(),
  eof: z.boolean(),
});
void test("MCP upload/chunk/finalize and pinned attachment download share exact bytes and durable replay", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const bytes = Buffer.from("chunked attachment\n"),
      operationId = randomUUID(),
      input = {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "chunk.bin",
        size: bytes.length,
        checksum: hash(bytes),
        operationId,
      };
    const transfer = await f.ok("agent", "sticker_begin_upload", input, upload);
    await f.denied(
      "other",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: hash(bytes),
      },
      404,
    );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: hash(bytes),
      },
      z.object({ offset: z.literal(bytes.length) }),
    );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: hash(bytes),
      },
      z.object({ offset: z.literal(bytes.length) }),
    );
    const finish = {
        handle: transfer.handle,
        operationId,
        checksum: hash(bytes),
      },
      receipt = await f.ok(
        "agent",
        "sticker_finish_upload",
        finish,
        z.object({
          kind: z.literal("attachment"),
          attachmentId: z.uuid(),
          checksum: z.string(),
        }),
      );
    assert.equal(receipt.checksum, hash(bytes));
    await f.ok(
      "agent",
      "sticker_finish_upload",
      finish,
      z.object({ attachmentId: z.literal(receipt.attachmentId) }),
    );
    const duplicate = await f.ok(
      "agent",
      "sticker_begin_upload",
      input,
      upload,
    );
    await f.ok(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: duplicate.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: hash(bytes),
      },
      z.unknown(),
    );
    await f.ok(
      "agent",
      "sticker_finish_upload",
      { handle: duplicate.handle, operationId, checksum: hash(bytes) },
      z.object({ attachmentId: z.literal(receipt.attachmentId) }),
    );
    const reading = await f.ok(
      "agent",
      "sticker_begin_file_read",
      { target: { kind: "attachment", attachmentId: receipt.attachmentId } },
      read,
    );
    const first = await f.ok(
        "agent",
        "sticker_read_file_chunk",
        { handle: reading.handle, offset: 0, length: 5 },
        chunk,
      ),
      last = await f.ok(
        "agent",
        "sticker_read_file_chunk",
        { handle: reading.handle, offset: 5, length: 65536 },
        chunk,
      );
    assert.deepEqual(
      Buffer.concat([
        Buffer.from(first.base64, "base64"),
        Buffer.from(last.base64, "base64"),
      ]),
      bytes,
    );
    assert.equal(last.eof, true);
    const eof = await f.ok(
      "agent",
      "sticker_read_file_chunk",
      { handle: reading.handle, offset: bytes.length, length: 1 },
      chunk,
    );
    assert.equal(eof.length, 0);
    assert.equal(eof.eof, true);
    await f.ok(
      "agent",
      "sticker_cancel_file_read",
      { handle: reading.handle },
      z.object({ cleanupPending: z.literal(false) }),
    );
  } finally {
    await f.close();
  }
});
void test("MCP transfer capacity counts two full-size reservations and cancel releases them only after cleanup", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const input = {
      target: { kind: "issue_attachment", issueId: f.issue.id },
      name: "capacity.bin",
      size: 20 * 1024 * 1024,
      checksum: "0".repeat(64),
    };
    const a = await f.ok(
        "agent",
        "sticker_begin_upload",
        { ...input, operationId: randomUUID() },
        upload,
      ),
      b = await f.ok(
        "agent",
        "sticker_begin_upload",
        { ...input, operationId: randomUUID() },
        upload,
      );
    await f.denied(
      "agent",
      "sticker_begin_upload",
      { ...input, size: 1, operationId: randomUUID() },
      429,
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: a.handle },
      z.object({ cleanupPending: z.literal(false) }),
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: b.handle },
      z.object({ cleanupPending: z.literal(false) }),
    );
    const empty = await f.ok(
      "agent",
      "sticker_begin_upload",
      {
        ...input,
        size: 0,
        checksum: hash(Buffer.alloc(0)),
        operationId: randomUUID(),
      },
      upload,
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: empty.handle },
      z.unknown(),
    );
  } finally {
    await f.close();
  }
});
void test("MCP rejects incomplete/hash-conflicting chunks without committing or silently changing pinned inputs", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const bytes = Buffer.from("complete"),
      operationId = randomUUID(),
      transfer = await f.ok(
        "agent",
        "sticker_begin_upload",
        {
          target: { kind: "issue_attachment", issueId: f.issue.id },
          name: "integrity.bin",
          size: bytes.length,
          checksum: hash(bytes),
          operationId,
        },
        upload,
      );
    await f.denied(
      "agent",
      "sticker_finish_upload",
      { handle: transfer.handle, operationId, checksum: hash(bytes) },
      409,
    );
    await f.denied(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 0,
        base64: "!!!!",
        checksum: hash(bytes),
      },
      400,
    );
    await f.denied(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 1,
        base64: bytes.toString("base64"),
        checksum: hash(bytes),
      },
      409,
    );
    await f.denied(
      "agent",
      "sticker_write_upload_chunk",
      {
        handle: transfer.handle,
        offset: 0,
        base64: bytes.toString("base64"),
        checksum: "0".repeat(64),
      },
      400,
    );
    await f.denied(
      "agent",
      "sticker_finish_upload",
      {
        handle: transfer.handle,
        operationId: randomUUID(),
        checksum: hash(bytes),
      },
      409,
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: transfer.handle },
      z.unknown(),
    );
    await f.denied(
      "read",
      "sticker_begin_upload",
      {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "read.bin",
        size: bytes.length,
        checksum: hash(bytes),
        operationId: randomUUID(),
      },
      403,
    );
  } finally {
    await f.close();
  }
});
