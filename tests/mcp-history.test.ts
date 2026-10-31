import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  historyListSchema,
  historyDetailSchema,
} from "../server/contracts/history.js";
void test("MCP edits produce the same field history; comparison tools are read-only and owner-only restore preserves agent restrictions", async () => {
  const f = await sessionHttpFixture();
  const server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "history-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of [
      "sticker_list_issue_history",
      "sticker_get_issue_change",
    ]) {
      assert.equal(
        tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
        true,
      );
    }
    assert.equal(
      tools.find((tool) => tool.name === "sticker_preview_issue_restore")
        ?.annotations?.readOnlyHint,
      true,
    );
    assert.equal(
      tools.find((tool) => tool.name === "sticker_restore_issue_fields")
        ?.annotations?.readOnlyHint,
      false,
    );
    const updated = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: f.issue.id, revision: 1, title: "MCP edit" },
    });
    assert.notEqual(updated.isError, true);
    const decode = (value: unknown): unknown => {
      const result = z
        .object({ content: z.array(z.object({ text: z.string() })) })
        .parse(value);
      return JSON.parse(result.content[0].text);
    };
    const list = historyListSchema.parse(
      decode(
        await client.callTool({
          name: "sticker_list_issue_history",
          arguments: { issueId: f.issue.id },
        }),
      ),
    );
    const summary = list.find((entry) => entry.action === "updated");
    assert.ok(summary);
    const detail = historyDetailSchema.parse(
      decode(
        await client.callTool({
          name: "sticker_get_issue_change",
          arguments: { issueId: f.issue.id, changeId: summary.id },
        }),
      ),
    );
    assert.deepEqual(detail.changes, [
      { field: "title", before: f.issue.title, after: "MCP edit" },
    ]);
    assert.equal(detail.authorId, "agent");
    assert.equal(
      (
        await client.callTool({
          name: "sticker_list_issue_history",
          arguments: { issueId: f.foreign.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "sticker_get_issue_change",
          arguments: { issueId: f.foreign.id, changeId: summary.id },
        })
      ).isError,
      true,
    );
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
