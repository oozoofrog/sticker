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
  resourceSchema,
  resourceVersionSchema,
  resourceDetailSchema,
  issueResourceLinkSchema,
  resourceReferenceSchema,
} from "../server/contracts/resources.js";
function content<T>(result: unknown, schema: z.ZodType<T>): T {
  const envelope = z
      .object({
        content: z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .min(1),
      })
      .parse(result),
    raw: unknown = JSON.parse(envelope.content[0].text);
  return schema.parse(raw);
}
function resourceError(result: unknown, code: string, status: number) {
  assert.equal(z.object({ isError: z.boolean() }).parse(result).isError, true);
  assert.deepEqual(
    content(result, z.object({ code: z.string(), status: z.number() })),
    { code, status },
  );
}
void test("official MCP resources reauthorize scope, distinguish owner guidance, pin issue/result versions and never grant authority or owner writes", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "resources-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const resource = f.instance.store.resources.create(owner, {
        projectId: f.project.id,
        title: "guide",
        kind: "markdown",
        markdown: "untrusted body",
        operationId: randomUUID(),
      }),
      foreign = f.instance.store.resources.create(owner, {
        projectId: f.other.id,
        title: "secret",
        kind: "link",
        url: "https://example.invalid/",
        operationId: randomUUID(),
      });
    f.instance.store.resources.guidance(owner, resource.resource.id, {
      revision: 1,
      isGuidance: true,
      operationId: randomUUID(),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("sticker_list_resources"));
    assert.ok(
      !names.some((name) => /designate_guidance|set_guidance/.test(name)),
    );
    assert.equal(
      content(
        await client.callTool({
          name: "sticker_list_resources",
          arguments: { projectId: f.project.id },
        }),
        resourceSchema.array(),
      ).length,
      1,
    );
    assert.equal(
      content(
        await client.callTool({
          name: "sticker_get_project_guidance",
          arguments: { projectId: f.project.id },
        }),
        resourceDetailSchema.array(),
      )[0].resource.isGuidance,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "sticker_get_resource",
          arguments: { resourceId: foreign.resource.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "sticker_list_resources",
          arguments: { projectId: f.other.id },
        })
      ).isError,
      true,
    );
    const link = content(
      await client.callTool({
        name: "sticker_link_resource",
        arguments: {
          issueId: f.issue.id,
          resourceId: resource.resource.id,
          resourceVersion: 1,
          issueRevision: 1,
          operationId: randomUUID(),
        },
      }),
      issueResourceLinkSchema,
    );
    assert.equal(link.version.version, 1);
    const report = f.instance.store.sessions.report(
      { ...owner, id: "agent", role: "agent", projectIds: [f.project.id] },
      {
        projectId: f.project.id,
        issueId: f.issue.id,
        externalSessionId: "mcp-resource",
        eventId: "result",
        kind: "result",
        message: "self report",
      },
    );
    const reference = content(
      await client.callTool({
        name: "sticker_record_resource_reference",
        arguments: {
          sessionId: report.session.id,
          eventId: "result",
          resourceId: resource.resource.id,
          resourceVersion: 1,
          operationId: randomUUID(),
        },
      }),
      resourceReferenceSchema,
    );
    assert.equal(reference.recordedBy, "agent");
    assert.equal(reference.version.authorId, owner.id);
    f.instance.store.resources.update(owner, resource.resource.id, {
      revision: 2,
      markdown: "new body",
      operationId: randomUUID(),
    });
    const selected = content(
      await client.callTool({
        name: "sticker_get_resource",
        arguments: { resourceId: resource.resource.id, resourceVersion: 1 },
      }),
      z.object({
        resource: resourceSchema,
        selectedVersion: resourceVersionSchema.nullable(),
      }),
    );
    assert.equal(selected.resource.currentVersion, 2);
    assert.equal(selected.selectedVersion?.markdown, "untrusted body");
    assert.equal(selected.selectedVersion.version, 1);
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
void test("MCP shared file upload/read accepts bytes only, enforces 5 MiB separately from HTTP 20 MiB, and preserves exact versions", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.agent),
    client = new Client({ name: "resource-file-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const args = {
      projectId: f.project.id,
      title: "file",
      name: "../원본.svg",
      operationId: randomUUID(),
      base64: Buffer.from('<svg onload="alert(1)"/>').toString("base64"),
    };
    const uploaded = content(
      await client.callTool({
        name: "sticker_upload_resource_file",
        arguments: args,
      }),
      resourceDetailSchema,
    );
    assert.equal(uploaded.current?.fileName, "원본.svg");
    assert.equal(uploaded.current.mimeType, "application/octet-stream");
    assert.deepEqual(
      content(
        await client.callTool({
          name: "sticker_upload_resource_file",
          arguments: args,
        }),
        resourceDetailSchema,
      ),
      uploaded,
    );
    const file = content(
      await client.callTool({
        name: "sticker_read_resource_file",
        arguments: { resourceId: uploaded.resource.id, resourceVersion: 1 },
      }),
      z.object({
        resourceId: z.string(),
        resourceVersion: z.number(),
        base64: z.string(),
        size: z.number(),
        name: z.string(),
        mimeType: z.string(),
      }),
    );
    assert.equal(file.base64, args.base64);
    assert.equal(file.resourceVersion, 1);
    const boundary = content(
      await client.callTool({
        name: "sticker_upload_resource_file",
        arguments: {
          ...args,
          title: "boundary",
          name: "boundary.bin",
          operationId: randomUUID(),
          base64: Buffer.alloc(5 * 1024 * 1024).toString("base64"),
        },
      }),
      resourceDetailSchema,
    );
    assert.equal(boundary.current?.size, 5 * 1024 * 1024);
    const boundaryRead = content(
      await client.callTool({
        name: "sticker_read_resource_file",
        arguments: { resourceId: boundary.resource.id, resourceVersion: 1 },
      }),
      z.object({ size: z.number(), base64: z.string() }),
    );
    assert.equal(boundaryRead.size, 5 * 1024 * 1024);
    assert.equal(
      Buffer.from(boundaryRead.base64, "base64").length,
      5 * 1024 * 1024,
    );
    const oversized = await client.callTool({
      name: "sticker_upload_resource_file",
      arguments: {
        ...args,
        operationId: randomUUID(),
        base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"),
      },
    });
    assert.equal(oversized.isError, true);
    assert.equal(
      content(oversized, z.object({ code: z.string() })).code,
      "FILE_TOO_LARGE",
    );
    const form = new FormData();
    form.append(
      "metadata",
      JSON.stringify({ title: "web-only", operationId: randomUUID() }),
    );
    form.append(
      "file",
      new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]),
      "large.bin",
    );
    const response = await fetch(
      `${f.base}/api/projects/${f.project.id}/resources/files`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${f.tokens.agent}` },
        body: form,
      },
    );
    assert.equal(response.status, 201);
    const web = resourceDetailSchema.parse(await response.json());
    const read = await client.callTool({
      name: "sticker_read_resource_file",
      arguments: { resourceId: web.resource.id, resourceVersion: 1 },
    });
    assert.equal(read.isError, true);
    assert.equal(
      content(read, z.object({ code: z.string() })).code,
      "FILE_TOO_LARGE",
    );
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});

void test("read-only MCP principals can search but cannot upload or attach resources", async () => {
  const f = await sessionHttpFixture(),
    server = createStickerMcp(f.base, f.tokens.read),
    client = new Client({ name: "resources-read-test", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const resource = f.instance.store.resources.create(owner, {
      projectId: f.project.id,
      title: "read",
      kind: "markdown",
      markdown: "data",
      operationId: randomUUID(),
    });
    assert.equal(
      content(
        await client.callTool({
          name: "sticker_list_resources",
          arguments: { projectId: f.project.id },
        }),
        resourceSchema.array(),
      ).length,
      1,
    );
    for (const call of [
      {
        name: "sticker_upload_resource_file",
        arguments: {
          projectId: f.project.id,
          title: "denied",
          name: "data.txt",
          base64: "",
          operationId: randomUUID(),
        },
      },
      {
        name: "sticker_link_resource",
        arguments: {
          issueId: f.issue.id,
          resourceId: resource.resource.id,
          issueRevision: 1,
          operationId: randomUUID(),
        },
      },
    ]) {
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      assert.equal(
        content(result, z.object({ code: z.string() })).code,
        "READ_ONLY",
      );
    }
    assert.equal(
      (
        await client.callTool({
          name: "sticker_get_resource",
          arguments: { resourceId: "https://example.invalid/" },
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
void test("MCP document authoring preserves source, versions and idempotent outcomes", async () => {
  const f = await sessionHttpFixture();
  const server = createStickerMcp(f.base, f.tokens.agent);
  const client = new Client({ name: "document-author", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    for (const name of ["sticker_create_document", "sticker_update_document"]) {
      const tool = tools.find((value) => value.name === name);
      assert.ok(tool, `${name} must be discoverable`);
      assert.equal(tool.annotations?.readOnlyHint, false);
    }
    const owningVersion = f.instance.store.createVersion(owner, {
      projectId: f.project.id,
      name: "v1",
    });
    const input = {
      versionId: owningVersion.id,
      projectId: f.project.id,
      title: "Plan",
      markdown: "# 계획\r\n\r\n- 원문  \r\n<script>untrusted</script>\n",
      operationId: randomUUID(),
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      content(
        await client.callTool({ name, arguments: args }),
        resourceDetailSchema,
      );
    const created = await call("sticker_create_document", input);
    assert.equal(created.current?.markdown, input.markdown);
    assert.equal(created.current.authorId, "agent");
    assert.deepEqual(await call("sticker_create_document", input), created);
    resourceError(
      await client.callTool({
        name: "sticker_create_document",
        arguments: { ...input, markdown: "changed create retry" },
      }),
      "OPERATION_CONFLICT",
      409,
    );
    const update = {
      resourceId: created.resource.id,
      revision: created.resource.revision,
      operationId: randomUUID(),
      markdown: "새 계획\n",
    };
    const updated = await call("sticker_update_document", update);
    assert.equal(updated.resource.versionId, owningVersion.id);
    assert.equal(updated.resource.title, input.title);
    assert.equal(updated.current?.version, 2);
    assert.equal(updated.current.markdown, update.markdown);
    assert.deepEqual(await call("sticker_update_document", update), updated);
    resourceError(
      await client.callTool({
        name: "sticker_update_document",
        arguments: { ...update, markdown: "changed retry" },
      }),
      "OPERATION_CONFLICT",
      409,
    );
    resourceError(
      await client.callTool({
        name: "sticker_update_document",
        arguments: { ...update, operationId: randomUUID() },
      }),
      "REVISION_CONFLICT",
      409,
    );
    const selected = content(
      await client.callTool({
        name: "sticker_get_resource",
        arguments: { resourceId: created.resource.id, resourceVersion: 1 },
      }),
      z.object({ selectedVersion: resourceVersionSchema }),
    );
    assert.equal(selected.selectedVersion.markdown, input.markdown);
    const link = content(
      await client.callTool({
        name: "sticker_link_resource",
        arguments: {
          issueId: f.issue.id,
          issueRevision: 1,
          resourceId: created.resource.id,
          resourceVersion: 2,
          operationId: randomUUID(),
        },
      }),
      issueResourceLinkSchema,
    );
    assert.equal(link.version.markdown, update.markdown);
    const report = f.instance.store.sessions.report(
      { ...owner, id: "agent", role: "agent", projectIds: [f.project.id] },
      {
        projectId: f.project.id,
        issueId: f.issue.id,
        externalSessionId: "document-work",
        eventId: "result",
        kind: "result",
        message: "used v2",
      },
    );
    const reference = content(
      await client.callTool({
        name: "sticker_record_resource_reference",
        arguments: {
          sessionId: report.session.id,
          eventId: "result",
          resourceId: created.resource.id,
          resourceVersion: 2,
          operationId: randomUUID(),
        },
      }),
      resourceReferenceSchema,
    );
    assert.equal(reference.version.version, 2);
    const unlinked = await call("sticker_update_document", {
      ...update,
      revision: 2,
      operationId: randomUUID(),
      versionId: null,
      markdown: "third",
    });
    assert.equal(unlinked.resource.versionId, null);
    const pinned = f.instance.store.resources.issueLinks(owner, f.issue.id);
    assert.equal(pinned[0].version.version, 2);
    assert.equal(pinned[0].version.markdown, update.markdown);
    assert.equal(reference.version.markdown, update.markdown);
    assert.equal(
      f.instance.store.resources.sessionReferences(owner, report.session.id)[0]
        .version.markdown,
      update.markdown,
    );
    assert.equal(
      f.instance.store.resources.list(owner, { projectId: f.project.id })
        .length,
      1,
    );
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
void test("MCP document writes enforce current authority and bounds without changing replay semantics", async () => {
  const f = await sessionHttpFixture();
  const server = createStickerMcp(f.base, f.tokens.agent);
  const client = new Client({ name: "document-policy", version: "1" });
  const readServer = createStickerMcp(f.base, f.tokens.read);
  const readClient = new Client({ name: "document-readonly", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(),
    [c, d] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    await readServer.connect(c);
    await readClient.connect(d);
    const input = {
      projectId: f.project.id,
      title: "Bounds",
      markdown: "한".repeat(100000),
      operationId: randomUUID(),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const denied = async (
      name: string,
      args: Record<string, unknown>,
      code?: string,
      status = 403,
    ) => {
      const result = await call(name, args);
      assert.equal(result.isError, true);
      if (code)
        assert.deepEqual(
          content(result, z.object({ code: z.string(), status: z.number() })),
          { code, status },
        );
    };
    await denied("sticker_create_document", {
      ...input,
      markdown: "a".repeat(100001),
    });
    await denied(
      "sticker_create_document",
      {
        ...input,
        projectId: f.other.id,
      },
      "PROJECT_SCOPE",
    );
    await denied("sticker_create_document", { ...input, isGuidance: true });
    resourceError(
      await readClient.callTool({
        name: "sticker_create_document",
        arguments: input,
      }),
      "READ_ONLY",
      403,
    );
    const created = content(
      await call("sticker_create_document", input),
      resourceDetailSchema,
    );
    assert.equal(created.current?.markdown, input.markdown);
    const update = {
      resourceId: created.resource.id,
      revision: 1,
      operationId: randomUUID(),
      markdown: "",
    };
    resourceError(
      await readClient.callTool({
        name: "sticker_update_document",
        arguments: update,
      }),
      "READ_ONLY",
      403,
    );
    await denied("sticker_update_document", {
      ...update,
      url: "https://example.invalid",
    });
    const foreignVersion = f.instance.store.createVersion(owner, {
      projectId: f.other.id,
      name: "Foreign",
    });
    await denied(
      "sticker_update_document",
      {
        ...update,
        versionId: foreignVersion.id,
        operationId: randomUUID(),
      },
      "PROJECT_SCOPE",
    );
    assert.equal(
      f.instance.store.resources.get(owner, created.resource.id).history.length,
      1,
    );
    const updated = content(
      await call("sticker_update_document", update),
      resourceDetailSchema,
    );
    assert.equal(updated.current?.markdown, "");
    assert.equal(updated.resource.title, input.title);
    f.instance.store.resources.guidance(owner, created.resource.id, {
      revision: 2,
      isGuidance: true,
      operationId: randomUUID(),
    });
    await denied("sticker_update_document", update, "OWNER_REQUIRED");
    await denied(
      "sticker_update_document",
      {
        ...update,
        revision: 3,
        operationId: randomUUID(),
      },
      "OWNER_REQUIRED",
    );
    // Creating again replays the original result; it does not edit the new guidance.
    assert.deepEqual(
      content(
        await call("sticker_create_document", input),
        resourceDetailSchema,
      ),
      created,
    );
    f.instance.store.resources.guidance(owner, created.resource.id, {
      revision: 3,
      isGuidance: false,
      operationId: randomUUID(),
    });
    f.instance.store.resources.remove(owner, created.resource.id, {
      revision: 4,
      operationId: randomUUID(),
    });
    assert.deepEqual(
      content(
        await call("sticker_update_document", update),
        resourceDetailSchema,
      ),
      updated,
    );
    await denied(
      "sticker_update_document",
      {
        ...update,
        revision: 5,
        operationId: randomUUID(),
      },
      "RESOURCE_DELETED",
      409,
    );
    const latest = content(
      await call("sticker_get_resource", { resourceId: created.resource.id }),
      z.object({
        resource: resourceSchema,
        selectedVersion: resourceVersionSchema.nullable(),
      }),
    );
    assert.ok(latest.resource.deletedAt);
    assert.equal(latest.selectedVersion, null);
    const foreign = f.instance.store.resources.create(owner, {
      ...input,
      projectId: f.other.id,
      kind: "markdown",
      operationId: randomUUID(),
    });
    await denied(
      "sticker_update_document",
      {
        ...update,
        resourceId: foreign.resource.id,
        operationId: randomUUID(),
      },
      "PROJECT_SCOPE",
    );
    const link = f.instance.store.resources.create(owner, {
      projectId: f.project.id,
      kind: "link",
      title: "URL",
      url: "https://example.invalid",
      operationId: randomUUID(),
    });
    await denied(
      "sticker_update_document",
      {
        ...update,
        resourceId: link.resource.id,
        operationId: randomUUID(),
      },
      "RESOURCE_KIND",
      400,
    );
    assert.equal(
      f.instance.store.resources.get(owner, link.resource.id).history.length,
      1,
    );
  } finally {
    await client.close();
    await server.close();
    await readClient.close();
    await readServer.close();
    await f.close();
  }
});
