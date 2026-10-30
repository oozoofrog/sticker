import assert from "node:assert/strict";
import {
  resourceDetailSchema,
  issueResourceLinkSchema,
} from "../server/contracts/resources.js";

export const journeyTitle = "작업 근거 · Planning source";
export const journeyV1 =
  "# 최초 기획 v1\n\n- 승인된 범위\n\n```ts\nconst literal = '<draft>&source';\n```";
export const journeyV2 =
  "# 현재 기획 v2\n\n- 구현 결과\n\n```ts\nconst literal = '<result>&source';\n```";
type Call = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;
/** HTTP fixture setup, not MCP discovery or a claim about a real Codex session. */
export async function prepareDocumentJourney(
  call: Call,
  projectId: string,
  issue: { id: string; revision: number },
) {
  const create = {
    projectId,
    kind: "markdown",
    title: journeyTitle,
    markdown: journeyV1,
    operationId: crypto.randomUUID(),
  };
  const first = await call("/resources", "POST", create);
  assert.equal(first.status, 201);
  const initial = resourceDetailSchema.parse(first.body);
  const repeated = await call("/resources", "POST", create);
  assert.equal(repeated.status, 201);
  assert.equal(
    resourceDetailSchema.parse(repeated.body).resource.id,
    initial.resource.id,
  );
  const link = await call(`/issues/${issue.id}/resources`, "POST", {
    resourceId: initial.resource.id,
    resourceVersion: 1,
    issueRevision: issue.revision,
    operationId: crypto.randomUUID(),
  });
  assert.equal(link.status, 201);
  const pin = issueResourceLinkSchema.parse(link.body);
  assert.equal(pin.version.version, 1);
  assert.equal(pin.version.kind, "markdown");
  const update = {
    revision: initial.resource.revision,
    operationId: crypto.randomUUID(),
    markdown: journeyV2,
  };
  const updated = await call(
    `/resources/${initial.resource.id}`,
    "PATCH",
    update,
  );
  assert.equal(updated.status, 200);
  const retried = await call(
    `/resources/${initial.resource.id}`,
    "PATCH",
    update,
  );
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, updated.body);
  const stale = await call(`/resources/${initial.resource.id}`, "PATCH", {
    ...update,
    operationId: crypto.randomUUID(),
    markdown: "stale must not overwrite",
  });
  assert.equal(stale.status, 409);
  const currentResult = await call(`/resources/${initial.resource.id}`, "GET");
  assert.equal(currentResult.status, 200);
  const current = resourceDetailSchema.parse(currentResult.body);
  assert.equal(current.history.length, 2);
  assert.equal(current.current?.kind, "markdown");
  assert.equal(current.current.markdown, journeyV2);
  const pinsResult = await call(`/issues/${issue.id}/resources`, "GET");
  assert.equal(pinsResult.status, 200);
  const pins = issueResourceLinkSchema.array().parse(pinsResult.body);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].version.version, 1);
  if (pins[0].version.kind !== "markdown")
    throw new Error("Expected pinned Markdown fixture");
  assert.equal(pins[0].version.markdown, journeyV1);
  return { initial, current, pin: pins[0] };
}
