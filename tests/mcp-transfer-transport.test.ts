import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { trackedMultipart } from "../server/mcp/multipart-body.js";
import { createStickerTransport, ApiError } from "../server/mcp/transport.js";
void test("transfer request options send exact numeric Range and combine explicit cancellation without changing legacy callers", async () => {
  let range: string | undefined;
  const http = createServer((req, res) => {
    range = req.headers.range;
    res.end("12345");
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const a = http.address();
  assert.ok(a && typeof a !== "string");
  try {
    const transport = createStickerTransport({
      apiUrl: `http://127.0.0.1:${String(a.port)}`,
      auth: { mode: "agent", token: "synthetic-transfer-range-token" },
    });
    // The fourth argument is a narrow internal transport option, never a model header/path input.
    const response = await transport.request("/api/file", "GET", undefined, {
      range: { start: 2, end: 6 },
    });
    assert.equal(await response.text(), "12345");
    assert.equal(range, "bytes=2-6");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      transport.request("/api/file", "GET", undefined, {
        signal: abort.signal,
      }),
    );
  } finally {
    http.closeAllConnections();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
  }
});
void test("bounded transfer JSON cancels oversized success/error bodies before collecting the full response", async (t) => {
  let delivered = 0,
    canceled = 0,
    status = 200;
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            delivered++;
            if (delivered > 20) controller.close();
            else controller.enqueue(new Uint8Array(32768).fill(32));
          },
          cancel() {
            canceled++;
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  const transport = createStickerTransport({
    apiUrl: "http://127.0.0.1:9",
    auth: { mode: "agent", token: "synthetic-transfer-json-token" },
  });
  for (status of [200, 503]) {
    delivered = 0;
    canceled = 0;
    await assert.rejects(
      transport.json("/api/transfer", "GET", undefined, { jsonLimit: 128 }),
      (error) =>
        error instanceof ApiError &&
        error.status === (status === 200 ? 502 : 503),
    );
    assert.equal(canceled, 1);
    assert.ok(delivered <= 4);
  }
});
void test("cancel during held owner credential acquisition sends no request after provider settles", async (t) => {
  let release: ((session: string) => void) | undefined,
    requests = 0;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    requests++;
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    return Promise.resolve(
      Response.json(
        url.pathname === "/api/access-mode"
          ? { mode: "password" }
          : url.pathname === "/api/session"
            ? {
                actor: {
                  id: "owner",
                  name: "synthetic",
                  role: "owner",
                  canWrite: true,
                  projectIds: null,
                },
              }
            : { ok: true },
      ),
    );
  });
  const transport = createStickerTransport({
      apiUrl: "http://127.0.0.1:9",
      auth: { mode: "owner-session", sessionProvider: () => pending },
    }),
    abort = new AbortController();
  const request = transport.request(
    "/api/transfer",
    "POST",
    { safe: true },
    { signal: abort.signal },
  );
  abort.abort();
  assert.ok(release);
  release("a".repeat(43));
  await assert.rejects(request);
  assert.equal(requests, 0);
});

void test("dispatch ownership hook excludes owner-auth preflight requests", async (t) => {
  let dispatched = 0;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    return Promise.resolve(
      Response.json(
        url.pathname === "/api/access-mode"
          ? { mode: "password" }
          : url.pathname === "/api/session"
            ? {
                actor: {
                  id: "owner",
                  name: "synthetic",
                  role: "owner",
                  canWrite: true,
                  projectIds: null,
                },
              }
            : { ok: true },
      ),
    );
  });
  const transport = createStickerTransport({
    apiUrl: "http://127.0.0.1:9",
    auth: { mode: "owner-session", sessionProvider: () => "a".repeat(43) },
  });
  await transport.json(
    "/api/transfer",
    "POST",
    { safe: true },
    {
      onDispatch: () => {
        dispatched++;
      },
    },
  );
  assert.equal(dispatched, 1);
});

void test("tracked multipart owns and settles its serialized stream even when upstream answers before consuming it", async (t) => {
  let body: ReadableStream<Uint8Array> | undefined;
  t.mock.method(globalThis, "fetch", (_input: unknown, init?: RequestInit) => {
    assert.ok(init?.body instanceof ReadableStream);
    body = init.body as ReadableStream<Uint8Array>;
    assert.match(
      new Headers(init.headers).get("content-type") ?? "",
      /^multipart\/form-data; boundary=/,
    );
    return Promise.resolve(Response.json({ accepted: true }, { status: 202 }));
  });
  const transport = createStickerTransport({
      apiUrl: "http://127.0.0.1:9",
      auth: { mode: "agent", token: "synthetic-tracked-body-token" },
    }),
    form = new FormData();
  form.append("file", new Blob([Buffer.alloc(1024 * 1024)]), "synthetic.bin");
  await transport.json("/api/transfer", "POST", form, { trackFormData: true });
  assert.ok(body);
  const reader = body.getReader();
  await assert.rejects(reader.read());
  reader.releaseLock();
});

void test("bounded actor decoding accepts the actual maximum escaped scope and rejects oversized identity grants", async (t) => {
  let actor = {
    id: "a".repeat(80),
    name: "이".repeat(80),
    role: "agent",
    canWrite: true,
    projectIds: Array.from({ length: 1000 }, () => "\0".repeat(100)),
  };
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ actor })),
  );
  const transport = createStickerTransport({
    apiUrl: "http://127.0.0.1:9",
    auth: { mode: "agent", token: "synthetic-bounded-actor-token" },
  });
  assert.ok(Buffer.byteLength(JSON.stringify({ actor })) > 256 * 1024);
  assert.equal((await transport.verifiedActor({})).projectIds?.length, 1000);
  actor = { ...actor, id: "a".repeat(81) };
  await assert.rejects(
    transport.verifiedActor({}),
    (error) => error instanceof ApiError && error.status === 502,
  );
});

void test("multipart disposal immediately blocks output but waits for a held encoder to drain without canceling it", async (t) => {
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let canceled = 0,
    chunks = 0,
    fullyDrained = false;
  const encoded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunks === 0) {
        entered?.();
        await held;
      }
      if (canceled) return;
      if (chunks++ < 3) controller.enqueue(new Uint8Array(65536));
      else {
        fullyDrained = true;
        controller.close();
      }
    },
    cancel() {
      canceled++;
    },
  });
  t.mock.getter(Request.prototype, "body", () => encoded);
  const form = new FormData();
  form.append("file", new Blob(["small"]), "synthetic.bin");
  const multipart = trackedMultipart(form);
  let disposed = false;
  try {
    await started;
    const disposing = multipart.dispose().then(() => {
      disposed = true;
    });
    const output = multipart.body.getReader();
    await assert.rejects(output.read(), /ownership released/);
    output.releaseLock();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      canceled,
      0,
      "native encoder cancellation races pending async enqueue in Node24",
    );
    assert.equal(disposed, false);
    assert.equal(fullyDrained, false);
    assert.ok(release);
    release();
    await disposing;
    assert.equal(fullyDrained, true);
    assert.equal(chunks, 4);
    assert.equal(canceled, 0);
  } finally {
    release?.();
    await multipart.dispose();
  }
});

void test("multipart disposal propagates an encoder read failure after ownership settles", async (t) => {
  const failure = new Error("synthetic encoder read failed");
  const encoded = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure);
    },
  });
  t.mock.getter(Request.prototype, "body", () => encoded);
  const form = new FormData();
  form.append("file", new Blob(["small"]), "synthetic.bin");
  const multipart = trackedMultipart(form);
  await assert.rejects(multipart.dispose(), (error) => error === failure);
  await multipart.settled;
});
