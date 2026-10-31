// Reverse STDIO transport: connected by anonymous container stdin/stdout to the
// real `docker compose run ... mcp` process. STDOUT is protocol-only.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
const lines = createInterface({ input: process.stdin });
const transport = {
  async start() {
    lines.on("line", (line) => {
      try {
        this.onmessage?.(JSON.parse(line));
      } catch (error) {
        this.onerror?.(error);
      }
    });
  },
  async send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  },
  async close() {
    lines.close();
    this.onclose?.();
  },
};
const timeout = setTimeout(() => {
  console.error("Container MCP smoke timed out");
  process.exit(1);
}, 30_000);
const client = new Client({
  name: "sticker-container-fixture",
  version: "1.0.0",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(({ name }) => name === "sticker_list_projects"));
  const result = await client.callTool({
    name: "sticker_list_projects",
    arguments: {},
  });
  assert.ok(!result.isError, "Configured read-only agent must authenticate");
  const projects = JSON.parse(result.content[0].text);
  assert.deepEqual(projects.map((p) => p.name).sort(), [
    "Container template fixture",
    "Portable fixture",
  ]);
  for (const name of [
    "sticker_preview_issue_restore",
    "sticker_restore_issue_fields",
  ])
    assert.ok(tools.tools.some((tool) => tool.name === name));
  const helpResult = await client.callTool({
    name: "sticker_get_help",
    arguments: { tool: "sticker_restore_issue_fields" },
  });
  assert.ok(!helpResult.isError);
  const [restoreHelp] = JSON.parse(helpResult.content[0].text).actions;
  assert.equal(restoreHelp.authority, "owner");
  assert.equal(restoreHelp.availability, "permission_needed");
  assert.equal(restoreHelp.reason, "owner_required");
  const historyIssues = await client.callTool({
    name: "sticker_list_issues",
    arguments: { query: "Container history fixture" },
  });
  assert.ok(!historyIssues.isError);
  const issue = JSON.parse(historyIssues.content[0].text).find(
    (value) => value.title === "Container history fixture",
  );
  assert.ok(issue);
  const historyResult = await client.callTool({
    name: "sticker_list_issue_history",
    arguments: { issueId: issue.id },
  });
  assert.ok(!historyResult.isError);
  const restored = JSON.parse(historyResult.content[0].text).find(
    (value) => value.action === "restored",
  );
  assert.ok(restored);
  const comparison = await client.callTool({
    name: "sticker_get_issue_change",
    arguments: { issueId: issue.id, changeId: restored.id },
  });
  assert.ok(!comparison.isError);
  assert.deepEqual(JSON.parse(comparison.content[0].text).changes, [
    {
      field: "description",
      before: "Changed history body",
      after: "Original history body",
    },
  ]);
  const beforeRestore = await client.callTool({
    name: "sticker_get_issue",
    arguments: { issueId: issue.id },
  });
  assert.ok(!beforeRestore.isError);
  const currentIssue = JSON.parse(beforeRestore.content[0].text).issue;
  const restoreInput = {
    issueId: issue.id,
    changeId: restored.id,
    side: "before",
    fields: ["description"],
    revision: currentIssue.revision,
  };
  for (const [name, extra] of [
    ["sticker_preview_issue_restore", {}],
    [
      "sticker_restore_issue_fields",
      { operationId: "87000000-0000-4000-8000-000000000019" },
    ],
  ]) {
    const refused = await client.callTool({
      name,
      arguments: { ...restoreInput, ...extra },
    });
    assert.equal(refused.isError, true, `${name} must deny a read-only agent`);
    assert.equal(JSON.parse(refused.content[0].text).status, 403);
  }
  const afterRestore = await client.callTool({
    name: "sticker_get_issue",
    arguments: { issueId: issue.id },
  });
  assert.ok(!afterRestore.isError);
  assert.deepEqual(afterRestore.content, beforeRestore.content);
  const unchangedHistory = await client.callTool({
    name: "sticker_list_issue_history",
    arguments: { issueId: issue.id },
  });
  assert.ok(!unchangedHistory.isError);
  assert.deepEqual(unchangedHistory.content, historyResult.content);
  const denied = await client.callTool({
    name: "sticker_create_issue",
    arguments: { projectId: projects[0].id, title: "Read-only must refuse" },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).status, 403);
  console.error(
    "Container MCP smoke passed: initialize, tools, authenticated history comparison, discovered owner-only restore denial and unchanged data",
  );
} finally {
  clearTimeout(timeout);
  await client.close();
  process.stdin.destroy();
}
