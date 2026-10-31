import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../server/domain.js";
import { createApp } from "../server/app.js";
import { z } from "zod";
import {
  projectSchema,
  issueSchema,
  commentSchema,
  attachmentSchema,
  reportSchema,
  apiErrorSchema,
} from "../server/response-schemas.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = "fixture-only-mcp-token-not-a-live-grant";
async function fixture(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
) {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const value: unknown = chunk;
      assert.ok(Buffer.isBuffer(value));
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    handler(req, res, z.record(z.string(), z.unknown()).parse(parsed));
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.destroy(
        error instanceof Error ? error : new Error("Invalid test request"),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          r();
        }),
      ),
  };
}
function connect(url: string, suppliedToken = token) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "server/mcp.ts"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      STICKER_API_URL: url,
      STICKER_AGENT_TOKEN: suppliedToken,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "sticker-test", version: "1.0.0" });
  return { transport, client };
}
function data<T>(result: unknown, schema: z.ZodType<T>): T {
  const envelope = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1),
    })
    .parse(result);
  const value: unknown = JSON.parse(envelope.content[0].text);
  return schema.parse(value);
}
function resourceBlob(result: unknown): string {
  const envelope = z
    .object({
      content: z
        .array(
          z.object({
            type: z.literal("resource"),
            resource: z.object({ blob: z.string() }),
          }),
        )
        .min(1),
    })
    .parse(result);
  return envelope.content[0].resource.blob;
}
const toolErrorSchema = apiErrorSchema.extend({ status: z.number() });

void test("official SDK initializes STDIO, lists tools and calls issue tools with authoritative bearer only", async () => {
  const calls: {
    method: string;
    url: string;
    body: Record<string, unknown>;
  }[] = [];
  const api = await fixture((req, res, body) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    calls.push({ method: req.method ?? "", url: req.url ?? "", body });
    if (req.url === "/api/bootstrap")
      res.end(
        JSON.stringify({
          actor: {
            id: "agent-test",
            name: "test",
            role: "agent",
            canWrite: true,
            projectIds: null,
          },
          projects: [
            {
              id: "p1",
              key: "TST",
              name: "테스트",
              description: "",
              color: "#ffffff",
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            },
          ],
          versions: [],
          issues: [],
          reports: [],
        }),
      );
    else if (req.url === "/api/issues")
      res.end(
        JSON.stringify({
          id: "i1",
          key: "TST-1",
          revision: 1,
          projectId: "p1",
          title: "",
          description: "",
          status: "backlog",
          priority: "none",
          assignee: "",
          targetVersionId: null,
          foundVersionId: null,
          fixedVersionId: null,
          labels: [],
          templateId: null,
          templateVersion: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...body,
        }),
      );
    else if (req.url === "/api/issues/i1" && req.method === "PATCH")
      res.end(
        JSON.stringify({
          id: "i1",
          projectId: "p1",
          key: "TST-1",
          title: "synthetic",
          description: "",
          status: "backlog",
          priority: "none",
          assignee: "",
          targetVersionId: null,
          foundVersionId: null,
          fixedVersionId: null,
          labels: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          ...body,
          revision: 2,
        }),
      );
    else if (req.url === "/api/issues/i1/comments")
      res.end(
        JSON.stringify({
          id: "c1",
          issueId: "i1",
          authorId: "agent-test",
          authorName: "test",
          createdAt: "2026-01-01",
          ...body,
        }),
      );
    else if (req.url === "/api/reports")
      res.end(JSON.stringify({ agentId: "agent-test", stale: false, ...body }));
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "missing", code: "not_found" }));
    }
  });
  const { client, transport } = connect(api.url);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "sticker_list_projects"));
    assert.ok(tools.tools.some((t) => t.name === "sticker_update_issue"));
    assert.ok(
      tools.tools.some((t) => t.name === "sticker_create_project"),
      "owner-only project creation is not advertised to agent clients",
    );
    assert.ok(!tools.tools.some((t) => /shell|execute|run_agent/.test(t.name)));
    const projects = await client.callTool({
      name: "sticker_list_projects",
      arguments: {},
    });
    assert.equal(data(projects, projectSchema.array())[0].name, "테스트");
    const created = await client.callTool({
      name: "sticker_create_issue",
      arguments: { projectId: "p1", title: "첫 번째 스티커" },
    });
    assert.equal(data(created, z.object({ key: z.string() })).key, "TST-1");
    const updated = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: "i1", revision: 1, status: "waiting" },
    });
    assert.equal(
      data(updated, z.object({ status: z.string() })).status,
      "waiting",
    );
    const commented = await client.callTool({
      name: "sticker_add_comment",
      arguments: { issueId: "i1", body: "확인했습니다." },
    });
    assert.equal(
      data(commented, z.object({ authorId: z.string() })).authorId,
      "agent-test",
    );
    await client.callTool({
      name: "sticker_report_status",
      arguments: {
        projectId: "p1",
        issueId: "i1",
        state: "blocked",
        message: "사용자 승인 대기",
      },
    });
    assert.deepEqual(calls.find((c) => c.method === "PATCH")?.body, {
      revision: 1,
      status: "waiting",
    });
    assert.ok(
      calls.every((c) => !("authorId" in c.body) && !("agentId" in c.body)),
    );
  } finally {
    await client.close();
    await api.close();
  }
});

void test("tool errors preserve conflict semantics and never leak bearer credentials", async () => {
  const api = await fixture((_req, res) => {
    res.statusCode = 409;
    res.end(
      JSON.stringify({
        error: `revision conflict ${token}`,
        code: "revision_conflict",
      }),
    );
  });
  const { client, transport } = connect(api.url);
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: "i1", revision: 1, title: "retry" },
    });
    assert.equal(result.isError, true);
    assert.equal(data(result, toolErrorSchema).status, 409);
    assert.equal(data(result, toolErrorSchema).code, "revision_conflict");
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally {
    await client.close();
    await api.close();
  }
});

void test("caller cannot forge authors, close issues, omit revision or fetch arbitrary URLs", async () => {
  let count = 0;
  const api = await fixture((_req, res, body) => {
    count++;
    assert.equal(body.status, "closed");
    res.statusCode = 403;
    res.end(
      JSON.stringify({ code: "OWNER_REQUIRED", error: "owner required" }),
    );
  });
  const { client, transport } = connect(api.url);
  try {
    await client.connect(transport);
    for (const args of [
      { issueId: "i1", title: "missing revision" },
      { issueId: "i1", revision: 1, status: "closed" },
      { issueId: "i1", revision: 1, authorId: "owner" },
    ]) {
      const result = await client.callTool({
        name: "sticker_update_issue",
        arguments: args,
      });
      assert.equal(result.isError, true);
      if (args.status === "closed")
        assert.equal(data(result, toolErrorSchema).status, 403);
    }
    const result = await client.callTool({
      name: "sticker_add_link",
      arguments: { issueId: "i1", name: "bad", url: "javascript:alert(1)" },
    });
    assert.equal(result.isError, true);
    assert.equal(
      count,
      1,
      "Only the valid closed-status input reaches authoritative HTTP permission checks",
    );
  } finally {
    await client.close();
    await api.close();
  }
});

// This is not a mock API: it exercises SQLite, authorization, files and activity through STDIO.
void test("MCP and browser API share real persistence, scopes, revisions and private attachments", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-mcp-"));
  const owner = {
    id: "owner",
    name: "나",
    role: "owner" as const,
    canWrite: true,
    projectIds: null,
  };
  const seed = new Store(dir);
  const project = seed.createProject(owner, { name: "MCP 테스트", key: "MCP" });
  const secret = seed.createProject(owner, { name: "범위 밖", key: "SEC" });
  const secretIssue = seed.createIssue(owner, {
    projectId: secret.id,
    title: "비공개",
  });
  seed.close();
  const app = createApp({
    dataDir: dir,
    ownerPassword: "ephemeral-test-password-12345",
    agents: [
      {
        id: "codex-test",
        name: "Codex test",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        projectIds: [project.id],
        canWrite: true,
      },
    ],
  });
  const http = app.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const { client, transport } = connect(
    `http://127.0.0.1:${String((http.address() as { port: number }).port)}`,
  );
  try {
    await client.connect(transport);
    const projects = data(
      await client.callTool({ name: "sticker_list_projects", arguments: {} }),
      projectSchema.array(),
    );
    assert.deepEqual(
      projects.map((p: { id: string }) => p.id),
      [project.id],
    );
    const denied = await client.callTool({
      name: "sticker_get_issue",
      arguments: { issueId: secretIssue.id },
    });
    assert.equal(denied.isError, true);
    const issue = data(
      await client.callTool({
        name: "sticker_create_issue",
        arguments: { projectId: project.id, title: "에이전트가 만든 이슈" },
      }),
      issueSchema,
    );
    assert.ok(issue.id);
    await t.test(
      "MCP accepts the same issue title and Unicode description limits as the domain",
      async () => {
        const title = "한".repeat(300),
          description = "글".repeat(100_000);
        const result = await client.callTool({
          name: "sticker_create_issue",
          arguments: { projectId: project.id, title, description },
        });
        assert.notEqual(
          result.isError,
          true,
          JSON.stringify(result).slice(0, 1000),
        );
        const created = data(result, issueSchema);
        assert.equal(created.title, title);
        assert.equal(created.description, description);
      },
    );
    const comment = data(
      await client.callTool({
        name: "sticker_add_comment",
        arguments: { issueId: issue.id, body: "기록 확인" },
      }),
      commentSchema,
    );
    assert.equal(comment.authorId, "codex-test");
    const file = data(
      await client.callTool({
        name: "sticker_upload_file",
        arguments: {
          issueId: issue.id,
          name: "한글-메모.txt",
          mimeType: "text/plain",
          base64: Buffer.from("스티커 자료").toString("base64"),
        },
      }),
      attachmentSchema,
    );
    assert.equal(file.authorId, "codex-test");
    const read = await client.callTool({
      name: "sticker_read_file",
      arguments: { attachmentId: file.id },
    });
    const blob = resourceBlob(read);
    assert.equal(Buffer.from(blob, "base64").toString(), "스티커 자료");
    const updated = data(
      await client.callTool({
        name: "sticker_update_issue",
        arguments: {
          issueId: issue.id,
          revision: issue.revision,
          status: "waiting",
        },
      }),
      issueSchema,
    );
    assert.equal(updated.status, "waiting");
    const conflict = await client.callTool({
      name: "sticker_update_issue",
      arguments: {
        issueId: issue.id,
        revision: issue.revision,
        status: "done",
      },
    });
    assert.equal(conflict.isError, true);
    assert.equal(data(conflict, toolErrorSchema).status, 409);
    const detail = app.store.getIssue(owner, issue.id);
    assert.equal(detail.issue.status, "waiting");
    assert.ok(detail.activity.every((a) => a.authorId === "codex-test"));
    assert.equal(detail.attachments.length, 1);
    await t.test(
      "MCP accepts the advertised 5 MiB file boundary and rejects malformed base64",
      async () => {
        const large = Buffer.alloc(5 * 1024 * 1024, 120);
        const result = await client.callTool({
          name: "sticker_upload_file",
          arguments: {
            issueId: issue.id,
            name: "boundary.bin",
            base64: large.toString("base64"),
          },
        });
        assert.notEqual(
          result.isError,
          true,
          JSON.stringify(result).slice(0, 1000),
        );
        const attachment = data(result, attachmentSchema);
        assert.equal(attachment.size, large.length);
        const downloaded = await client.callTool({
          name: "sticker_read_file",
          arguments: { attachmentId: attachment.id },
        });
        assert.notEqual(downloaded.isError, true);
        assert.deepEqual(
          Buffer.from(resourceBlob(downloaded), "base64"),
          large,
        );
        for (const base64 of ["AAAA=", "AA=A", "AA A", "!!!="]) {
          const invalid = await client.callTool({
            name: "sticker_upload_file",
            arguments: { issueId: issue.id, name: "bad.bin", base64 },
          });
          assert.equal(invalid.isError, true);
        }
      },
    );
    const report = data(
      await client.callTool({
        name: "sticker_report_status",
        arguments: {
          projectId: project.id,
          issueId: issue.id,
          state: "blocked",
          message: "승인 대기",
        },
      }),
      reportSchema,
    );
    assert.equal(report.agentId, "codex-test");
    assert.equal(report.stale, false);
  } finally {
    await client.close();
    await new Promise<void>((resolve) =>
      http.close(() => {
        resolve();
      }),
    );
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("malformed upstream errors preserve HTTP status and never expose arbitrary error values", async () => {
  const api = await fixture((_req, res) => {
    res.statusCode = 403;
    res.end("null");
  });
  const { client, transport } = connect(api.url);
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: "fixture", revision: 1, title: "검증" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(data(result, toolErrorSchema), {
      status: 403,
      code: "api_error",
      error: "API HTTP 403",
    });
  } finally {
    await client.close();
    await api.close();
  }
});
