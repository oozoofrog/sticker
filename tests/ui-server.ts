import { githubBrowserFixture } from "./github-provider-fixture.js";
import { createHash } from "node:crypto";
/** Disposable browser-test server. Never loads the operator's environment credentials or data. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
const port = 8788;
const dataDir = mkdtempSync(join(tmpdir(), "sticker-browser-fixture-"));
const instance = createApp({
  githubProvider: githubBrowserFixture(),
  dataDir,
  ownerPassword: "ephemeral-sticker-test-password",
  agents: [
    {
      id: "fixture-agent",
      name: "검증 에이전트",
      tokenHash: createHash("sha256")
        .update("disposable-browser-session-agent-token")
        .digest("hex"),
      canWrite: true,
      projectIds: null,
    },
  ],
  appOrigin: `http://127.0.0.1:${String(port)}`,
  clientDir: "dist/client",
});
const owner = {
  id: "owner",
  name: "나",
  role: "owner" as const,
  canWrite: true,
  projectIds: null,
};
const project = instance.store.createProject(owner, {
  key: "SESS",
  name: "세션 브라우저 검증",
});
instance.store.github.connect(owner, project.id, {
  repository: { owner: "octocat", name: "fixture-source" },
  mode: "public",
  revision: 0,
  confirm: true,
});
instance.store.createProject(owner, {
  key: "EMPTY",
  name: "빈 세션 프로젝트",
});
const first = instance.store.createIssue(owner, {
  projectId: project.id,
  title: "병렬 작업 A",
});
const second = instance.store.createIssue(owner, {
  projectId: project.id,
  title: "병렬 작업 B",
});
const agent = {
  id: "fixture-agent",
  name: "검증 에이전트",
  role: "agent" as const,
  canWrite: true,
  projectIds: [project.id],
};
const fixtureTime = Date.now();
instance.store.sessions.report(agent, {
  projectId: project.id,
  issueId: first.id,
  externalSessionId: "fixture-parallel-a",
  eventId: "start",
  occurredAt: new Date(fixtureTime - 60000).toISOString(),
  kind: "report",
  message: "자기 보고",
});
instance.store.sessions.report(agent, {
  projectId: project.id,
  issueId: second.id,
  externalSessionId: "fixture-parallel-b",
  eventId: "start",
  kind: "report",
  message: "별도 세션",
});
instance.store.sessions.report(agent, {
  projectId: project.id,
  issueId: first.id,
  externalSessionId: "fixture-parallel-a",
  eventId: "input",
  occurredAt: new Date(fixtureTime - 20000).toISOString(),
  kind: "request",
  requestKind: "input",
  message: "fixture-input",
});
instance.store.sessions.report(agent, {
  projectId: project.id,
  issueId: first.id,
  externalSessionId: "fixture-parallel-a",
  eventId: "long-result",
  occurredAt: new Date(fixtureTime - 30000).toISOString(),
  kind: "result",
  message: "긴출력".repeat(1800),
});
instance.store.sessions.report(agent, {
  projectId: project.id,
  issueId: second.id,
  externalSessionId: "fixture-parallel-b",
  eventId: "review",
  kind: "request",
  requestKind: "review",
  message: "fixture-review",
});
const server = instance.app.listen(port, "127.0.0.1", () => {
  console.log(
    `Disposable Sticker test fixture: http://127.0.0.1:${String(port)}`,
  );
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => {
    instance.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
server.on("error", (error) => {
  instance.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
