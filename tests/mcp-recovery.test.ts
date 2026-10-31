import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createApp } from "../server/app.js";
import { createStickerMcp } from "../server/mcp.js";
import type { Actor } from "../server/types.js";

const owner: Actor = {
  id: "owner",
  name: "Owner",
  role: "owner",
  canWrite: true,
  projectIds: null,
};
const token = "synthetic-recovery-agent-token-only";
const envelope = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});
const failure = z.object({
  code: z.string(),
  status: z.number().optional(),
  outcome: z.string().optional(),
  retryable: z.boolean().optional(),
  retry: z.string().optional(),
  retryKeyFields: z.array(z.string()).optional(),
  readback: z.string().optional(),
  phase: z.string().optional(),
});
function data(value: unknown): unknown {
  return JSON.parse(envelope.parse(value).content[0].text);
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-recovery-"));
  let hook: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const counts = new Map<string, number>();
  const http = createServer((req, res) => {
    const key = `${req.method ?? ""} ${req.url ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    hook?.(req, res);
    app.app(req, res);
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => http.once("listening", r));
  const addr = http.address();
  assert.ok(addr && typeof addr !== "string");
  const apiUrl = `http://127.0.0.1:${String(addr.port)}`;
  const app = createApp({
    dataDir: dir,
    appOrigin: apiUrl,
    ownerPassword: "",
    localOwnerMode: "trusted-loopback",
    agents: [
      {
        id: "recovery",
        name: "Recovery",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        canWrite: true,
        projectIds: null,
      },
    ],
  });
  const project = app.store.createProject(owner, { key: "BASE", name: "Base" });
  const server = createStickerMcp({
      apiUrl,
      auth: { mode: "trusted-local-owner" },
    }),
    agentServer = createStickerMcp(apiUrl, token);
  const client = new Client({ name: "recovery-owner", version: "1" }),
    agent = new Client({ name: "recovery-agent", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(),
    [c, d] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  await agentServer.connect(c);
  await agent.connect(d);
  return {
    client,
    agent,
    project,
    counts,
    intercept(next: typeof hook) {
      hook = next;
    },
    async close() {
      await client.close();
      await agent.close();
      await server.close();
      await agentServer.close();
      http.closeAllConnections();
      await new Promise<void>((r) =>
        http.close(() => {
          r();
        }),
      );
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

void test("committed project creation with schema-invalid or malformed JSON response remains uncertain with independent readback", async () => {
  for (const invalid of [
    JSON.stringify({ unexpected: "not a project" }),
    "{",
  ]) {
    const f = await fixture();
    try {
      f.intercept((req, res) => {
        if (req.method === "POST" && req.url === "/api/projects") {
          const end = res.end.bind(res);
          res.end = () => {
            res.removeHeader("content-length");
            return end(invalid);
          };
        }
      });
      const result = await f.client.callTool({
        name: "sticker_create_project",
        arguments: { key: "NEW", name: "Committed" },
      });
      assert.equal(envelope.parse(result).isError, true);
      const error = failure.parse(data(result));
      assert.equal(error.code, "api_response_invalid");
      assert.equal(error.outcome, "uncertain");
      assert.equal(error.retryable, false);
      assert.equal(error.readback, "sticker_list_projects");
      assert.equal(f.counts.get("POST /api/projects"), 1);
      const projects = z.array(z.object({ key: z.string() })).parse(
        data(
          await f.client.callTool({
            name: "sticker_list_projects",
            arguments: {},
          }),
        ),
      );
      assert.deepEqual(projects.map((p) => p.key).sort(), ["BASE", "NEW"]);
    } finally {
      await f.close();
    }
  }
});

void test("POST read transport failures are safely repeatable reads without uncertain mutation warnings or automatic resend", async () => {
  const f = await fixture();
  try {
    f.intercept((req, res) => {
      if (req.url === "/api/issues/query") res.destroy();
    });
    const result = await f.agent.callTool({
      name: "sticker_list_issues",
      arguments: { projectId: f.project.id },
    });
    const error = failure.parse(data(result));
    assert.equal(error.outcome, undefined);
    assert.equal(error.retryable, true);
    assert.equal(error.retry, "safe_read");
    assert.equal(f.counts.get("POST /api/issues/query"), 1);
    f.intercept(undefined);
    assert.deepEqual(
      data(
        await f.agent.callTool({
          name: "sticker_list_issues",
          arguments: { projectId: f.project.id },
        }),
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

void test("a committed keyed document permits only exact original-key-and-payload replay and never automatically resends", async () => {
  const f = await fixture();
  const input = {
    projectId: f.project.id,
    title: "One document",
    markdown: "Exact original bytes",
    operationId: randomUUID(),
  };
  try {
    f.intercept((req, res) => {
      if (req.method === "POST" && req.url === "/api/resources")
        res.end = () => {
          res.destroy();
          return res;
        };
    });
    const error = failure.parse(
      data(
        await f.agent.callTool({
          name: "sticker_create_document",
          arguments: input,
        }),
      ),
    );
    assert.equal(error.outcome, "uncertain");
    assert.equal(error.retryable, true);
    assert.equal(error.retry, "same_key_same_payload");
    assert.deepEqual(error.retryKeyFields, ["operationId"]);
    assert.equal(f.counts.get("POST /api/resources"), 1);
    f.intercept(undefined);
    const original = data(
      await f.agent.callTool({
        name: "sticker_create_document",
        arguments: input,
      }),
    );
    assert.ok(
      z.object({ resource: z.object({ id: z.string() }) }).parse(original)
        .resource.id,
    );
    const changed = await f.agent.callTool({
      name: "sticker_create_document",
      arguments: { ...input, markdown: "Different payload" },
    });
    assert.equal(envelope.parse(changed).isError, true);
    assert.equal(failure.parse(data(changed)).status, 409);
    assert.equal(
      z.array(z.unknown()).parse(
        data(
          await f.agent.callTool({
            name: "sticker_list_resources",
            arguments: { projectId: f.project.id },
          }),
        ),
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

void test("conditional issue creation distinguishes keyed exact replay from unkeyed uncertain creation", async () => {
  for (const keyed of [false, true]) {
    const f = await fixture(),
      input = {
        projectId: f.project.id,
        title: "One issue",
        ...(keyed ? { operationId: randomUUID() } : {}),
      };
    try {
      f.intercept((req, res) => {
        if (req.method === "POST" && req.url === "/api/issues")
          res.end = () => {
            res.destroy();
            return res;
          };
      });
      const error = failure.parse(
        data(
          await f.agent.callTool({
            name: "sticker_create_issue",
            arguments: input,
          }),
        ),
      );
      assert.equal(error.outcome, "uncertain");
      assert.equal(error.retryable, keyed);
      assert.equal(error.retry, keyed ? "same_key_same_payload" : "readback");
      assert.deepEqual(
        error.retryKeyFields,
        keyed ? ["operationId"] : undefined,
      );
      assert.equal(f.counts.get("POST /api/issues"), 1);
      f.intercept(undefined);
      if (keyed)
        await f.agent.callTool({
          name: "sticker_create_issue",
          arguments: input,
        });
      const issues = z.array(z.object({ title: z.string() })).parse(
        data(
          await f.agent.callTool({
            name: "sticker_list_issues",
            arguments: { projectId: f.project.id },
          }),
        ),
      );
      assert.equal(issues.length, 1);
      assert.equal(issues[0].title, "One issue");
      if (!keyed) assert.equal(error.readback, "sticker_list_issues");
    } finally {
      await f.close();
    }
  }
});

void test("predispatch validation cannot be reported as an uncertain creation", async () => {
  const f = await fixture();
  try {
    const bad = await f.client.callTool({
      name: "sticker_create_project",
      arguments: { key: "BAD", name: "" },
    });
    assert.equal(envelope.parse(bad).isError, true);
    assert.ok(!JSON.stringify(bad).includes('"uncertain"'));
    assert.equal(f.counts.get("POST /api/projects"), undefined);
    const invalidBytes = await f.agent.callTool({
      name: "sticker_upload_resource_file",
      arguments: {
        projectId: f.project.id,
        title: "Bad",
        name: "bad.txt",
        operationId: randomUUID(),
        base64: "invalid",
      },
    });
    const error = failure.parse(data(invalidBytes));
    assert.equal(error.outcome, undefined);
    assert.equal(error.status, 400);
    assert.equal(
      f.counts.get(`POST /api/projects/${f.project.id}/resources/files`),
      undefined,
    );
  } finally {
    await f.close();
  }
});

void test("concurrent read, keyed write and unkeyed write failures retain their own recovery metadata", async () => {
  const f = await fixture();
  let pending: (() => void)[] = [];
  try {
    f.intercept((req, res) => {
      if (
        !["/api/issues/query", "/api/issues", "/api/resources"].includes(
          req.url ?? "",
        )
      )
        return;
      res.end = () => {
        pending.push(() => {
          res.destroy();
        });
        if (pending.length === 3) {
          const all = pending;
          pending = [];
          for (const release of all.reverse()) release();
        }
        return res;
      };
      // Every query/write runs through the real domain before its response is lost.
    });
    const calls = [
      f.agent.callTool({
        name: "sticker_list_issues",
        arguments: { projectId: f.project.id },
      }),
      f.agent.callTool({
        name: "sticker_create_document",
        arguments: {
          projectId: f.project.id,
          title: "Keyed",
          markdown: "",
          operationId: randomUUID(),
        },
      }),
      f.agent.callTool({
        name: "sticker_create_issue",
        arguments: { projectId: f.project.id, title: "Unkeyed" },
      }),
    ];
    const [read, keyed, unkeyed] = (await Promise.all(calls)).map((value) =>
      failure.parse(data(value)),
    );
    assert.equal(read.outcome, undefined);
    assert.equal(read.retry, "safe_read");
    assert.equal(keyed.retry, "same_key_same_payload");
    assert.equal(unkeyed.retry, "readback");
    assert.equal(unkeyed.retryable, false);
    for (const path of ["/api/issues/query", "/api/issues", "/api/resources"])
      assert.equal(f.counts.get(`POST ${path}`), 1);
  } finally {
    await f.close();
  }
});

void test("POST read timeout errors use safe read recovery without issuing an automatic second request", async (t) => {
  const f = await fixture(),
    originalFetch = globalThis.fetch;
  let attempts = 0;
  t.mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => {
    const input = args[0],
      url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/api/issues/query") {
      attempts++;
      return Promise.reject(
        new DOMException("Synthetic timeout", "TimeoutError"),
      );
    }
    return originalFetch(...args);
  });
  try {
    const error = failure.parse(
      data(
        await f.agent.callTool({
          name: "sticker_query_issues",
          arguments: { projectId: f.project.id },
        }),
      ),
    );
    assert.equal(error.retry, "safe_read");
    assert.equal(error.retryable, true);
    assert.equal(error.outcome, undefined);
    assert.equal(attempts, 1);
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

void test("a committed session event allows only the same event identity and original payload", async () => {
  const f = await fixture(),
    input = {
      projectId: f.project.id,
      externalSessionId: "synthetic-run",
      eventId: "synthetic-event",
      kind: "report",
      state: "working",
      message: "One report",
    };
  try {
    f.intercept((req, res) => {
      if (req.method === "POST" && req.url === "/api/sessions/events")
        res.end = () => {
          res.destroy();
          return res;
        };
    });
    const error = failure.parse(
      data(
        await f.agent.callTool({
          name: "sticker_report_session_event",
          arguments: input,
        }),
      ),
    );
    assert.equal(error.outcome, "uncertain");
    assert.equal(error.retry, "same_key_same_payload");
    assert.deepEqual(error.retryKeyFields, ["externalSessionId", "eventId"]);
    assert.equal(f.counts.get("POST /api/sessions/events"), 1);
    f.intercept(undefined);
    const replay = z.object({ session: z.object({ id: z.string() }) }).parse(
      data(
        await f.agent.callTool({
          name: "sticker_report_session_event",
          arguments: input,
        }),
      ),
    );
    const detail = z.object({ events: z.array(z.unknown()) }).parse(
      data(
        await f.agent.callTool({
          name: "sticker_get_session",
          arguments: { sessionId: replay.session.id },
        }),
      ),
    );
    assert.equal(detail.events.length, 1);
    const changed = failure.parse(
      data(
        await f.agent.callTool({
          name: "sticker_report_session_event",
          arguments: { ...input, message: "Changed payload" },
        }),
      ),
    );
    assert.equal(changed.status, 409);
  } finally {
    await f.close();
  }
});
