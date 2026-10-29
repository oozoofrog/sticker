import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { Store } from "../server/domain.js";
import { sessionOwner } from "./session-fixture.js";
import { requiredHeader } from "./helpers.js";

export const mcpSettingsPassword = "disposable-mcp-settings-owner-password";
export async function mcpSettingsFixture(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-settings-"));
  const seed = new Store(dir);
  const project = seed.createProject(sessionOwner, {
    key: "MCP",
    name: "읽기 범위",
  });
  const other = seed.createProject(sessionOwner, {
    key: "OUT",
    name: "범위 밖",
  });
  const issue = seed.createIssue(sessionOwner, {
    projectId: project.id,
    title: "MCP 읽기 검증",
  });
  seed.close();
  const tokens = {
    read: "disposable-mcp-settings-read-token",
    write: "disposable-mcp-settings-write-token",
    all: "disposable-mcp-settings-all-token",
    none: "disposable-mcp-settings-none-token",
    missing: "disposable-mcp-settings-missing-token",
  };
  const agents = configured
    ? Object.entries(tokens).map(([id, token]) => ({
        id,
        name: `설정 ${id}`,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        canWrite: ["write", "all"].includes(id),
        projectIds:
          id === "all"
            ? null
            : id === "none"
              ? []
              : id === "missing"
                ? ["deleted-project-id"]
                : [project.id],
      }))
    : [];
  const instance = createApp({
    dataDir: dir,
    ownerPassword: mcpSettingsPassword,
    appOrigin: "http://localhost:8787",
    agents,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing settings fixture address");
  const base = `http://127.0.0.1:${String(address.port)}`;
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: mcpSettingsPassword }),
  });
  const cookie = requiredHeader(login, "set-cookie").split(";")[0];
  return {
    instance,
    project,
    other,
    issue,
    tokens,
    agents,
    base,
    cookie,
    request(
      path: string,
      who: keyof typeof tokens | "owner" | "anonymous" = "owner",
      method = "GET",
    ) {
      return fetch(`${base}/api${path}`, {
        method,
        headers:
          who === "owner"
            ? { cookie, origin: "http://localhost:8787" }
            : who === "anonymous"
              ? {}
              : { authorization: `Bearer ${tokens[who]}` },
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
