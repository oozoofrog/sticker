import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
void test("status probes authenticate first, validate maintenance503 narrowly, and reject unsupported logout modes before DELETE", async () => {
  const requests: string[] = [];
  let actorValid = true,
    status = 503,
    body: unknown = { status: "maintenance" };
  const http = createServer((req, res) => {
    requests.push(`${req.method ?? ""} ${req.url ?? ""}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/session") {
      res.statusCode = actorValid ? 200 : 401;
      res.end(
        JSON.stringify(
          actorValid
            ? {
                actor: {
                  id: "agent",
                  name: "synthetic",
                  role: "agent",
                  canWrite: true,
                  projectIds: [],
                },
              }
            : { code: "UNAUTHORIZED", error: "authentication required" },
        ),
      );
    } else {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    }
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${String(address.port)}`;
  const { createStickerTransport } = await import("../server/mcp/transport.js");
  const transport = createStickerTransport({
    apiUrl,
    auth: { mode: "agent", token: "synthetic-status-probe-token" },
  });
  try {
    assert.deepEqual(await transport.probeStatus("readiness"), {
      status: "maintenance",
    });
    for (const malformed of [
      { status: "maintenance", secret: "unexpected" },
      { status: "ready" },
      { error: "unavailable" },
      null,
    ]) {
      body = malformed;
      await assert.rejects(transport.probeStatus("readiness"));
    }
    status = 200;
    body = { status: "maintenance" };
    await assert.rejects(transport.probeStatus("readiness"));
    actorValid = false;
    requests.length = 0;
    await assert.rejects(transport.probeStatus("health"));
    assert.deepEqual(requests, ["GET /api/session"]);
    for (const auth of [
      { mode: "agent" as const, token: "synthetic-status-probe-token" },
      { mode: "trusted-local-owner" as const },
    ]) {
      const server = createStickerMcp({ apiUrl, auth }),
        client = new Client({ name: "logout-guard", version: "1" }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      requests.length = 0;
      try {
        const result = await client.callTool({
          name: "sticker_end_owner_session",
          arguments: { confirm: true },
        });
        assert.equal(result.isError, true);
        assert.deepEqual(requests, []);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    http.closeAllConnections();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
  }
});
