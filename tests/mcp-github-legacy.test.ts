import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";
import { ordinaryMcpFixture } from "./mcp-product-fixture.js";
import { GithubReadError } from "../server/github-read-client.js";
import type { GithubProvider } from "../server/features/github.js";
import {
  githubConnectionSchema,
  githubEvidenceSchema,
} from "../server/contracts/github.js";
import {
  githubDiscoverySourcesSchema,
  githubDiscoveryPageSchema,
  githubSelectionStatusSchema,
} from "../server/contracts/github-discovery.js";
import { MCP_CATALOGUE } from "../server/mcp/catalogue.js";
import {
  MCP_ROUTE_EXCEPTIONS,
  MCP_PARTIAL_FILE_ROUTES,
} from "../server/mcp/route-coverage.js";
const names = [
  "list_github_sources",
  "list_github_repositories",
  "connect_github_selection",
  "get_github_selection_status",
  "get_github_connection",
  "set_github_connection",
  "disconnect_github_connection",
  "verify_github_connection",
  "add_github_evidence",
  "get_github_evidence_item",
  "remove_github_evidence",
  "refresh_github_evidence",
];
const repository = { owner: "octocat", name: "selected" };
const option = {
  id: 42,
  repository,
  visibility: "private" as const,
  archived: false,
  disabled: false,
};
const secret = "synthetic-provider-secret-not-for-output";
const ref = "internalFixtureCredentialRef";
function fixture() {
  const calls: string[] = [];
  let fail = false;
  const provider: GithubProvider = {
    enabled: true,
    credentials: {
      [ref]: { label: "Configured fixture account", resolve: () => secret },
    },
    client: () => ({
      listRepositories: ({ page }) => {
        calls.push(`list:${String(page)}`);
        if (fail) throw new Error(secret);
        return Promise.resolve({ items: [option], hasMore: page === 1 });
      },
      verifySelection: () => {
        calls.push("selection");
        return Promise.resolve();
      },
      verify: () => {
        calls.push("verify");
        if (fail) throw new Error(secret);
        return Promise.resolve();
      },
      inspect: () => {
        calls.push("inspect");
        if (fail) throw new GithubReadError("FORBIDDEN");
        return Promise.resolve({
          headSha: "a".repeat(40),
          snapshotSha: "a".repeat(40),
          ci: "success" as const,
          snapshotCi: "success" as const,
          stale: false,
          complete: true,
          checkCount: 1,
          statusCount: 1,
        });
      },
    }),
  };
  return {
    calls,
    fail: () => {
      fail = true;
    },
    create: () => ordinaryMcpFixture("owner-session", undefined, provider),
  };
}
type Fixture = Awaited<ReturnType<typeof ordinaryMcpFixture>>;
const tool = (name: string) => `sticker_${name}`;
async function discover(f: Fixture) {
  const sources = await f.ok(
    "owner",
    tool("list_github_sources"),
    { projectId: f.project.id },
    githubDiscoverySourcesSchema,
  );
  assert.equal(sources.sources.length, 1);
  const page = await f.ok(
    "owner",
    tool("list_github_repositories"),
    { projectId: f.project.id, sourceId: sources.sources[0].id },
    githubDiscoveryPageSchema,
  );
  return {
    page,
    input: {
      projectId: f.project.id,
      sourceId: page.sourceId,
      selectionId: page.repositories[0].selectionId,
      revision: page.revision,
      confirm: true,
    },
  };
}
async function connect(f: Fixture) {
  return f.ok(
    "owner",
    tool("set_github_connection"),
    {
      projectId: f.project.id,
      repository,
      mode: "public",
      revision: 0,
      confirm: true,
    },
    githubConnectionSchema,
  );
}
function data(value: unknown) {
  const envelope = z
    .object({ content: z.array(z.object({ text: z.string() })) })
    .parse(value);
  return JSON.parse(envelope.content[0].text) as unknown;
}
function noSecrets(value: unknown) {
  const encoded = JSON.stringify(value);
  assert.ok(!encoded.includes(secret));
  assert.ok(!encoded.includes(ref));
}
void test("legacy catalogue exposes exactly twelve new tools and complete bounded visibility without losing transfers", async () => {
  const f = await ordinaryMcpFixture();
  try {
    const tools = (await f.clients[0].client.listTools()).tools;
    assert.equal(tools.length, 109);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      MCP_CATALOGUE.map((t) => t.tool).sort(),
    );
    for (const name of names)
      assert.ok(
        tools.some((t) => t.name === tool(name)),
        name,
      );
    const visibleTools = tools.map((t) => t.name);
    for (const name of ["get_help", "get_capabilities"]) {
      const result = await f.ok(
        "owner",
        tool(name),
        { visibleTools },
        z.object({
          clientVisibility: z.object({
            status: z.literal("reported"),
            missingTools: z.array(z.string()).length(0),
          }),
        }),
      );
      assert.equal(result.clientVisibility.status, "reported");
      await f.denied("owner", tool(name), {
        visibleTools: [...visibleTools, "one-too-many"],
      });
    }
    assert.equal(MCP_ROUTE_EXCEPTIONS.length, 2);
    assert.deepEqual(MCP_PARTIAL_FILE_ROUTES, []);
    for (const name of [
      "begin_upload",
      "write_upload_chunk",
      "finish_upload",
      "cancel_upload",
      "begin_file_read",
      "read_file_chunk",
      "cancel_file_read",
      "list_file_transfers",
      "get_attachment_operation",
    ])
      assert.ok(tools.some((t) => t.name === tool(name)));
    for (const name of [
      "list_github_sources",
      "list_github_repositories",
      "verify_github_connection",
      "refresh_github_evidence",
    ])
      assert.equal(
        tools.find((t) => t.name === tool(name))?.annotations?.readOnlyHint,
        false,
      );
    for (const name of [
      "get_github_connection",
      "get_github_selection_status",
      "get_github_evidence_item",
      "get_github_evidence",
    ])
      assert.equal(
        tools.find((t) => t.name === tool(name))?.annotations?.readOnlyHint,
        true,
      );
  } finally {
    await f.close();
  }
});
void test("owner MCP discovers opaque tickets, pages, confirms target and recovers selection with exact original input", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    const { page, input } = await discover(f);
    noSecrets(page);
    assert.ok(page.nextCursor);
    const next = await f.ok(
      "owner",
      tool("list_github_repositories"),
      {
        projectId: f.project.id,
        sourceId: page.sourceId,
        cursor: page.nextCursor,
      },
      githubDiscoveryPageSchema,
    );
    assert.equal(next.nextCursor, null);
    await f.denied(
      "owner",
      tool("connect_github_selection"),
      { ...input, projectId: f.foreignProject.id },
      409,
    );
    const connection = await f.ok(
      "owner",
      tool("connect_github_selection"),
      input,
      githubConnectionSchema,
    );
    assert.equal(connection.mode, "authenticated");
    assert.equal(connection.permissionsVerified, false);
    assert.equal(connection.revision, 1);
    noSecrets(connection);
    const state = await f.ok(
      "owner",
      tool("get_github_selection_status"),
      input,
      githubSelectionStatusSchema,
    );
    assert.equal(state.matches, true);
    await f.denied("owner", tool("connect_github_selection"), input, 409);
    assert.deepEqual(p.calls, ["list:1", "list:2", "selection"]);
    const verified = await f.ok(
      "owner",
      tool("verify_github_connection"),
      { projectId: f.project.id, revision: 1, confirm: true },
      githubConnectionSchema,
    );
    assert.equal(verified.revision, 2);
    assert.ok(verified.lastVerifiedAt);
    await f.denied(
      "owner",
      tool("disconnect_github_connection"),
      { projectId: f.project.id, revision: 1, confirm: true },
      409,
    );
    const disconnected = await f.ok(
      "owner",
      tool("disconnect_github_connection"),
      { projectId: f.project.id, revision: 2, confirm: true },
      githubConnectionSchema,
    );
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.revision, 3);
  } finally {
    await f.close();
  }
});
void test("all connection capabilities retain HTTP owner-only authority; provider work never starts for denied agents", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    const { input } = await discover(f);
    const requests: [string, Record<string, unknown>][] = [
      ["list_github_sources", { projectId: f.project.id }],
      [
        "list_github_repositories",
        { projectId: f.project.id, sourceId: input.sourceId },
      ],
      ["connect_github_selection", input],
      ["get_github_selection_status", input],
      ["get_github_connection", { projectId: f.project.id }],
      [
        "set_github_connection",
        {
          projectId: f.project.id,
          repository,
          mode: "public",
          revision: 0,
          confirm: true,
        },
      ],
      [
        "verify_github_connection",
        { projectId: f.project.id, revision: 0, confirm: true },
      ],
      [
        "disconnect_github_connection",
        { projectId: f.project.id, revision: 0, confirm: true },
      ],
    ];
    for (const who of ["agent", "other", "read"])
      for (const [name, args] of requests)
        await f.denied(who, tool(name), args, 403);
    assert.deepEqual(p.calls, ["list:1"]);
    const status = await f.ok(
      "owner",
      tool("get_github_connection"),
      { projectId: f.project.id },
      githubConnectionSchema,
    );
    assert.equal(status.connected, false);
    const help = await f.ok(
      "agent",
      tool("get_help"),
      { tool: tool("list_github_repositories") },
      z.object({
        actions: z.array(z.object({ reason: z.literal("owner_required") })),
      }),
    );
    assert.equal(help.actions.length, 1);
  } finally {
    await f.close();
  }
});
void test("evidence MCP writes preserve scope, writer, current revisions and closed-issue guards without granting issue-close", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    await connect(f);
    const input = {
      issueId: f.issue.id,
      url: "https://github.com/octocat/selected/pull/1",
      issueRevision: f.issue.revision,
    };
    await f.denied("read", tool("add_github_evidence"), input, 403);
    await f.denied(
      "agent",
      tool("add_github_evidence"),
      { ...input, issueId: f.foreignIssue.id },
      403,
    );
    await f.denied(
      "agent",
      tool("add_github_evidence"),
      { ...input, issueRevision: 999 },
      409,
    );
    const evidence = await f.ok(
      "agent",
      tool("add_github_evidence"),
      input,
      githubEvidenceSchema,
    );
    const duplicate = await f.ok(
      "agent",
      tool("add_github_evidence"),
      input,
      githubEvidenceSchema,
    );
    assert.equal(duplicate.id, evidence.id);
    assert.deepEqual(
      await f.ok(
        "read",
        tool("get_github_evidence_item"),
        { evidenceId: evidence.id },
        githubEvidenceSchema,
      ),
      evidence,
    );
    assert.equal(
      (
        await f.ok(
          "read",
          tool("get_github_evidence"),
          { issueId: f.issue.id },
          githubEvidenceSchema.array(),
        )
      ).length,
      1,
    );
    for (const name of ["refresh_github_evidence", "remove_github_evidence"])
      await f.denied(
        "read",
        tool(name),
        { evidenceId: evidence.id, revision: 1 },
        403,
      );
    await f.denied(
      "agent",
      tool("refresh_github_evidence"),
      { evidenceId: evidence.id, revision: 999 },
      409,
    );
    assert.deepEqual(p.calls, []);
    const refreshed = await f.ok(
      "agent",
      tool("refresh_github_evidence"),
      { evidenceId: evidence.id, revision: 1 },
      githubEvidenceSchema,
    );
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.snapshot?.ci, "success");
    assert.deepEqual(p.calls, ["inspect"]);
    const issue = await f.ok(
      "owner",
      "sticker_update_issue",
      { issueId: f.issue.id, revision: f.issue.revision, status: "closed" },
      z.object({ status: z.literal("closed") }),
    );
    assert.equal(issue.status, "closed");
    for (const name of ["refresh_github_evidence", "remove_github_evidence"])
      await f.denied(
        "agent",
        tool(name),
        { evidenceId: evidence.id, revision: 2 },
        403,
      );
    await f.denied(
      "owner",
      tool("remove_github_evidence"),
      { evidenceId: evidence.id, revision: 1 },
      409,
    );
    await f.ok(
      "owner",
      tool("remove_github_evidence"),
      { evidenceId: evidence.id, revision: 2 },
      z.object({ ok: z.literal(true) }),
    );
    assert.deepEqual(
      await f.ok(
        "owner",
        tool("get_github_evidence"),
        { issueId: f.issue.id },
        githubEvidenceSchema.array(),
      ),
      [],
    );
    assert.deepEqual(p.calls, ["inspect"]);
  } finally {
    await f.close();
  }
});
void test("custom compatibility input remains strict and shared refinements reject token fields and inconsistent credential modes", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    const input = {
      projectId: f.project.id,
      repository,
      mode: "public",
      revision: 0,
      confirm: true,
    };
    for (const invalid of [
      { ...input, token: secret },
      { ...input, credentialRef: ref },
      { ...input, mode: "authenticated" },
      { ...input, confirm: false },
      { ...input, operationId: "invented" },
    ])
      await f.denied("owner", tool("set_github_connection"), invalid);
    const state = await f.ok(
      "owner",
      tool("get_github_connection"),
      { projectId: f.project.id },
      githubConnectionSchema,
    );
    assert.equal(state.revision, 0);
    await connect(f);
    await f.denied("owner", tool("set_github_connection"), input, 409);
    assert.deepEqual(p.calls, []);
  } finally {
    await f.close();
  }
});
void test("provider failure is sanitized and durable verification/refresh errors stay explicit state", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    const { input } = await discover(f);
    p.fail();
    const failure = await f.invoke("owner", tool("list_github_repositories"), {
      projectId: f.project.id,
      sourceId: input.sourceId,
    });
    assert.equal(failure.isError, true);
    noSecrets(failure);
    await connect(f);
    const verified = await f.ok(
      "owner",
      tool("verify_github_connection"),
      { projectId: f.project.id, revision: 1, confirm: true },
      githubConnectionSchema,
    );
    assert.equal(verified.lastErrorCode, "NETWORK");
    assert.equal(verified.revision, 2);
    noSecrets(verified);
    const evidence = await f.ok(
      "agent",
      tool("add_github_evidence"),
      {
        issueId: f.issue.id,
        url: "https://github.com/octocat/selected/pull/2",
        issueRevision: 1,
      },
      githubEvidenceSchema,
    );
    const refreshed = await f.ok(
      "agent",
      tool("refresh_github_evidence"),
      { evidenceId: evidence.id, revision: 1 },
      githubEvidenceSchema,
    );
    assert.equal(refreshed.errorCode, "FORBIDDEN");
    assert.equal(refreshed.stale, true);
    assert.equal(refreshed.revision, 2);
    noSecrets(refreshed);
  } finally {
    await f.close();
  }
});
void test("lost selection response never resends; exact status proves the accepted target", async () => {
  const p = fixture(),
    f = await p.create(),
    original = globalThis.fetch;
  try {
    const { input } = await discover(f);
    let dispatched = 0;
    globalThis.fetch = async (request, init) => {
      const response = await original(request, init);
      if (
        (typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url) ===
        `${f.apiUrl}/api/projects/${f.project.id}/github/select`
      ) {
        dispatched++;
        await response.arrayBuffer();
        throw new Error("synthetic lost response");
      }
      return response;
    };
    const result = await f.invoke(
      "owner",
      tool("connect_github_selection"),
      input,
    );
    assert.equal(result.isError, true);
    const recovery = z
      .object({
        outcome: z.literal("uncertain"),
        retryable: z.literal(false),
        readback: z.literal("sticker_get_github_selection_status"),
      })
      .parse(data(result));
    assert.equal(recovery.retryable, false);
    assert.equal(dispatched, 1);
    globalThis.fetch = original;
    const state = await f.ok(
      "owner",
      tool("get_github_selection_status"),
      input,
      githubSelectionStatusSchema,
    );
    assert.equal(state.matches, true);
    assert.deepEqual(p.calls, ["list:1", "selection"]);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("lost source-ticket GET response is an uncertain ephemeral write, never falsely before dispatch", async () => {
  const p = fixture(),
    f = await p.create(),
    original = globalThis.fetch;
  let dispatched = 0;
  try {
    globalThis.fetch = async (request, init) => {
      const response = await original(request, init);
      if (
        (typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url) ===
        `${f.apiUrl}/api/projects/${f.project.id}/github/sources`
      ) {
        dispatched++;
        await response.arrayBuffer();
        throw new DOMException(
          "synthetic timeout after issuing tickets",
          "TimeoutError",
        );
      }
      return response;
    };
    const result = await f.invoke("owner", tool("list_github_sources"), {
      projectId: f.project.id,
    });
    assert.equal(result.isError, true);
    const recovery = z
      .object({
        phase: z.literal("after_dispatch"),
        outcome: z.literal("uncertain"),
        retryable: z.literal(false),
        readback: z.literal("sticker_get_github_connection"),
      })
      .parse(data(result));
    assert.equal(recovery.phase, "after_dispatch");
    assert.equal(dispatched, 1);
    assert.deepEqual(p.calls, []);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("evidence ID reads and writes reject another project even with a valid revision", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    await f.ok(
      "owner",
      tool("set_github_connection"),
      {
        projectId: f.foreignProject.id,
        repository,
        mode: "public",
        revision: 0,
        confirm: true,
      },
      githubConnectionSchema,
    );
    const foreign = await f.ok(
      "owner",
      tool("add_github_evidence"),
      {
        issueId: f.foreignIssue.id,
        url: "https://github.com/octocat/selected/pull/1",
        issueRevision: f.foreignIssue.revision,
      },
      githubEvidenceSchema,
    );
    for (const who of ["agent", "read", "other"]) {
      await f.denied(
        who,
        tool("get_github_evidence_item"),
        { evidenceId: foreign.id },
        403,
      );
      for (const name of ["remove_github_evidence", "refresh_github_evidence"])
        await f.denied(
          who,
          tool(name),
          { evidenceId: foreign.id, revision: foreign.revision },
          403,
        );
    }
    assert.deepEqual(p.calls, []);
    assert.equal(
      (
        await f.ok(
          "owner",
          tool("get_github_evidence_item"),
          { evidenceId: foreign.id },
          githubEvidenceSchema,
        )
      ).revision,
      1,
    );
  } finally {
    await f.close();
  }
});
void test("lost evidence add response gives readback and never invents an operation-key replay", async () => {
  const p = fixture(),
    f = await p.create(),
    original = globalThis.fetch;
  let dispatched = 0;
  try {
    await connect(f);
    const input = {
      issueId: f.issue.id,
      url: "https://github.com/octocat/selected/pull/4",
      issueRevision: 1,
    };
    globalThis.fetch = async (request, init) => {
      const response = await original(request, init);
      if (
        (typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url) ===
          `${f.apiUrl}/api/issues/${f.issue.id}/github-evidence` &&
        init?.method === "POST"
      ) {
        dispatched++;
        await response.arrayBuffer();
        throw new Error("synthetic dropped committed evidence response");
      }
      return response;
    };
    const result = await f.invoke("agent", tool("add_github_evidence"), input);
    assert.equal(result.isError, true);
    z.object({
      outcome: z.literal("uncertain"),
      retryable: z.literal(false),
      readback: z.literal("sticker_get_github_evidence"),
    }).parse(data(result));
    assert.equal(dispatched, 1);
    globalThis.fetch = original;
    const list = await f.ok(
      "agent",
      tool("get_github_evidence"),
      { issueId: f.issue.id },
      githubEvidenceSchema.array(),
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].url, input.url);
    assert.deepEqual(p.calls, []);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("expired owner session denies legacy capabilities without falling back to agent or provider access", async () => {
  const p = fixture(),
    f = await p.create();
  try {
    await f.ok(
      "owner",
      "sticker_end_owner_session",
      { confirm: true },
      z.unknown(),
    );
    await f.denied(
      "owner",
      tool("list_github_sources"),
      { projectId: f.project.id },
      401,
    );
    await f.denied(
      "owner",
      tool("set_github_connection"),
      {
        projectId: f.project.id,
        repository,
        mode: "public",
        revision: 0,
        confirm: true,
      },
      401,
    );
    assert.deepEqual(p.calls, []);
  } finally {
    await f.close();
  }
});
void test("finish upload authorization HEAD timeout stays before dispatch with zero POST", async () => {
  const f = await ordinaryMcpFixture(),
    original = globalThis.fetch;
  const checksum = createHash("sha256").update("x").digest("hex"),
    operationId = randomUUID();
  let posts = 0,
    heads = 0;
  try {
    const { handle } = await f.ok(
      "owner",
      "sticker_begin_upload",
      {
        target: { kind: "issue_attachment", issueId: f.issue.id },
        name: "synthetic.bin",
        size: 1,
        checksum,
        operationId,
      },
      z.object({ handle: z.string() }),
    );
    await f.ok(
      "owner",
      "sticker_write_upload_chunk",
      {
        handle,
        offset: 0,
        base64: Buffer.from("x").toString("base64"),
        checksum,
      },
      z.unknown(),
    );
    globalThis.fetch = async (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (url === `${f.apiUrl}/api/issues/${f.issue.id}/attachments`) {
        if (init?.method === "POST") posts++;
        if (init?.method === "HEAD") {
          heads++;
          throw new DOMException("synthetic preflight timeout", "TimeoutError");
        }
      }
      return original(request, init);
    };
    const result = await f.invoke("owner", "sticker_finish_upload", {
      handle,
      operationId,
      checksum,
    });
    assert.equal(result.isError, true);
    assert.equal(posts, 0);
    assert.equal(heads, 1);
    const error = z
      .object({
        phase: z.literal("before_dispatch"),
        retry: z.literal("before_dispatch"),
        retryable: z.literal(true),
        outcome: z.undefined().optional(),
      })
      .parse(data(result));
    assert.equal(error.outcome, undefined);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("owner authentication GET failure does not dispatch ticket issuance", async () => {
  const f = await ordinaryMcpFixture(),
    original = globalThis.fetch;
  let dispatched = 0;
  try {
    globalThis.fetch = async (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (url.endsWith("/github/sources")) dispatched++;
      if (url.endsWith("/api/access-mode"))
        throw new DOMException("synthetic auth timeout", "TimeoutError");
      return original(request, init);
    };
    const result = await f.invoke("owner", tool("list_github_sources"), {
      projectId: f.project.id,
    });
    assert.equal(result.isError, true);
    z.object({
      phase: z.literal("before_dispatch"),
      retryable: z.literal(true),
      outcome: z.undefined().optional(),
    }).parse(data(result));
    assert.equal(dispatched, 0);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("selection status POST lost response remains a read without uncertain-write metadata", async () => {
  const p = fixture(),
    f = await p.create(),
    original = globalThis.fetch;
  let dispatched = 0;
  try {
    const { input } = await discover(f);
    globalThis.fetch = async (request, init) => {
      const response = await original(request, init);
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (url.endsWith("/github/selection-status")) {
        dispatched++;
        await response.arrayBuffer();
        throw new DOMException("synthetic status timeout", "TimeoutError");
      }
      return response;
    };
    const result = await f.invoke(
      "owner",
      tool("get_github_selection_status"),
      input,
    );
    assert.equal(result.isError, true);
    z.object({
      retry: z.literal("safe_read"),
      retryable: z.literal(true),
      outcome: z.undefined().optional(),
    }).parse(data(result));
    assert.equal(dispatched, 1);
    assert.deepEqual(p.calls, ["list:1"]);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
void test("local upload bookkeeping auth failure retains local readback without uncertain write", async () => {
  const f = await ordinaryMcpFixture(),
    original = globalThis.fetch;
  try {
    globalThis.fetch = (request, init) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (url.endsWith("/api/access-mode"))
        return Promise.reject(
          new DOMException("synthetic local auth timeout", "TimeoutError"),
        );
      return original(request, init);
    };
    const result = await f.invoke("owner", "sticker_begin_upload", {
      target: { kind: "issue_attachment", issueId: f.issue.id },
      name: "synthetic.bin",
      size: 1,
      checksum: createHash("sha256").update("x").digest("hex"),
      operationId: randomUUID(),
    });
    assert.equal(result.isError, true);
    z.object({
      phase: z.literal("before_dispatch"),
      retry: z.literal("readback"),
      retryable: z.literal(false),
      outcome: z.undefined().optional(),
      readback: z.literal("sticker_list_file_transfers"),
    }).parse(data(result));
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});
