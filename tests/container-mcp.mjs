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
  assert.equal(
    tools.tools.some(({ name }) => name.includes("restore")),
    false,
  );
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
  const denied = await client.callTool({
    name: "sticker_create_issue",
    arguments: { projectId: projects[0].id, title: "Read-only must refuse" },
  });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).status, 403);
  console.error(
    "Container MCP smoke passed: initialize, tools, authenticated history comparison, read-only denial",
  );
} finally {
  clearTimeout(timeout);
  await client.close();
  process.stdin.destroy();
}
