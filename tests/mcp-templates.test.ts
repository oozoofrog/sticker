import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStickerMcp } from "../server/mcp.js";
import {
  sessionHttpFixture,
  sessionOwner as owner,
} from "./session-fixture.js";
import {
  issueTemplateSchema,
  templateDetailSchema,
  templatePreviewSchema,
  validateTemplateValues,
} from "../server/contracts/templates.js";
import { issueSchema } from "../server/response-schemas.js";
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
void test("official MCP template reads, preview and normal create share exact validation, provenance, UUID dedup and scope", async () => {
  const f = await sessionHttpFixture();
  const template = f.instance.store.templates.create(owner, {
    projectId: f.project.id,
    name: "MCP 작업",
    body: "## 작업",
    requiredFields: ["input", "verification"],
    defaults: { priority: "high", assignee: "agent" },
    operationId: randomUUID(),
  });
  const foreign = f.instance.store.templates.create(owner, {
    projectId: f.other.id,
    name: "외부",
    body: "외부 본문",
    requiredFields: [],
    defaults: {},
    operationId: randomUUID(),
  });
  const server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "template-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of [
      "sticker_list_issue_templates",
      "sticker_get_issue_template",
      "sticker_preview_issue_template",
    ])
      assert.ok(tools.some((tool) => tool.name === name));
    assert.equal(
      tools.some((tool) =>
        /sticker_(create|delete|update)_.*template/.test(tool.name),
      ),
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "sticker_delete_issue_template",
          arguments: { templateId: template.template.id, revision: 1 },
        })
      ).isError,
      true,
    );
    const list = data(
      await client.callTool({
        name: "sticker_list_issue_templates",
        arguments: { projectId: f.project.id },
      }),
      issueTemplateSchema.array(),
    );
    assert.equal(list[0].id, template.template.id);
    const detail = data(
      await client.callTool({
        name: "sticker_get_issue_template",
        arguments: { templateId: template.template.id },
      }),
      templateDetailSchema,
    );
    assert.equal(detail.selectedVersion.version, 1);
    const preview = data(
      await client.callTool({
        name: "sticker_preview_issue_template",
        arguments: { templateId: template.template.id, values: {} },
      }),
      templatePreviewSchema,
    );
    assert.deepEqual(
      preview.errors,
      validateTemplateValues(["input", "verification"], {}),
    );
    const input = {
      projectId: f.project.id,
      title: "같은 생성 경로",
      templateId: template.template.id,
      templateVersion: 1,
      templateValues: {},
      operationId: randomUUID(),
    };
    const missing = await client.callTool({
      name: "sticker_create_issue",
      arguments: input,
    });
    assert.equal(missing.isError, true);
    const error = data(
      missing,
      z.object({
        code: z.string(),
        status: z.number(),
        fields: z.record(z.string(), z.string()),
      }),
    );
    assert.equal(error.code, "TEMPLATE_REQUIRED");
    assert.equal(error.status, 400);
    assert.deepEqual(error.fields, preview.errors);
    const complete = {
      ...input,
      templateValues: {
        input: "비밀키를 수집하지 않는 입력",
        verification: "실행하지 않는 검증 기록",
      },
    };
    const created = data(
      await client.callTool({
        name: "sticker_create_issue",
        arguments: complete,
      }),
      issueSchema,
    );
    assert.equal(created.templateId, template.template.id);
    assert.equal(created.templateVersion, 1);
    assert.equal(created.priority, "high");
    const retry = data(
      await client.callTool({
        name: "sticker_create_issue",
        arguments: complete,
      }),
      issueSchema,
    );
    assert.equal(retry.id, created.id);
    const mismatch = await client.callTool({
      name: "sticker_create_issue",
      arguments: { ...complete, title: "다른 내용" },
    });
    assert.equal(
      data(mismatch, z.object({ code: z.string() })).code,
      "OPERATION_CONFLICT",
    );
    const denied = await client.callTool({
      name: "sticker_get_issue_template",
      arguments: { templateId: foreign.template.id },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      data(denied, z.object({ code: z.string() })).code,
      "PROJECT_SCOPE",
    );
    assert.equal(f.instance.store.sessions.list(owner).length, 0);
    assert.equal(created.status, "backlog");
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
