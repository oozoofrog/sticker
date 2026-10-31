import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  sessionEventResultSchema,
  sessionDetailSchema,
  sessionRequestSchema,
} from "../server/contracts/sessions.js";
function content<T>(result: unknown, schema: z.ZodType<T>): T {
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
void test("official SDK session tools use authoritative API authorization, dedup events and retain owner-only response and closure authority", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "session-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "sticker_list_sessions",
      "sticker_get_session",
      "sticker_report_session_event",
      "sticker_list_pending_requests",
    ])
      assert.ok(tools.includes(name));
    assert.ok(tools.includes("sticker_respond_to_request"));
    assert.ok(tools.includes("sticker_close_session"));
    assert.ok(!tools.some((name) => /approve|execute/.test(name)));
    const input = {
      projectId: f.project.id,
      issueId: f.issue.id,
      externalSessionId: "mcp-run",
      eventId: "q",
      kind: "request",
      requestKind: "input",
      message: "질문",
    };
    const event = content(
      await client.callTool({
        name: "sticker_report_session_event",
        arguments: input,
      }),
      sessionEventResultSchema,
    );
    const retry = content(
      await client.callTool({
        name: "sticker_report_session_event",
        arguments: input,
      }),
      sessionEventResultSchema,
    );
    assert.equal(retry.event.eventId, event.event.eventId);
    assert.ok(event.request);
    assert.equal(
      (
        await client.callTool({
          name: "sticker_respond_to_request",
          arguments: {
            requestId: event.request.id,
            revision: 1,
            operationId: "00000000-0000-4000-8000-000000000001",
            body: "cannot impersonate owner",
          },
        })
      ).isError,
      true,
    );
    const detail = content(
      await client.callTool({
        name: "sticker_get_session",
        arguments: { sessionId: event.session.id },
      }),
      sessionDetailSchema,
    );
    assert.equal(detail.events.length, 1);
    assert.equal(
      content(
        await client.callTool({
          name: "sticker_list_pending_requests",
          arguments: {},
        }),
        sessionRequestSchema.array(),
      ).length,
      1,
    );
    const denied = await client.callTool({
      name: "sticker_report_session_event",
      arguments: { ...input, projectId: f.other.id, issueId: f.foreign.id },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      content(denied, z.object({ code: z.string() })).code,
      "PROJECT_SCOPE",
    );
    const mismatch = await client.callTool({
      name: "sticker_report_session_event",
      arguments: { ...input, message: "충돌" },
    });
    assert.equal(mismatch.isError, true);
    assert.equal(
      content(mismatch, z.object({ code: z.string() })).code,
      "EVENT_CONFLICT",
    );
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
