import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../server/app.js";
import { agentsSchema } from "../server/auth.js";
import { Store } from "../server/domain.js";
import { sessionOwner } from "./session-fixture.js";
import {
  apiErrorSchema,
  bootstrapSchema,
  issueDetailSchema,
  issueSchema,
} from "../server/response-schemas.js";
import { historyListSchema } from "../server/contracts/history.js";
import { readJson, requiredHeader } from "./helpers.js";

void test("two scoped HTTP agents recover competing issue edits and unobserved creation after app restart without duplicate history", async () => {
  const f = await recoveryFixture();
  try {
    const creation = {
      projectId: f.project.id,
      title: "함께 검토할 작업",
      description: "최초 본문",
      operationId: randomUUID(),
    };
    const unobserved = await f.call("/issues", "agent-a", "POST", creation);
    assert.equal(unobserved.status, 201);
    // Consume but do not inspect the entity: response-observation loss, not a network fault.
    await unobserved.arrayBuffer();
    const initial = await readJson(
      await f.call("/bootstrap", "agent-a"),
      bootstrapSchema,
    );
    assert.equal(initial.issues.length, 1);
    const issue = initial.issues[0];
    const path = `/issues/${issue.id}`;
    const actors = ["agent-a", "agent-b"] as const;
    const reads = await Promise.all(
      actors.map(async (actor) =>
        readJson(await f.call(path, actor), issueDetailSchema),
      ),
    );
    assert.deepEqual(
      reads.map((detail) => detail.issue.revision),
      [1, 1],
    );
    const edits = [
      { revision: 1, title: "에이전트 A의 제목" },
      { revision: 1, description: "에이전트 B의 본문" },
    ];
    // Concurrently outstanding HTTP requests; SQLite mutations remain serialized.
    const replies = await Promise.all(
      actors.map((actor, index) => f.call(path, actor, "PATCH", edits[index])),
    );
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
    const winner = replies.findIndex((r) => r.status === 200);
    const loser = winner === 0 ? 1 : 0;
    const saved = await readJson(replies[winner], issueSchema);
    assert.equal(saved.revision, 2);
    assert.equal(
      (await readJson(replies[loser], apiErrorSchema)).code,
      "REVISION_CONFLICT",
    );
    const afterConflict = await readJson(
      await f.call(path, actors[loser]),
      issueDetailSchema,
    );
    assert.deepEqual(afterConflict.issue, saved);
    assert.equal(afterConflict.activity.length, 2);
    assert.equal(
      afterConflict.issue.title,
      winner === 0 ? "에이전트 A의 제목" : "함께 검토할 작업",
    );
    assert.equal(
      afterConflict.issue.description,
      winner === 1 ? "에이전트 B의 본문" : "최초 본문",
    );

    // Explicit fresh review precedes a new PATCH; no automatic last-write-wins retry.
    const retry = await f.call(path, actors[loser], "PATCH", {
      ...edits[loser],
      revision: afterConflict.issue.revision,
    });
    assert.equal(retry.status, 200);
    const reviewed = await readJson(retry, issueSchema);
    assert.equal(reviewed.revision, 3);
    assert.equal(reviewed.title, "에이전트 A의 제목");
    assert.equal(reviewed.description, "에이전트 B의 본문");
    const staleReplay = await f.call(
      path,
      actors[winner],
      "PATCH",
      edits[winner],
    );
    assert.equal(staleReplay.status, 409);
    assert.equal(
      (await readJson(staleReplay, apiErrorSchema)).code,
      "REVISION_CONFLICT",
    );
    const before = await readJson(
      await f.call(`${path}/history`, "owner"),
      historyListSchema,
    );
    assert.equal(before.length, 3);
    const chronological = [...before].sort(
      (a, b) => (a.revisionAfter ?? 0) - (b.revisionAfter ?? 0),
    );
    assert.deepEqual(
      chronological.map((row) => [
        row.revisionBefore,
        row.revisionAfter,
        row.authorId,
      ]),
      [
        [0, 1, "agent-a"],
        [1, 2, actors[winner]],
        [2, 3, actors[loser]],
      ],
    );
    await f.checkScopes();
    await f.restart();
    assert.equal((await f.call("/bootstrap", "owner")).status, 401);
    await f.login();
    const replay = await f.call("/issues", "agent-a", "POST", creation);
    assert.equal(replay.status, 201);
    // The established receipt contract returns the current issue, not its creation snapshot.
    assert.deepEqual(await readJson(replay, issueSchema), reviewed);
    const changed = await f.call("/issues", "agent-a", "POST", {
      ...creation,
      title: "다른 요청으로 바꾸지 않기",
    });
    assert.equal(changed.status, 409);
    assert.equal(
      (await readJson(changed, apiErrorSchema)).code,
      "OPERATION_CONFLICT",
    );
    await f.checkScopes();
    for (const actor of [...actors, "owner"] as const) {
      const persisted = await readJson(
        await f.call(path, actor),
        issueDetailSchema,
      );
      assert.deepEqual(persisted.issue, reviewed);
      assert.equal(persisted.activity.length, 3);
      assert.deepEqual(
        await readJson(
          await f.call(`${path}/history`, actor),
          historyListSchema,
        ),
        before,
      );
      const boot = await readJson(
        await f.call("/bootstrap", actor),
        bootstrapSchema,
      );
      assert.equal(boot.issues.length, 1);
      if (actor !== "owner")
        assert.deepEqual(
          boot.projects.map((p) => p.id),
          [f.project.id],
        );
    }
  } finally {
    await f.close();
  }
});

async function recoveryFixture() {
  const dir = mkdtempSync(join(tmpdir(), "sticker-multi-agent-journey-"));
  const password = "synthetic-multi-agent-owner-password";
  const origin = "http://localhost:8787";
  const tokens = {
    "agent-a": "synthetic-journey-agent-a-token",
    "agent-b": "synthetic-journey-agent-b-token",
    readonly: "synthetic-journey-readonly-token",
  };
  let active:
    { instance: ReturnType<typeof createApp>; server: Server } | undefined;
  let base = "";
  let cookie = "";
  const stop = async () => {
    const current = active;
    active = undefined;
    if (!current) return;
    try {
      current.server.closeAllConnections();
      if (current.server.listening) {
        await new Promise<void>((resolve, reject) =>
          current.server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    } finally {
      current.instance.close();
    }
  };
  const close = async () => {
    try {
      await stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    const seed = new Store(dir);
    const { project, foreign } = (() => {
      try {
        return {
          project: seed.createProject(sessionOwner, {
            key: "RACE",
            name: "공동 작업",
          }),
          foreign: seed.createProject(sessionOwner, {
            key: "OTHER",
            name: "다른 범위",
          }),
        };
      } finally {
        seed.close();
      }
    })();
    const grantsPath = join(dir, "synthetic-agent-grants.json");
    writeFileSync(
      grantsPath,
      JSON.stringify(
        Object.entries(tokens).map(([id, token]) => ({
          id,
          name: id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          projectIds: [project.id],
          canWrite: id !== "readonly",
        })),
      ),
      { mode: 0o600 },
    );
    const start = async () => {
      const instance = createApp({
        dataDir: dir,
        ownerPassword: password,
        appOrigin: origin,
        agents: agentsSchema.parse(
          JSON.parse(readFileSync(grantsPath, "utf8")),
        ),
      });
      const server = instance.app.listen(0, "127.0.0.1");
      active = { instance, server };
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      base = `http://127.0.0.1:${String(address.port)}/api`;
    };
    const call = (
      path: string,
      who: keyof typeof tokens | "owner",
      method = "GET",
      body?: unknown,
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(who === "owner"
            ? { cookie, origin }
            : { authorization: `Bearer ${tokens[who]}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const login = async () => {
      const response = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      assert.equal(response.status, 200);
      cookie = requiredHeader(response, "set-cookie").split(";")[0];
      await response.arrayBuffer();
    };
    const checkScopes = async () => {
      const readonly = await call("/issues", "readonly", "POST", {
        projectId: project.id,
        title: "읽기 전용은 생성 불가",
        operationId: randomUUID(),
      });
      assert.equal(readonly.status, 403);
      await readonly.arrayBuffer();
      for (const actor of ["agent-a", "agent-b"] as const) {
        const denied = await call("/issues", actor, "POST", {
          projectId: foreign.id,
          title: "다른 범위는 생성 불가",
          operationId: randomUUID(),
        });
        assert.equal(denied.status, 403);
        assert.equal(
          (await readJson(denied, apiErrorSchema)).code,
          "PROJECT_SCOPE",
        );
      }
    };
    await start();
    await login();
    return {
      project,
      call,
      login,
      checkScopes,
      close,
      restart: async () => {
        await stop();
        await start();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
