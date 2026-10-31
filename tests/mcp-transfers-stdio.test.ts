import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
import { sessionOwner as owner } from "./session-fixture.js";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const envelope = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
async function connect(base: string, token: string) {
  const entry = fileURLToPath(
    new URL(
      `./mcp-transfer-process.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
      import.meta.url,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry.endsWith(".js") ? [entry] : ["--import", "tsx", entry],
    env: {
      PATH: process.env.PATH ?? "",
      STICKER_API_URL: base,
      STICKER_AGENT_TOKEN: token,
    },
    stderr: "pipe",
  });
  let maxRequest = 0,
    maxResponse = 0,
    stderr = "";
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    maxRequest = Math.max(
      maxRequest,
      Buffer.byteLength(JSON.stringify(message)) + 1,
    );
    await send(message);
  };
  transport.stderr?.on("data", (bytes: Buffer) => {
    if (stderr.length < 65536) stderr += bytes.toString();
  });
  const client = new Client({ name: "full-file-stdio", version: "1" });
  await client.connect(transport);
  const onmessage = transport.onmessage;
  transport.onmessage = (message) => {
    maxResponse = Math.max(
      maxResponse,
      Buffer.byteLength(JSON.stringify(message)) + 1,
    );
    onmessage?.(message);
  };
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(
      result.isError,
      true,
      JSON.stringify(result).slice(0, 1024),
    );
    return JSON.parse(envelope.parse(result).content[0].text) as unknown;
  }
  return {
    call,
    async close() {
      await client.close();
      const line = stderr
        .split("\n")
        .find((line) => line.startsWith("STICKER_TRANSFER_MEMORY "));
      assert.ok(line, "adapter memory sampler completed");
      const memory = z
        .object({
          node: z.string(),
          platform: z.string(),
          peak: z.object({
            rss: z.number(),
            heapUsed: z.number(),
            external: z.number(),
            arrayBuffers: z.number(),
          }),
          arena: z.object({
            liveHandles: z.number(),
            reservedRawBytes: z.number(),
            ownedHighWaterBytes: z.number(),
            completedReceipts: z.number(),
          }),
        })
        .parse(JSON.parse(line.slice("STICKER_TRANSFER_MEMORY ".length)));
      return { maxRequest, maxResponse, memory };
    },
  };
}
void test(
  "fresh default-buffer STDIO handles320 chunks per20MiB target, restarts exact replay, immutable downloads and bounded envelopes",
  { timeout: 120000 },
  async (t) => {
    assert.equal(STDIO_DEFAULT_MAX_BUFFER_SIZE, 10 * 1024 * 1024);
    const f = await ordinaryMcpFixture(
      "owner-session",
      process.env.STICKER_LARGE_TEST_ROOT ??
        resolve("test-results/task4-large"),
    );
    const bytes = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const checksum = digest(bytes),
      other = Buffer.from(bytes);
    other[0] = 255;
    const otherHash = digest(other);
    const samples: unknown[] = [];
    const first = await connect(f.apiUrl, f.tokens.agent);
    let firstClosed = false,
      second: Awaited<ReturnType<typeof connect>> | undefined,
      secondClosed = false;
    const handle = z.object({ handle: z.uuid() }),
      receipt = z.object({
        kind: z.enum(["attachment", "resource"]),
        checksum: z.string(),
        attachmentId: z.uuid().optional(),
        resourceId: z.uuid().optional(),
        resourceVersion: z.number().optional(),
        revision: z.number().optional(),
      });
    async function send(
      client: Awaited<ReturnType<typeof connect>>,
      input: Record<string, unknown>,
      data: Buffer<ArrayBuffer>,
      expectedHash: string,
    ) {
      const h = handle.parse(
        await client.call("sticker_begin_upload", {
          ...input,
          size: data.length,
          checksum: expectedHash,
          name: "twenty.bin",
        }),
      );
      let chunks = 0;
      for (let offset = 0; offset < data.length; offset += 65536) {
        const chunk = data.subarray(offset, offset + 65536);
        await client.call("sticker_write_upload_chunk", {
          handle: h.handle,
          offset,
          base64: chunk.toString("base64"),
          checksum: digest(chunk),
        });
        chunks++;
      }
      assert.equal(chunks, 320);
      return receipt.parse(
        await client.call("sticker_finish_upload", {
          handle: h.handle,
          operationId: input.operationId,
          checksum: expectedHash,
        }),
      );
    }
    async function download(
      client: Awaited<ReturnType<typeof connect>>,
      target: Record<string, unknown>,
      expectedHash: string,
    ) {
      const h = handle.parse(
          await client.call("sticker_begin_file_read", { target }),
        ),
        hash = createHash("sha256");
      let chunks = 0;
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const part = z
          .object({
            base64: z.string(),
            checksum: z.string(),
            length: z.number(),
          })
          .parse(
            await client.call("sticker_read_file_chunk", {
              handle: h.handle,
              offset,
              length: 65536,
            }),
          );
        const raw = Buffer.from(part.base64, "base64");
        assert.equal(raw.length, 65536);
        assert.equal(part.checksum, digest(raw));
        hash.update(raw);
        chunks++;
      }
      assert.equal(chunks, 320);
      assert.equal(hash.digest("hex"), expectedHash);
      await client.call("sticker_cancel_file_read", { handle: h.handle });
    }
    try {
      const issueInput = {
          target: { kind: "issue_attachment", issueId: f.issue.id },
          operationId: randomUUID(),
        },
        issue = await send(first, issueInput, bytes, checksum);
      assert.ok(issue.attachmentId);
      await download(
        first,
        { kind: "attachment", attachmentId: issue.attachmentId },
        checksum,
      );
      const resourceInput = {
          target: {
            kind: "resource_file",
            projectId: f.project.id,
            title: "large",
          },
          operationId: randomUUID(),
        },
        resource = await send(first, resourceInput, bytes, checksum);
      assert.ok(resource.resourceId);
      assert.equal(resource.resourceVersion, 1);
      await download(
        first,
        {
          kind: "resource",
          resourceId: resource.resourceId,
          resourceVersion: 1,
        },
        checksum,
      );
      const replacementInput = {
          target: {
            kind: "resource_file_replacement",
            resourceId: resource.resourceId,
            revision: resource.revision,
          },
          operationId: randomUUID(),
        },
        replacement = await send(first, replacementInput, other, otherHash);
      assert.equal(replacement.resourceVersion, 2);
      await download(
        first,
        {
          kind: "resource",
          resourceId: resource.resourceId,
          resourceVersion: 2,
        },
        otherHash,
      );
      // Intentionally leave one local handle: actual CLI EOF must dispose it, not merely rely on OS reclamation.
      await first.call("sticker_begin_upload", {
        ...issueInput,
        operationId: randomUUID(),
        size: 0,
        checksum: digest(Buffer.alloc(0)),
        name: "unfinished.bin",
      });
      samples.push(await first.close());
      firstClosed = true;
      second = await connect(f.apiUrl, f.tokens.agent);
      assert.equal(
        (await send(second, issueInput, bytes, checksum)).attachmentId,
        issue.attachmentId,
      );
      assert.equal(
        (await send(second, resourceInput, bytes, checksum)).resourceId,
        resource.resourceId,
      );
      assert.equal(
        (await send(second, replacementInput, other, otherHash))
          .resourceVersion,
        2,
      );
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
      const detail = f.instance.store.resources.get(owner, resource.resourceId);
      assert.equal(detail.history.length, 2);
      f.instance.store.resources.remove(owner, resource.resourceId, {
        revision: detail.resource.revision,
        operationId: randomUUID(),
      });
      await download(
        second,
        {
          kind: "resource",
          resourceId: resource.resourceId,
          resourceVersion: 1,
        },
        checksum,
      );
      samples.push(await second.close());
      secondClosed = true;
      for (const value of samples) {
        const sample = z
          .object({
            maxRequest: z.number(),
            maxResponse: z.number(),
            memory: z.object({
              arena: z.object({
                liveHandles: z.literal(0),
                reservedRawBytes: z.literal(0),
                completedReceipts: z.literal(0),
                ownedHighWaterBytes: z.number(),
              }),
            }),
          })
          .parse(value);
        assert.ok(sample.maxRequest < 128 * 1024);
        assert.ok(sample.maxResponse < 128 * 1024);
        assert.ok(sample.memory.arena.ownedHighWaterBytes <= 80 * 1024 * 1024);
      }
      t.diagnostic(
        JSON.stringify({
          rawBytes: bytes.length,
          rawChunkBytes: 65536,
          chunksPerFile: 320,
          defaultSdkBuffer: STDIO_DEFAULT_MAX_BUFFER_SIZE,
          adapterProcesses: samples,
          testServerAndClientMemory: process.memoryUsage(),
        }),
      );
    } finally {
      if (!firstClosed) await first.close();
      if (second && !secondClosed) await second.close();
      await f.close();
    }
  },
);
