import test from "node:test";
import assert from "node:assert/strict";
import { sessionHttpFixture } from "./session-fixture.js";
import { prepareDocumentJourney } from "./document-journey-fixture.js";

void test("scoped synthetic HTTP document journey preserves v1 pin, v2 source, retry identity and stale-write rejection", async () => {
  const f = await sessionHttpFixture();
  try {
    const journey = await prepareDocumentJourney(
      async (path, method, body) => {
        const response = await f.call(path, "agent", method, body);
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      },
      f.project.id,
      f.issue,
    );
    assert.equal(journey.current.resource.projectId, f.project.id);
    const denied = await f.call(
      `/resources/${journey.current.resource.id}`,
      "read",
      "PATCH",
      {
        revision: 2,
        operationId: crypto.randomUUID(),
        markdown: "must not write",
      },
    );
    assert.equal(denied.status, 403);
    const foreign = await f.call("/resources", "agent", "POST", {
      projectId: f.other.id,
      kind: "markdown",
      title: "must not create",
      markdown: "no",
      operationId: crypto.randomUUID(),
    });
    assert.equal(foreign.status, 403);
  } finally {
    await f.close();
  }
});
