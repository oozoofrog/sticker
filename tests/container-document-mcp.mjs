// Disposable fixture only: the actual STDIO bridge is connected by container FIFOs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
const phase = process.argv[2],
  manifestPath = process.argv[3];
assert.ok(["initialize", "verify", "mutate", "readonly"].includes(phase));
assert.ok(manifestPath, "Explicit disposable fixture manifest required");
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
const client = new Client({
  name: "sticker-document-container-fixture",
  version: "1",
});
const timeout = setTimeout(() => {
  console.error("Container document MCP fixture timed out");
  process.exit(1);
}, 45000);
const firstSource = "  # 기획 자료\r\n\r\n- 첫 작업\n원문 공백  \n";
const secondSource = "# 작업 자료 v2\n\n- 완료 결과\n\n";
const title = "Container MCP authored document";
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} must succeed`);
  assert.equal(result.content?.[0]?.type, "text");
  return JSON.parse(result.content[0].text);
}
async function denied(name, args, expected) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} must refuse`);
  assert.equal(JSON.parse(result.content[0].text).status, expected);
}
function load() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  for (const field of [
    "resourceId",
    "projectId",
    "issueId",
    "createOperationId",
    "updateOperationId",
  ])
    assert.match(manifest[field], /^[0-9a-f-]{36}$/);
  assert.equal(manifest.authorId, "container-document-writer");
  return manifest;
}
async function verify(manifest) {
  const document = await call("sticker_get_resource", {
    resourceId: manifest.resourceId,
  });
  assert.equal(document.resource.id, manifest.resourceId);
  assert.equal(document.resource.projectId, manifest.projectId);
  assert.equal(document.resource.title, title);
  assert.equal(document.resource.currentVersion, 2);
  assert.equal(document.resource.revision, 2);
  assert.equal(document.selectedVersion.version, 2);
  assert.equal(document.selectedVersion.markdown, secondSource);
  assert.equal(document.selectedVersion.authorId, manifest.authorId);
  assert.equal(document.history.length, 2);
  assert.deepEqual(
    document.history.map((v) => v.version),
    [2, 1],
  );
  assert.ok(document.history.every((v) => v.authorId === manifest.authorId));
  const first = await call("sticker_get_resource", {
    resourceId: manifest.resourceId,
    resourceVersion: 1,
  });
  assert.equal(first.selectedVersion.markdown, firstSource);
  assert.equal(first.selectedVersion.authorId, manifest.authorId);
  assert.equal(document.usage.issues.length, 1);
  assert.equal(document.usage.issues[0].issueId, manifest.issueId);
  assert.equal(document.usage.issues[0].resourceVersion, 1);
  const matches = await call("sticker_list_resources", {
    projectId: manifest.projectId,
    query: title,
  });
  assert.deepEqual(
    matches.map((v) => v.id),
    [manifest.resourceId],
  );
  // Retry results survive process restart and backup/restore: no extra version.
  const replay = await call("sticker_update_document", {
    resourceId: manifest.resourceId,
    revision: 1,
    operationId: manifest.updateOperationId,
    markdown: secondSource,
  });
  assert.equal(replay.resource.id, manifest.resourceId);
  assert.equal(replay.resource.currentVersion, 2);
  assert.equal(replay.current.markdown, secondSource);
  const after = await call("sticker_get_resource", {
    resourceId: manifest.resourceId,
  });
  assert.equal(after.history.length, 2);
}
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const name of ["sticker_create_document", "sticker_update_document"]) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} must be discoverable`);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
  const projects = await call("sticker_list_projects");
  const project = projects.find((item) => item.name === "Portable fixture");
  assert.ok(project, "Disposable Portable fixture project required");
  if (phase !== "readonly")
    assert.deepEqual(
      projects.map((p) => p.id),
      [project.id],
      "Writer scope must be exactly one project",
    );
  if (phase === "initialize") {
    assert.deepEqual(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      {},
      "Fresh manifest required",
    );
    assert.deepEqual(
      await call("sticker_list_resources", {
        projectId: project.id,
        query: title,
      }),
      [],
    );
    const createOperationId = randomUUID(),
      updateOperationId = randomUUID();
    const create = {
      projectId: project.id,
      title,
      markdown: firstSource,
      operationId: createOperationId,
    };
    const first = await call("sticker_create_document", create);
    const replay = await call("sticker_create_document", create);
    assert.equal(replay.resource.id, first.resource.id);
    assert.equal(replay.resource.currentVersion, 1);
    assert.equal(replay.current.markdown, firstSource);
    const issue = await call("sticker_create_issue", {
      projectId: project.id,
      title: "Container MCP document reference",
    });
    await call("sticker_link_resource", {
      issueId: issue.id,
      resourceId: first.resource.id,
      resourceVersion: 1,
      issueRevision: issue.revision,
      operationId: randomUUID(),
    });
    const second = await call("sticker_update_document", {
      resourceId: first.resource.id,
      revision: first.resource.revision,
      operationId: updateOperationId,
      markdown: secondSource,
    });
    assert.equal(second.resource.id, first.resource.id);
    const manifest = {
      schemaVersion: 1,
      projectId: project.id,
      resourceId: first.resource.id,
      issueId: issue.id,
      createOperationId,
      updateOperationId,
      authorId: "container-document-writer",
    };
    await verify(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  } else {
    const manifest = load();
    assert.equal(manifest.projectId, project.id);
    if (phase === "readonly") {
      await denied(
        "sticker_create_document",
        {
          projectId: project.id,
          title: "Must not create",
          markdown: "denied",
          operationId: randomUUID(),
        },
        403,
      );
      await denied(
        "sticker_update_document",
        {
          resourceId: manifest.resourceId,
          revision: 2,
          markdown: "Must not write",
          operationId: randomUUID(),
        },
        403,
      );
      const current = await call("sticker_get_resource", {
        resourceId: manifest.resourceId,
      });
      assert.equal(current.selectedVersion.markdown, secondSource);
      assert.equal(current.history.length, 2);
    } else if (phase === "mutate") {
      const third = await call("sticker_update_document", {
        resourceId: manifest.resourceId,
        revision: 2,
        markdown: "Disposable mutation must disappear after restore",
        operationId: randomUUID(),
      });
      assert.equal(third.resource.currentVersion, 3);
      assert.equal(third.history.length, 3);
    } else await verify(manifest);
  }
  console.error(
    `Container document MCP ${phase} passed: scoped source/version/reference invariants`,
  );
} finally {
  clearTimeout(timeout);
  await client.close();
  process.stdin.destroy();
}
