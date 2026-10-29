import type { GithubProvider } from "../server/features/github.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/domain.js";
import { createApp } from "../server/app.js";
import type { Actor } from "../server/types.js";
import { requiredHeader } from "./helpers.js";
export const sessionOwner: Actor = {
  id: "owner",
  name: "나",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
export async function sessionHttpFixture(githubProvider?: GithubProvider) {
  const dir = mkdtempSync(join(tmpdir(), "sticker-sessions-http-"));
  const seed = new Store(dir),
    project = seed.createProject(sessionOwner, { key: "HP", name: "범위 A" }),
    other = seed.createProject(sessionOwner, { key: "HQ", name: "범위 B" });
  const issue = seed.createIssue(sessionOwner, {
      projectId: project.id,
      title: "입력 요청",
    }),
    foreign = seed.createIssue(sessionOwner, {
      projectId: other.id,
      title: "범위 밖",
    });
  seed.close();
  const tokens = {
    agent: "fixture-session-agent-token-only",
    other: "fixture-session-other-token-only",
    read: "fixture-session-read-token-only",
    unscoped: "fixture-session-unscoped-token-only",
  };
  const instance = createApp({
    githubProvider,
    dataDir: dir,
    ownerPassword: "disposable-session-owner-password",
    appOrigin: "http://localhost:8787",
    agents: Object.entries(tokens).map(([id, token]) => ({
      id,
      name: id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      canWrite: id !== "read",
      projectIds: id === "unscoped" ? null : [project.id],
    })),
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture address");
  const base = `http://127.0.0.1:${String(address.port)}`;
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "disposable-session-owner-password" }),
  });
  const cookie = requiredHeader(login, "set-cookie").split(";")[0];
  const call = (
    path: string,
    who: keyof typeof tokens | "owner" | "anonymous" = "owner",
    method = "GET",
    body?: unknown,
  ) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(who === "owner"
          ? { cookie, origin: "http://localhost:8787" }
          : who === "anonymous"
            ? {}
            : { authorization: `Bearer ${tokens[who]}` }),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    instance,
    project,
    other,
    issue,
    foreign,
    tokens,
    base,
    call,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r, j) =>
        server.close((e) => {
          if (e) j(e);
          else r();
        }),
      );
      instance.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
