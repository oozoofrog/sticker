import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { TransferManager } from "../server/mcp/transfer-manager.js";
import {
  TransferArena,
  TRANSFER_OWNED_LIMIT,
} from "../server/mcp/transfer-arena.js";
import { createStickerTransport, ApiError } from "../server/mcp/transport.js";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const gate = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: () => {
      assert.ok(release);
      release();
    },
  };
};
async function setup() {
  const f = await ordinaryMcpFixture(),
    arena = new TransferArena(),
    transport = createStickerTransport({
      apiUrl: f.apiUrl,
      auth: { mode: "agent", token: f.tokens.agent },
    }),
    manager = new TransferManager(transport, { arena });
  return { f, arena, transport, manager };
}
async function receive(
  manager: TransferManager,
  issueId: string,
  bytes: Buffer<ArrayBuffer> = Buffer.from("owned bytes"),
) {
  const operationId = randomUUID(),
    checksum = hash(bytes),
    handle = await manager.beginUpload({
      target: { kind: "issue_attachment", issueId },
      name: "owned.bin",
      size: bytes.length,
      checksum,
      operationId,
    });
  if (bytes.length)
    await manager.writeChunk({
      handle: handle.handle,
      offset: 0,
      base64: bytes.toString("base64"),
      checksum,
    });
  return { handle: handle.handle, operationId, checksum };
}
void test("cancel holds capacity/allocation until an upload ignoring abort settles, then admits exactly once", async (t) => {
  const { f, arena, manager } = await setup(),
    realFetch = globalThis.fetch,
    entered = gate(),
    settle = gate();
  let held = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (
        held &&
        init?.method === "POST" &&
        url.pathname.endsWith("/attachments")
      ) {
        held = false;
        entered.open();
        await settle.promise;
      }
      return realFetch(input, init);
    },
  );
  try {
    const input = await receive(manager, f.issue.id),
      pending = manager.finishUpload(input).catch((error: unknown) => error);
    await entered.promise;
    const canceled = await manager.cancel(input.handle, "upload");
    assert.equal(canceled.cleanupPending, true);
    assert.equal(canceled.commit, "uncertain");
    assert.equal(arena.stats().liveHandles, 1);
    assert.ok(arena.stats().reservedRawBytes > 0);
    const second = await manager.beginUpload({
      target: { kind: "issue_attachment", issueId: f.issue.id },
      name: "pending.bin",
      size: 0,
      checksum: hash(Buffer.alloc(0)),
      operationId: randomUUID(),
    });
    await assert.rejects(
      manager.beginUpload({
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "third.bin",
        size: 0,
        checksum: hash(Buffer.alloc(0)),
        operationId: randomUUID(),
      }),
      (error) => error instanceof ApiError && error.status === 429,
    );
    await manager.cancel(second.handle, "upload");
    settle.open();
    assert.ok((await pending) instanceof Error);
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().reservedRawBytes, 0);
    assert.ok(arena.stats().ownedHighWaterBytes <= TRANSFER_OWNED_LIMIT);
    const next = await receive(manager, f.issue.id, Buffer.alloc(0));
    await manager.cancel(next.handle, "upload");
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});
void test("expiry and disposal retain held authorization ownership until the ignored-abort request settles", async (t) => {
  const f = await ordinaryMcpFixture(),
    arena = new TransferArena();
  let now = 0;
  const manager = new TransferManager(
      createStickerTransport({
        apiUrl: f.apiUrl,
        auth: { mode: "agent", token: f.tokens.agent },
      }),
      { arena, clock: () => now },
    ),
    realFetch = globalThis.fetch,
    entered = gate(),
    settle = gate();
  let held = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (held && url.pathname === "/api/session") {
        held = false;
        entered.open();
        await settle.promise;
      }
      return realFetch(input, init);
    },
  );
  try {
    const h = await manager.beginUpload({
      target: { kind: "issue_attachment", issueId: f.issue.id },
      name: "expire.bin",
      size: 1,
      checksum: hash(Buffer.from("x")),
      operationId: randomUUID(),
    });
    held = true;
    const writing = manager
      .writeChunk({
        handle: h.handle,
        offset: 0,
        base64: "eA==",
        checksum: hash(Buffer.from("x")),
      })
      .catch((error: unknown) => error);
    await entered.promise;
    now = 600001;
    const list = await manager.list();
    assert.equal(list[0]?.cleanupPending, true);
    assert.equal(arena.stats().liveHandles, 1);
    let disposed = false;
    const closing = manager.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    assert.equal(disposed, false);
    assert.equal(arena.stats().liveHandles, 1);
    settle.open();
    assert.ok((await writing) instanceof Error);
    await closing;
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().reservedRawBytes, 0);
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});
void test("single finalize lane bounds joiners, canceled queue does not dispatch, and same-key joined result commits once", async (t) => {
  const { f, manager, arena } = await setup(),
    realFetch = globalThis.fetch,
    entered = gate(),
    settle = gate();
  let posts = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "POST" && url.pathname.endsWith("/attachments")) {
        posts++;
        if (posts === 1) {
          entered.open();
          await settle.promise;
        }
      }
      return realFetch(input, init);
    },
  );
  try {
    const first = await receive(manager, f.issue.id),
      second = await receive(manager, f.issue.id),
      finishing = manager.finishUpload(first);
    await entered.promise;
    const joined = manager.finishUpload(first);
    await assert.rejects(
      manager.finishUpload(first),
      (error) => error instanceof ApiError && error.status === 429,
    );
    const queued = manager
      .finishUpload(second)
      .catch((error: unknown) => error);
    for (let i = 0; i < 2000 && !arena.stats().finalizeWaiting; i++)
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.equal(arena.stats().finalizeWaiting, true);
    await manager.cancel(second.handle, "upload");
    assert.ok((await queued) instanceof Error);
    assert.equal(posts, 1);
    settle.open();
    assert.deepEqual(await joined, await finishing);
    assert.equal(posts, 1);
    assert.equal(
      f.instance.store.getIssue(
        {
          id: "owner",
          name: "나",
          role: "owner",
          canWrite: true,
          projectIds: null,
        },
        f.issue.id,
      ).attachments.length,
      1,
    );
    assert.equal(arena.stats().liveHandles, 0);
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});

void test("disposal also waits for held authorization of an already-completed receipt", async (t) => {
  const { f, manager } = await setup(),
    realFetch = globalThis.fetch,
    entered = gate(),
    settle = gate();
  let hold = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (hold && url.pathname === "/api/session") {
        hold = false;
        entered.open();
        await settle.promise;
      }
      return realFetch(input, init);
    },
  );
  try {
    const input = await receive(manager, f.issue.id);
    await manager.finishUpload(input);
    hold = true;
    const repeat = manager.finishUpload(input).catch((error: unknown) => error);
    await entered.promise;
    let disposed = false;
    const closing = manager.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(disposed, false);
    settle.open();
    await repeat;
    await closing;
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});
void test("durable outcome tool respects the same owned-allocation budget before decoding authenticated JSON", async () => {
  const f = await ordinaryMcpFixture();
  const { processTransferArena } =
    await import("../server/mcp/transfer-arena.js");
  const release = processTransferArena.allocation(78 * 1024 * 1024);
  try {
    await f.denied(
      "agent",
      "sticker_get_attachment_operation",
      {
        projectId: f.project.id,
        issueId: f.issue.id,
        operationId: randomUUID(),
        name: "empty.bin",
        size: 0,
        checksum: hash(Buffer.alloc(0)),
      },
      429,
    );
  } finally {
    release();
    await f.close();
  }
});

void test("expiry held after final preparation is rechecked immediately before dispatch, leaving no attachment", async () => {
  const f = await ordinaryMcpFixture(),
    arena = new TransferArena(),
    transport = createStickerTransport({
      apiUrl: f.apiUrl,
      auth: { mode: "agent", token: f.tokens.agent },
    }),
    entered = gate(),
    settle = gate();
  let now = 0;
  const json = transport.json.bind(transport);
  transport.json = async (path, method, body, options) => {
    if (method === "POST" && body instanceof FormData) {
      entered.open();
      await settle.promise;
    }
    return json(path, method, body, options);
  };
  const manager = new TransferManager(transport, { arena, clock: () => now });
  try {
    const input = await receive(manager, f.issue.id),
      pending = manager.finishUpload(input).catch((error: unknown) => error);
    await entered.promise;
    now = 600001;
    settle.open();
    const failure = await pending;
    assert.ok(failure instanceof ApiError);
    assert.equal(failure.status, 410);
    assert.equal(
      f.instance.store.getIssue(
        {
          id: "owner",
          name: "나",
          role: "owner",
          canWrite: true,
          projectIds: null,
        },
        f.issue.id,
      ).attachments.length,
      0,
    );
    assert.equal(arena.stats().liveHandles, 0);
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});

void test(
  "two20MiB payloads plus held finalize/auth owners reach80MiB budget and reject further allocations",
  { timeout: 30000 },
  async (t) => {
    const { resolve } = await import("node:path"),
      f = await ordinaryMcpFixture(
        "owner-session",
        process.env.STICKER_LARGE_TEST_ROOT ??
          resolve("test-results/task4-large"),
      ),
      arena = new TransferArena(),
      manager = new TransferManager(
        createStickerTransport({
          apiUrl: f.apiUrl,
          auth: { mode: "agent", token: f.tokens.agent },
        }),
        { arena },
      ),
      bytes = Buffer.alloc(20 * 1024 * 1024, 37),
      checksum = hash(bytes),
      realFetch = globalThis.fetch,
      postReached = gate(),
      postRelease = gate(),
      authReached = gate(),
      authRelease = gate();
    let holdAuth = false,
      authCount = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (init?.method === "POST" && url.pathname.endsWith("/attachments")) {
          postReached.open();
          await postRelease.promise;
        }
        if (holdAuth && url.pathname === "/api/session") {
          authCount++;
          if (authCount === 2) authReached.open();
          await authRelease.promise;
        }
        return realFetch(input, init);
      },
    );
    try {
      async function full() {
        const operationId = randomUUID(),
          h = await manager.beginUpload({
            target: { kind: "issue_attachment", issueId: f.issue.id },
            operationId,
            name: "budget.bin",
            size: bytes.length,
            checksum,
          });
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const part = bytes.subarray(offset, offset + 65536);
          await manager.writeChunk({
            handle: h.handle,
            offset,
            base64: part.toString("base64"),
            checksum: hash(part),
          });
        }
        return { handle: h.handle, operationId, checksum };
      }
      const first = await full(),
        second = await full(),
        finishing = manager
          .finishUpload(first)
          .catch((error: unknown) => error);
      await postReached.promise;
      holdAuth = true;
      const canceling = manager.cancel(second.handle, "upload"),
        listing = manager.list();
      await authReached.promise;
      assert.equal(arena.stats().ownedAllocationBytes, 80 * 1024 * 1024);
      await assert.rejects(
        manager.list(),
        (error) => error instanceof ApiError && error.status === 429,
      );
      assert.equal(arena.stats().ownedHighWaterBytes, 80 * 1024 * 1024);
      holdAuth = false;
      authRelease.open();
      await canceling;
      await listing;
      assert.equal(
        (await manager.cancel(first.handle, "upload")).cleanupPending,
        true,
      );
      postRelease.open();
      assert.ok((await finishing) instanceof Error);
      assert.equal(arena.stats().liveHandles, 0);
      assert.equal(arena.stats().reservedRawBytes, 0);
      t.diagnostic(
        JSON.stringify({
          ownedLedger: arena.stats(),
          inProcessServerAndHarnessMemory: process.memoryUsage(),
        }),
      );
    } finally {
      holdAuth = false;
      authRelease.open();
      postRelease.open();
      await manager.dispose();
      await f.close();
    }
  },
);

void test("invalid chunks and identical replays do not renew TTL; successful progress still cannot exceed absolute30minutes", async () => {
  const f = await ordinaryMcpFixture(),
    arena = new TransferArena();
  let now = 0;
  const manager = new TransferManager(
    createStickerTransport({
      apiUrl: f.apiUrl,
      auth: { mode: "agent", token: f.tokens.agent },
    }),
    { arena, clock: () => now },
  );
  try {
    const input = {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "ttl.bin",
        size: 4,
        checksum: hash(Buffer.from("data")),
        operationId: randomUUID(),
      },
      h = await manager.beginUpload(input);
    await manager.writeChunk({
      handle: h.handle,
      offset: 0,
      base64: Buffer.from("d").toString("base64"),
      checksum: hash(Buffer.from("d")),
    });
    now = 599999;
    await manager.writeChunk({
      handle: h.handle,
      offset: 0,
      base64: Buffer.from("d").toString("base64"),
      checksum: hash(Buffer.from("d")),
    });
    await assert.rejects(
      manager.writeChunk({
        handle: h.handle,
        offset: 1,
        base64: "!!!!",
        checksum: "0".repeat(64),
      }),
    );
    now = 600001;
    assert.deepEqual(await manager.list(), []);
    assert.equal(arena.stats().liveHandles, 0);
    now = 0;
    const second = await manager.beginUpload({
      ...input,
      operationId: randomUUID(),
    });
    const bytes = Buffer.from("data");
    for (let i = 0; i < 3; i++) {
      now = (i + 1) * 500000;
      const chunk = bytes.subarray(i, i + 1);
      await manager.writeChunk({
        handle: second.handle,
        offset: i,
        base64: chunk.toString("base64"),
        checksum: hash(chunk),
      });
    }
    now = 1800001;
    await assert.rejects(
      manager.writeChunk({
        handle: second.handle,
        offset: 3,
        base64: bytes.subarray(3).toString("base64"),
        checksum: hash(bytes.subarray(3)),
      }),
    );
    assert.equal(arena.stats().liveHandles, 0);
  } finally {
    await manager.dispose();
    await f.close();
  }
});
void test("completed metadata remains globally bounded and oversized canonical chunk does not advance the cursor", async () => {
  const { f, manager, arena } = await setup();
  try {
    const input = {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "chunk.bin",
        size: 1,
        checksum: hash(Buffer.from("x")),
        operationId: randomUUID(),
      },
      h = await manager.beginUpload(input),
      oversized = Buffer.alloc(65538, 1);
    await assert.rejects(
      manager.writeChunk({
        handle: h.handle,
        offset: 0,
        base64: oversized.toString("base64"),
        checksum: hash(oversized),
      }),
      (error) => error instanceof ApiError && error.status === 400,
    );
    assert.equal(
      (
        await manager.writeChunk({
          handle: h.handle,
          offset: 0,
          base64: "eA==",
          checksum: hash(Buffer.from("x")),
        })
      ).offset,
      1,
    );
    await manager.cancel(h.handle, "upload");
    for (let i = 0; i < 40; i++) {
      const staged = await receive(manager, f.issue.id, Buffer.alloc(0));
      await manager.finishUpload(staged);
      assert.ok(arena.stats().completedReceipts <= 32);
    }
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().completedReceipts, 32);
    await manager.dispose();
    assert.equal(arena.stats().completedReceipts, 0);
  } finally {
    await manager.dispose();
    await f.close();
  }
});

void test("canceled finish keeps Blob budget and finalize lane until the held encoder drains after an early response", async (t) => {
  const { f, arena, manager } = await setup(),
    realFetch = globalThis.fetch,
    entered = gate(),
    answered = gate(),
    settle = gate();
  let chunks = 0,
    canceled = 0,
    ended = false;
  const encoded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunks === 0) {
        entered.open();
        await settle.promise;
      }
      if (canceled) return;
      if (chunks++ < 2) controller.enqueue(new Uint8Array(65536));
      else {
        ended = true;
        controller.close();
      }
    },
    cancel() {
      canceled++;
    },
  });
  const originalBody = Object.getOwnPropertyDescriptor(
    Request.prototype,
    "body",
  );
  t.mock.getter(Request.prototype, "body", function (this: Request) {
    if (this.url === "http://127.0.0.1/") return encoded;
    if (typeof originalBody?.get !== "function")
      throw new Error("Native Request body getter missing");
    return originalBody.get.call(this) as Request["body"];
  });
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (init?.method === "POST" && url.pathname.endsWith("/attachments")) {
        answered.open();
        return Promise.resolve(
          Response.json({ accepted: true }, { status: 202 }),
        );
      }
      return realFetch(input, init);
    },
  );
  try {
    const input = await receive(manager, f.issue.id),
      pending = manager.finishUpload(input).catch((error: unknown) => error);
    await entered.promise;
    await answered.promise;
    const cancel = await manager.cancel(input.handle, "upload");
    assert.equal(cancel.cleanupPending, true);
    assert.equal(cancel.commit, "uncertain");
    assert.equal(arena.stats().liveHandles, 1);
    assert.ok(arena.stats().reservedRawBytes > 0);
    assert.ok(arena.stats().ownedAllocationBytes > 2 * 1024 * 1024);
    assert.equal(arena.finalize.stats().active, true);
    let disposed = false;
    const closing = manager.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(ended, false);
    assert.equal(canceled, 0);
    settle.open();
    assert.ok((await pending) instanceof Error);
    await closing;
    assert.equal(ended, true);
    assert.equal(canceled, 0);
    assert.equal(arena.finalize.stats().active, false);
    assert.equal(arena.stats().liveHandles, 0);
    assert.equal(arena.stats().reservedRawBytes, 0);
    assert.equal(arena.stats().ownedAllocationBytes, 2 * 1024 * 1024);
    assert.equal(
      f.instance.store.getIssue(
        {
          id: "owner",
          name: "owner",
          role: "owner",
          canWrite: true,
          projectIds: null,
        },
        f.issue.id,
      ).attachments.length,
      0,
    );
  } finally {
    settle.open();
    await manager.dispose();
    await f.close();
  }
});
