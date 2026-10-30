import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture } from "./session-fixture.js";
import { z } from "zod";
const envelope = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
void test("MCP maintenance response retains bounded recovery metadata without replaying a mutation", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "maintenance-fixture", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const state = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("begin", {
      instanceId: state.instanceId,
      revision: state.revision,
      confirm: true,
    });
    const response = envelope.parse(
      await client.callTool({
        name: "sticker_create_issue",
        arguments: {
          projectId: f.project.id,
          title: "must not be silently retried",
        },
      }),
    );
    assert.equal(response.isError, true);
    const error = z
      .object({
        code: z.literal("MAINTENANCE"),
        status: z.literal(503),
        retryAfterSeconds: z.literal(5),
        maintenance: z.object({
          instanceId: z.string(),
          state: z.literal("draining"),
        }),
      })
      .parse(JSON.parse(response.content[0].text));
    assert.equal(error.maintenance.instanceId, state.instanceId);
    const drained = f.instance.maintenance.snapshot();
    f.instance.maintenance.change("resume", {
      instanceId: drained.instanceId,
      revision: drained.revision,
      confirm: true,
    });
    const result = envelope.parse(
      await client.callTool({
        name: "sticker_list_issues",
        arguments: { projectId: f.project.id },
      }),
    );
    assert.notEqual(result.isError, true);
    assert.ok(!result.content[0].text.includes("must not be silently retried"));
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

void test("invalid maintenance metadata cannot leak token or erase an otherwise valid 503 error", async () => {
  const { createServer } = await import("node:http");
  const token = "00000000-0000-4000-8000-000000000001";
  for (const startedAt of [
    token,
    "x".repeat(10000),
    "2026-10-30T00:00:00.000Z",
  ]) {
    const http = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "maintenance",
          code: "MAINTENANCE",
          retryAfterSeconds: 5,
          maintenance: {
            contractVersion: 1,
            instanceId: token,
            revision: 0,
            state: "draining",
            drained: true,
            startedAt,
          },
        }),
      );
    });
    http.listen(0, "127.0.0.1");
    await new Promise<void>((r) => http.once("listening", r));
    const addr = http.address();
    assert.ok(addr && typeof addr !== "string");
    const server = createStickerMcp(
        `http://127.0.0.1:${String(addr.port)}`,
        token,
      ),
      client = new Client({ name: "malformed-fixture", version: "1" }),
      [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const response = envelope.parse(
        await client.callTool({ name: "sticker_list_projects", arguments: {} }),
      );
      assert.equal(response.isError, true);
      assert.ok(!response.content[0].text.includes(token));
      const result = z
        .object({
          code: z.literal("MAINTENANCE"),
          status: z.literal(503),
          maintenance: z.undefined().optional(),
        })
        .parse(JSON.parse(response.content[0].text));
      assert.equal(result.status, 503);
    } finally {
      await client.close();
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((r) =>
        http.close(() => {
          r();
        }),
      );
    }
  }
});
