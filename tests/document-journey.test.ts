import test from "node:test";
import assert from "node:assert/strict";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  prepareDocumentJourney,
  createDocumentJourneyProject,
} from "./document-journey-fixture.js";

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

void test("browser HTTP setup creates a valid project and issue before the full document journey", async () => {
  const f = await sessionHttpFixture();
  try {
    const call = async (path: string, method: string, body?: unknown) => {
      const r = await f.call(path, "owner", method, body);
      return { status: r.status, body: (await r.json()) as unknown };
    };
    const { project, issue } = await createDocumentJourneyProject(
      call,
      "startup regression",
    );
    assert.match(project.key, /^[A-Z][A-Z0-9]{1,7}$/);
    await prepareDocumentJourney(call, project.id, issue);
  } finally {
    await f.close();
  }
});
