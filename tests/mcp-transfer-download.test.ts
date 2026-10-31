import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { TransferManager } from "../server/mcp/transfer-manager.js";
import { TransferArena } from "../server/mcp/transfer-arena.js";
import { createStickerTransport, ApiError } from "../server/mcp/transport.js";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function setup() {
  const f = await ordinaryMcpFixture(),
    arena = new TransferArena(),
    manager = new TransferManager(
      createStickerTransport({
        apiUrl: f.apiUrl,
        auth: { mode: "agent", token: f.tokens.agent },
      }),
      { arena },
    ),
    bytes = Buffer.from("0123456789abcdef"),
    operationId = randomUUID(),
    upload = await manager.beginUpload({
      target: { kind: "issue_attachment", issueId: f.issue.id },
      name: "download.bin",
      size: bytes.length,
      checksum: hash(bytes),
      operationId,
    });
  await manager.writeChunk({
    handle: upload.handle,
    offset: 0,
    base64: bytes.toString("base64"),
    checksum: hash(bytes),
  });
  const receipt = await manager.finishUpload({
    handle: upload.handle,
    operationId,
    checksum: hash(bytes),
  });
  assert.equal(receipt.kind, "attachment");
  return { f, arena, manager, bytes, attachmentId: receipt.attachmentId };
}
void test("malformed Range headers cancel the unconsumed body before releasing the download lane", async (t) => {
  const { f, manager, attachmentId } = await setup(),
    realFetch = globalThis.fetch;
  let canceled = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file"))
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              canceled++;
            },
          }),
          { status: 206, headers: { "content-range": "bytes 99-100/16" } },
        );
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginRead({
      target: { kind: "attachment", attachmentId },
    });
    await assert.rejects(
      manager.readChunk({ handle: h.handle, offset: 0, length: 2 }),
      (error) => error instanceof ApiError && error.status === 502,
    );
    assert.equal(
      canceled,
      1,
      "rejected response still owns a live body until cancellation settles",
    );
  } finally {
    await manager.dispose();
    await f.close();
  }
});
void test("Range response bounds reject transformed/multipart/wrong lengths before exposing bytes", async (t) => {
  const { f, manager, attachmentId } = await setup(),
    realFetch = globalThis.fetch;
  let response: () => Response = () => new Response();
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file"))
        return response();
      return realFetch(input, init);
    },
  );
  try {
    const cases: { headers: Record<string, string>; bytes: number }[] = [
      { headers: { "content-range": "bytes 1-4/16" }, bytes: 4 },
      { headers: { "content-range": "bytes 0-3/17" }, bytes: 4 },
      {
        headers: {
          "content-range": "bytes 0-3/16",
          "content-encoding": "gzip",
        },
        bytes: 4,
      },
      {
        headers: {
          "content-range": "bytes 0-3/16",
          "content-type": "multipart/byteranges; boundary=x",
        },
        bytes: 4,
      },
      {
        headers: { "content-range": "bytes 0-3/16", "content-length": "5" },
        bytes: 4,
      },
      { headers: { "content-range": "bytes 0-3/16" }, bytes: 3 },
      { headers: { "content-range": "bytes 0-3/16" }, bytes: 5 },
      { headers: { "content-range": "bytes 0-3/16" }, bytes: 65537 },
    ];
    for (const item of cases) {
      const h = await manager.beginRead({
        target: { kind: "attachment", attachmentId },
      });
      response = () =>
        new Response(Buffer.alloc(item.bytes), {
          status: 206,
          headers: item.headers,
        });
      await assert.rejects(
        manager.readChunk({ handle: h.handle, offset: 0, length: 4 }),
        (error) => error instanceof ApiError && error.status === 502,
      );
      await manager.cancel(h.handle, "download").catch(() => undefined);
    }
  } finally {
    await manager.dispose();
    await f.close();
  }
});
void test("bounded200 fallback verifies whole hash once, preserves nonzero offset, reauthorizes cache and stops after target deletion", async (t) => {
  const { f, manager, arena, attachmentId, bytes } = await setup(),
    realFetch = globalThis.fetch;
  let gets = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file")) {
        gets++;
        return new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        });
      }
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginRead({
        target: { kind: "attachment", attachmentId },
      }),
      part = await manager.readChunk({
        handle: h.handle,
        offset: 3,
        length: 5,
      });
    assert.deepEqual(Buffer.from(part.base64, "base64"), bytes.subarray(3, 8));
    await manager.readChunk({ handle: h.handle, offset: 0, length: 2 });
    assert.equal(gets, 1);
    await f.ok(
      "owner",
      "sticker_delete_attachment",
      { attachmentId },
      (await import("zod")).z.unknown(),
    );
    await assert.rejects(
      manager.readChunk({ handle: h.handle, offset: 0, length: 1 }),
      (error) => error instanceof ApiError && error.status === 404,
    );
    assert.equal(gets, 1);
    assert.equal(arena.stats().liveHandles, 0);
  } finally {
    await manager.dispose();
    await f.close();
  }
});
void test("failed full-file hash never exposes data or fetches a second full body on the invalid handle", async (t) => {
  const { f, manager, attachmentId, bytes } = await setup(),
    realFetch = globalThis.fetch;
  let gets = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file")) {
        gets++;
        return new Response(Buffer.alloc(bytes.length, 42), { status: 200 });
      }
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginRead({
      target: { kind: "attachment", attachmentId },
    });
    await assert.rejects(
      manager.readChunk({ handle: h.handle, offset: 0, length: 4 }),
      (error) =>
        error instanceof ApiError && error.code === "FILE_HASH_MISMATCH",
    );
    await assert.rejects(
      manager.readChunk({ handle: h.handle, offset: 0, length: 4 }),
    );
    assert.equal(gets, 1);
  } finally {
    await manager.dispose();
    await f.close();
  }
});

void test("rejected response cleanup keeps capacity until a held reader cancellation settles", async (t) => {
  const { f, manager, arena, attachmentId } = await setup(),
    realFetch = globalThis.fetch;
  let opened: (() => void) | undefined, release: (() => void) | undefined;
  const entered = new Promise<void>((r) => {
      opened = r;
    }),
    closed = new Promise<void>((r) => {
      release = r;
    });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file"))
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            async cancel() {
              opened?.();
              await closed;
            },
          }),
          { status: 206, headers: { "content-range": "bytes 99-100/16" } },
        );
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginRead({
        target: { kind: "attachment", attachmentId },
      }),
      pending = manager
        .readChunk({ handle: h.handle, offset: 0, length: 2 })
        .catch((error: unknown) => error);
    await entered;
    assert.equal(arena.stats().liveHandles, 1);
    const canceled = await manager.cancel(h.handle, "download");
    assert.equal(canceled.cleanupPending, true);
    assert.equal(arena.stats().liveHandles, 1);
    assert.ok(release);
    release();
    assert.ok((await pending) instanceof Error);
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().reservedRawBytes, 0);
  } finally {
    release?.();
    await manager.dispose();
    await f.close();
  }
});
void test("cancel during full fallback read exposes no bytes and retains its buffer reservation until ignored abort settles", async (t) => {
  const { f, manager, arena, attachmentId, bytes } = await setup(),
    realFetch = globalThis.fetch;
  let opened: (() => void) | undefined,
    release: (() => void) | undefined,
    sent = false;
  const entered = new Promise<void>((r) => {
      opened = r;
    }),
    body = new Promise<void>((r) => {
      release = r;
    });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "GET" && url.pathname.endsWith("/file"))
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (sent) {
                controller.close();
                return;
              }
              sent = true;
              opened?.();
              await body;
              controller.enqueue(bytes);
            },
          }),
          { status: 200 },
        );
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginRead({
        target: { kind: "attachment", attachmentId },
      }),
      pending = manager
        .readChunk({ handle: h.handle, offset: 0, length: 2 })
        .catch((error: unknown) => error);
    await entered;
    const canceled = await manager.cancel(h.handle, "download");
    assert.equal(canceled.cleanupPending, true);
    assert.equal(arena.stats().liveHandles, 1);
    assert.ok(arena.stats().reservedRawBytes > 0);
    assert.ok(release);
    release();
    assert.ok((await pending) instanceof Error);
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().reservedRawBytes, 0);
  } finally {
    release?.();
    await manager.dispose();
    await f.close();
  }
});
