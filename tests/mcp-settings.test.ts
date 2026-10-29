import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  mcpSettingsFixture,
  mcpSettingsPassword,
} from "./mcp-settings-fixture.js";
import {
  bootstrapSchema,
  projectSchema,
  issueDetailSchema,
  apiErrorSchema,
} from "../server/response-schemas.js";
import { mcpSettingsSchema } from "../server/contracts/mcp-settings.js";

void test("MCP settings are owner-only even for writable all-project agents", async () => {
  const f = await mcpSettingsFixture();
  try {
    assert.equal((await f.request("/mcp/settings", "anonymous")).status, 401);
    for (const who of ["read", "write", "all", "none", "missing"] as const)
      assert.equal((await f.request("/mcp/settings", who)).status, 403, who);
    assert.equal((await f.request("/mcp/settings")).status, 200);
    assert.equal(
      (await f.request("/mcp/settings", "owner", "POST")).status,
      404,
    );
  } finally {
    await f.close();
  }
});

void test("MCP settings project only current safe grants and never equate configuration with verified connectivity", async () => {
  const f = await mcpSettingsFixture();
  try {
    const response = await f.request("/mcp/settings");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(!body.includes("tokenHash"));
    assert.ok(!body.includes(mcpSettingsPassword));
    for (const token of Object.values(f.tokens))
      assert.ok(!body.includes(token));
    for (const grant of f.agents) assert.ok(!body.includes(grant.tokenHash));
    assert.deepEqual(JSON.parse(body), {
      transport: "stdio",
      application: "manual",
      verification: "unknown",
      tokenEnvironmentVariable: "STICKER_AGENT_TOKEN",
      agents: [
        {
          id: "read",
          name: "설정 read",
          canWrite: false,
          projectIds: [f.project.id],
        },
        {
          id: "write",
          name: "설정 write",
          canWrite: true,
          projectIds: [f.project.id],
        },
        { id: "all", name: "설정 all", canWrite: true, projectIds: null },
        { id: "none", name: "설정 none", canWrite: false, projectIds: [] },
        {
          id: "missing",
          name: "설정 missing",
          canWrite: false,
          projectIds: ["deleted-project-id"],
        },
      ],
    });
    assert.deepEqual(
      bootstrapSchema
        .parse(await (await f.request("/bootstrap")).json())
        .issues.map((issue) => issue.id),
      [f.issue.id],
    );
  } finally {
    await f.close();
  }
});

void test("MCP settings distinguish no configured credentials from unknown client connectivity", async () => {
  const f = await mcpSettingsFixture(false);
  try {
    const response = await f.request("/mcp/settings");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      transport: "stdio",
      application: "manual",
      verification: "unknown",
      tokenEnvironmentVariable: "STICKER_AGENT_TOKEN",
      agents: [],
    });
  } finally {
    await f.close();
  }
});

void test(
  "safe configured scope agrees with actual SDK STDIO reads and write denial without claiming a Codex connection",
  { timeout: 20_000 },
  async () => {
    const f = await mcpSettingsFixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "server/mcp.ts"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        STICKER_API_URL: f.base,
        STICKER_AGENT_TOKEN: f.tokens.read,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "settings-readonly-fixture",
      version: "1.0.0",
    });
    const textResult = (value: unknown): unknown => {
      const envelope = z
        .object({
          content: z
            .array(z.object({ type: z.literal("text"), text: z.string() }))
            .min(1),
        })
        .parse(value);
      return JSON.parse(envelope.content[0].text);
    };
    try {
      const status = mcpSettingsSchema.parse(
        await (await f.request("/mcp/settings")).json(),
      );
      assert.deepEqual(
        status.agents.find((agent) => agent.id === "read")?.projectIds,
        [f.project.id],
      );
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((tool) => tool.name === "sticker_list_projects"),
      );
      assert.ok(
        !tools.tools.some((tool) => tool.name === "sticker_get_mcp_settings"),
      );
      const listed = await client.callTool({
        name: "sticker_list_projects",
        arguments: {},
      });
      assert.ok(!listed.isError);
      const projects = projectSchema.array().parse(textResult(listed));
      assert.deepEqual(
        projects.map((project) => project.id),
        [f.project.id],
      );
      assert.ok(!JSON.stringify(projects).includes(f.other.id));
      const detail = await client.callTool({
        name: "sticker_get_issue",
        arguments: { issueId: f.issue.id },
      });
      assert.ok(!detail.isError);
      assert.equal(
        issueDetailSchema.parse(textResult(detail)).issue.title,
        "MCP 읽기 검증",
      );
      const denied = await client.callTool({
        name: "sticker_create_issue",
        arguments: { projectId: f.project.id, title: "읽기 권한 쓰기 거부" },
      });
      assert.equal(denied.isError, true);
      const error = apiErrorSchema
        .extend({ status: z.number() })
        .parse(textResult(denied));
      assert.equal(error.status, 403);
      assert.equal(error.code, "READ_ONLY");
      const after = mcpSettingsSchema.parse(
        await (await f.request("/mcp/settings")).json(),
      );
      assert.equal(after.verification, "unknown");
      assert.equal(
        bootstrapSchema.parse(await (await f.request("/bootstrap")).json())
          .issues.length,
        1,
      );
    } finally {
      await client.close();
      await f.close();
    }
  },
);
