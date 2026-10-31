import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import {
  sessionHttpFixture,
  sessionOwner as owner,
} from "./session-fixture.js";
import {
  readinessSchema,
  changelogSchema,
} from "../server/contracts/releases.js";
function content<T>(result: unknown, schema: z.ZodType<T>) {
  const envelope = z
    .object({
      content: z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .min(1),
    })
    .parse(result);
  const raw: unknown = JSON.parse(envelope.content[0].text);
  return schema.parse(raw);
}
void test("MCP reads exact HTTP readiness and saved draft under project scope, with an owner-only release tool and no generic transition bypass", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "release-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const v = f.instance.store.createVersion(owner, {
        projectId: f.project.id,
        name: "v1",
      }),
      foreign = f.instance.store.createVersion(owner, {
        projectId: f.other.id,
        name: "secret",
      });
    f.instance.store.updateIssue(owner, f.issue.id, {
      revision: 1,
      targetVersionId: v.id,
    });
    const tools = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes("sticker_get_version_readiness"));
    assert.ok(tools.includes("sticker_release_version"));
    assert.equal(
      (
        await client.callTool({
          name: "sticker_release_version",
          arguments: {
            versionId: v.id,
            revision: 1,
            operationId: "00000000-0000-4000-8000-000000000001",
            confirm: true,
          },
        })
      ).isError,
      true,
    );
    const read = content(
      await client.callTool({
        name: "sticker_get_version_readiness",
        arguments: { versionId: v.id },
      }),
      readinessSchema,
    );
    assert.deepEqual(read, f.instance.store.releases.readiness(owner, v.id));
    const draft = content(
      await client.callTool({
        name: "sticker_get_version_changelog",
        arguments: { versionId: v.id },
      }),
      changelogSchema,
    );
    assert.equal(draft.revision, 0);
    assert.equal(
      (
        await client.callTool({
          name: "sticker_get_version_readiness",
          arguments: { versionId: foreign.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "sticker_update_version",
          arguments: { versionId: v.id, revision: 1, state: "released" },
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
