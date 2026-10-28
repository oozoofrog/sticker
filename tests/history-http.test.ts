import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  historyListSchema,
  historyDetailSchema,
  restorePreviewSchema,
} from "../server/contracts/history.js";
import {
  issueSchema,
  restoreResultSchema,
} from "../server/response-schemas.js";
void test("history HTTP shares current scope and normalized edit rules, rejects agent restores and forged values, and excludes credential headers", async () => {
  const f = await sessionHttpFixture();
  try {
    const path = `/issues/${f.issue.id}`;
    assert.equal((await f.call(`${path}/history`, "anonymous")).status, 401);
    assert.equal(
      (await f.call(`/issues/${f.foreign.id}/history`, "agent")).status,
      403,
    );
    const edited = issueSchema.parse(
      await (
        await f.call(path, "agent", "PATCH", {
          revision: 1,
          title: " changed ",
        })
      ).json(),
    );
    assert.equal(edited.title, "changed");
    const response = await fetch(`${f.base}/api${path}/history`, {
      headers: {
        authorization: `Bearer ${f.tokens.agent}`,
        "x-private-token": "header-sentinel-do-not-store",
      },
    });
    const list = historyListSchema.parse(await response.json());
    const summary = list.find((entry) => entry.action === "updated");
    assert.ok(summary);
    const detail = historyDetailSchema.parse(
      await (await f.call(`${path}/history/${summary.id}`, "read")).json(),
    );
    assert.equal(detail.authorId, "agent");
    assert.deepEqual(detail.changes, [
      { field: "title", before: f.issue.title, after: "changed" },
    ]);
    assert.equal(JSON.stringify(detail).includes("header-sentinel"), false);
    assert.equal(JSON.stringify(detail).includes(f.tokens.agent), false);
    const previewInput = {
      changeId: summary.id,
      side: "before",
      fields: ["title"],
      revision: 2,
    };
    const input = { ...previewInput, operationId: randomUUID() };
    assert.equal(
      (await f.call(`${path}/restore`, "agent", "POST", input)).status,
      403,
    );
    assert.equal(
      (await f.call(`${path}/restore`, "read", "POST", input)).status,
      403,
    );
    assert.equal(
      (
        await f.call(`${path}/restore`, "owner", "POST", {
          ...input,
          values: { status: "closed" },
        })
      ).status,
      400,
    );
    const preview = restorePreviewSchema.parse(
      await (
        await f.call(`${path}/restore/preview`, "owner", "POST", previewInput)
      ).json(),
    );
    assert.equal(preview.changes[0].after, f.issue.title);
    const restored = restoreResultSchema.parse(
      await (await f.call(`${path}/restore`, "owner", "POST", input)).json(),
    );
    assert.equal(restored.issue.revision, 3);
    assert.equal(restored.issue.title, f.issue.title);
    assert.deepEqual(
      restoreResultSchema.parse(
        await (await f.call(`${path}/restore`, "owner", "POST", input)).json(),
      ),
      restored,
    );
    assert.equal(
      (
        await f.call(`${path}/restore`, "owner", "POST", {
          ...input,
          operationId: randomUUID(),
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
