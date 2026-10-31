import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
import { sessionOwner as owner } from "./session-fixture.js";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const error = z.object({
  status: z.number(),
  outcome: z.literal("uncertain"),
  retry: z.literal("same_key_same_payload"),
  retryable: z.literal(true),
  retryKeyFields: z.array(z.string()),
  readback: z.literal("sticker_list_file_transfers"),
});
function decode(value: unknown) {
  const envelope = z
    .object({ content: z.array(z.object({ text: z.string() })) })
    .parse(value);
  return JSON.parse(envelope.content[0].text) as unknown;
}
async function staged(f: Awaited<ReturnType<typeof ordinaryMcpFixture>>) {
  const bytes = Buffer.from("committed recovery"),
    operationId = randomUUID(),
    checksum = sha(bytes),
    h = await f.ok(
      "agent",
      "sticker_begin_upload",
      {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        operationId,
        name: "recovery.bin",
        size: bytes.length,
        checksum,
      },
      z.object({ handle: z.uuid() }),
    );
  await f.ok(
    "agent",
    "sticker_write_upload_chunk",
    { handle: h.handle, offset: 0, base64: bytes.toString("base64"), checksum },
    z.unknown(),
  );
  return { finish: { handle: h.handle, operationId, checksum }, bytes };
}
void test("committed but mismatched compact success preserves exact original-key recovery without automatic resend", async (t) => {
  const f = await ordinaryMcpFixture(),
    realFetch = globalThis.fetch;
  let override = true,
    posts = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const response = await realFetch(input, init);
      if (init?.method === "POST" && url.pathname.endsWith("/attachments")) {
        posts++;
        if (override) {
          const raw = z
            .record(z.string(), z.unknown())
            .parse(await response.json());
          return Response.json(
            { ...raw, checksum: "0".repeat(64) },
            { status: 201 },
          );
        }
      }
      return response;
    },
  );
  try {
    const { finish, bytes } = await staged(f),
      client = f.clients.find((c) => c.who === "agent")?.client;
    assert.ok(client);
    const result = await client.callTool({
      name: "sticker_finish_upload",
      arguments: finish,
    });
    assert.equal(result.isError, true);
    const failure = error.parse(decode(result));
    assert.equal(failure.status, 502);
    assert.deepEqual(failure.retryKeyFields, ["operationId"]);
    assert.equal(posts, 1);
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      1,
    );
    await f.ok(
      "agent",
      "sticker_get_attachment_operation",
      {
        projectId: f.project.id,
        issueId: f.issue.id,
        operationId: finish.operationId,
        name: "recovery.bin",
        size: bytes.length,
        checksum: sha(bytes),
      },
      z.object({ recorded: z.literal(true) }),
    );
    override = false;
    await f.ok(
      "agent",
      "sticker_finish_upload",
      finish,
      z.object({ historicalCommitted: z.literal(true) }),
    );
    assert.equal(posts, 2);
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      1,
    );
    assert.equal(
      f.instance.store
        .getIssue(owner, f.issue.id)
        .activity.filter((a) => a.action === "attachment_added").length,
      1,
    );
  } finally {
    await f.close();
  }
});
void test("cancel during held committed-response decoding keeps unknown commit guidance and ownership until decode settles", async (t) => {
  const f = await ordinaryMcpFixture(),
    realFetch = globalThis.fetch;
  let entered: (() => void) | undefined, release: (() => void) | undefined;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    settled = new Promise<void>((r) => {
      release = r;
    });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const response = await realFetch(input, init);
      if (init?.method === "POST" && url.pathname.endsWith("/attachments")) {
        const raw: unknown = await response.json();
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (sent) {
                controller.close();
                return;
              }
              sent = true;
              entered?.();
              await settled;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(raw)));
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return response;
    },
  );
  try {
    const { finish } = await staged(f),
      client = f.clients.find((c) => c.who === "agent")?.client;
    assert.ok(client);
    const pending = client.callTool({
      name: "sticker_finish_upload",
      arguments: finish,
    });
    await reached;
    assert.equal(
      f.instance.store.getIssue(owner, f.issue.id).attachments.length,
      1,
    );
    await f.ok(
      "agent",
      "sticker_cancel_upload",
      { handle: finish.handle },
      z.object({
        cleanupPending: z.literal(true),
        commit: z.literal("uncertain"),
      }),
    );
    assert.ok(release);
    release();
    const result = await pending;
    assert.equal(result.isError, true);
    const failure = error.parse(decode(result));
    assert.deepEqual(failure.retryKeyFields, ["operationId"]);
  } finally {
    release?.();
    await f.close();
  }
});

void test("completed handle returns historical commit with refreshed current file presence after deletion", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const { finish } = await staged(f),
      first = await f.ok(
        "agent",
        "sticker_finish_upload",
        finish,
        z.object({ attachmentId: z.uuid(), currentPresent: z.literal(true) }),
      );
    await f.ok(
      "owner",
      "sticker_delete_attachment",
      { attachmentId: first.attachmentId },
      z.unknown(),
    );
    await f.ok(
      "agent",
      "sticker_finish_upload",
      finish,
      z.object({
        attachmentId: z.literal(first.attachmentId),
        historicalCommitted: z.literal(true),
        currentPresent: z.literal(false),
      }),
    );
  } finally {
    await f.close();
  }
});
