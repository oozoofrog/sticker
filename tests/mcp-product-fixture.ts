import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { Store } from "../server/domain.js";
import { createApp } from "../server/app.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionOwner as owner } from "./session-fixture.js";
export async function ordinaryMcpFixture(
  ownerMode: "owner-session" | "trusted-local-owner" = "owner-session",
) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-ordinary-"));
  const clientDir = join(dir, "synthetic-client");
  mkdirSync(clientDir);
  writeFileSync(
    join(clientDir, "index.html"),
    "<!doctype html><html><body>synthetic MCP fixture</body></html>",
  );
  const http = createServer((req, res) => {
    instance.app(req, res);
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${String(address.port)}`;
  const tokens = {
    agent: "synthetic-ordinary-agent-token",
    other: "synthetic-ordinary-other-token",
    read: "synthetic-ordinary-reader-token",
  };
  const seed = new Store(dir),
    project = seed.createProject(owner, { key: "MP", name: "ordinary" }),
    foreignProject = seed.createProject(owner, { key: "MQ", name: "foreign" }),
    foreignIssue = seed.createIssue(owner, {
      projectId: foreignProject.id,
      title: "private",
    });
  seed.close();
  const instance = createApp({
    dataDir: dir,
    clientDir,
    appOrigin: apiUrl,
    ownerPassword: "synthetic-ordinary-owner-password",
    localOwnerMode:
      ownerMode === "trusted-local-owner" ? "trusted-loopback" : undefined,
    agents: Object.entries(tokens).map(([id, token]) => ({
      id,
      name: id,
      canWrite: id !== "read",
      projectIds: [project.id],
      tokenHash: createHash("sha256").update(token).digest("hex"),
    })),
  });
  const issue = instance.store.createIssue(owner, {
    projectId: project.id,
    title: "original",
  });
  let session: string | undefined;
  if (ownerMode === "owner-session") {
    const login = await fetch(`${apiUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "synthetic-ordinary-owner-password" }),
    });
    session = login.headers.get("set-cookie")?.split(";")[0].slice(16);
    assert.ok(session);
  }
  const clients = await Promise.all(
    ["owner", "agent", "other", "read"].map(async (who) => {
      const server =
        who === "owner"
          ? createStickerMcp({
              apiUrl,
              auth:
                ownerMode === "trusted-local-owner"
                  ? { mode: "trusted-local-owner" }
                  : {
                      mode: "owner-session",
                      sessionProvider: () => {
                        assert.ok(session);
                        return session;
                      },
                    },
            })
          : createStickerMcp(apiUrl, tokens[who as keyof typeof tokens]);
      const client = new Client({ name: `ordinary-${who}`, version: "1" }),
        [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      await client.connect(b);
      return { who, server, client };
    }),
  );
  async function invoke(
    who: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const client = clients.find((c) => c.who === who)?.client;
    assert.ok(client);
    return client.callTool({ name, arguments: args });
  }
  async function ok<T>(
    who: string,
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ) {
    const result = await invoke(who, name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const envelope = z
      .object({
        content: z.array(
          z.object({ type: z.literal("text"), text: z.string() }),
        ),
      })
      .parse(result);
    return schema.parse(JSON.parse(envelope.content[0].text));
  }
  async function denied(
    who: string,
    name: string,
    args: Record<string, unknown>,
    status?: number,
  ) {
    const result = await invoke(who, name, args);
    assert.equal(result.isError, true);
    if (status !== undefined) {
      const envelope = z
        .object({ content: z.array(z.object({ text: z.string() })) })
        .parse(result);
      assert.equal(
        z
          .object({ status: z.number() })
          .parse(JSON.parse(envelope.content[0].text)).status,
        status,
      );
    }
  }
  return {
    instance,
    project,
    foreignProject,
    foreignIssue,
    issue,
    clients,
    apiUrl,
    tokens,
    ok,
    denied,
    async close() {
      for (const p of clients) {
        await p.client.close();
        await p.server.close();
      }
      http.closeAllConnections();
      await new Promise<void>((r) =>
        http.close(() => {
          r();
        }),
      );
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
