import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import { sessionHttpFixture, sessionOwner } from "./session-fixture.js";
import { githubEvidenceSchema } from "../server/contracts/github.js";
void test("MCP reads the same authorized cached GitHub evidence without external fetch or write tools", async () => {
  let calls = 0;
  const f = await sessionHttpFixture({
      enabled: true,
      client: () => ({
        verify: () => {
          calls++;
          return Promise.resolve();
        },
        inspect: () => {
          calls++;
          return Promise.reject(new Error("no reads expected"));
        },
      }),
    }),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "github-fixture", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    f.instance.store.github.connect(sessionOwner, f.project.id, {
      repository: { owner: "octocat", name: "project" },
      mode: "public",
      revision: 0,
      confirm: true,
    });
    const e = f.instance.store.github.add(sessionOwner, f.issue.id, {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    });
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "sticker_get_github_evidence",
    );
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const result = z
      .object({ content: z.array(z.object({ text: z.string() })) })
      .parse(
        await client.callTool({
          name: "sticker_get_github_evidence",
          arguments: { issueId: f.issue.id },
        }),
      );
    const input: unknown = JSON.parse(result.content[0].text);
    assert.deepEqual(githubEvidenceSchema.array().parse(input), [e]);
    assert.equal(
      (
        await client.callTool({
          name: "sticker_get_github_evidence",
          arguments: { issueId: f.foreign.id },
        })
      ).isError,
      true,
    );
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
