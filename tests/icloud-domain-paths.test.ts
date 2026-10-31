import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture, sessionOwner } from "./session-fixture.js";
import {
  attach,
  FixtureClock,
  MemoryTransport,
} from "./fixtures/icloud/outbox-fixture.js";

void test("real HTTP and MCP issue edits share atomic history/outbox capture and automatic fake delivery", async () => {
  const f = await sessionHttpFixture();
  const clock = new FixtureClock(),
    transport = new MemoryTransport();
  const cloud = attach(f.instance.store, clock, transport);
  const server = createStickerMcp(f.base, f.tokens.agent);
  const client = new Client({ name: "icloud-synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const http = await f.call(`/issues/${f.issue.id}`, "owner", "PATCH", {
      revision: 1,
      title: "HTTP title",
    });
    assert.equal(http.status, 200);
    await clock.settle();
    assert.equal(cloud.outbox.status().acknowledged, 1);
    const mcp = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: f.issue.id, revision: 2, description: "MCP body" },
    });
    assert.notEqual(mcp.isError, true);
    await clock.settle();
    assert.equal(cloud.outbox.status().acknowledged, 2);
    const records = [...transport.records.values()].map(
      (record) => record.envelope,
    );
    assert.deepEqual(
      records.map((record) => record.content),
      [
        { title: "HTTP title", description: "" },
        { title: "HTTP title", description: "MCP body" },
      ],
    );
    assert.deepEqual(
      records.map((record) => [record.baseRevision, record.revision]),
      [
        [1, 2],
        [2, 3],
      ],
    );
    assert.equal(
      f.instance.store.history.list(sessionOwner, f.issue.id).length,
      3,
    );
    const denied = await client.callTool({
      name: "sticker_update_issue",
      arguments: { issueId: f.foreign.id, revision: 1, title: "foreign" },
    });
    assert.equal(denied.isError, true);
    const stale = await f.call(`/issues/${f.issue.id}`, "owner", "PATCH", {
      revision: 1,
      title: "stale",
    });
    assert.equal(stale.status, 409);
    assert.equal(cloud.outbox.status().acknowledged, 2);
    const serialized = JSON.stringify(records);
    for (const secret of Object.values(f.tokens))
      assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("authorId"), false);
  } finally {
    cloud.stop();
    await client.close();
    await server.close();
    await f.close();
  }
});

void test("HTTP capture failure returns an error and leaves original content/history intact", async () => {
  const f = await sessionHttpFixture();
  const clock = new FixtureClock(),
    transport = new MemoryTransport();
  const cloud = attach(f.instance.store, clock, transport);
  try {
    cloud.db.exec(
      "CREATE TRIGGER refuse_cloud BEFORE INSERT ON fixture_cloud_outbox BEGIN SELECT RAISE(ABORT,'capture unavailable'); END",
    );
    const response = await f.call(`/issues/${f.issue.id}`, "owner", "PATCH", {
      revision: 1,
      title: "must rollback",
    });
    assert.equal(response.status, 500);
    assert.equal(
      f.instance.store.getIssue(sessionOwner, f.issue.id).issue.title,
      "입력 요청",
    );
    assert.equal(
      f.instance.store.history.list(sessionOwner, f.issue.id).length,
      1,
    );
    await clock.settle();
    assert.equal(transport.records.size, 0);
  } finally {
    cloud.stop();
    await f.close();
  }
});
