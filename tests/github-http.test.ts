import test from "node:test";
import assert from "node:assert/strict";
import { sessionHttpFixture } from "./session-fixture.js";
import {
  githubConnectionSchema,
  githubEvidenceSchema,
} from "../server/contracts/github.js";
void test("GitHub HTTP enforces owner settings, scoped private cached evidence, readonly writes and explicit manual refresh", async () => {
  let calls = 0,
    fail = false;
  const sha = "a".repeat(40);
  const f = await sessionHttpFixture({
    enabled: true,
    client: () => ({
      verify: () => {
        calls++;
        return Promise.resolve();
      },
      inspect: () => {
        calls++;
        return fail
          ? Promise.reject(new Error("fixture-secret"))
          : Promise.resolve({
              headSha: sha,
              snapshotSha: sha,
              ci: "success",
              snapshotCi: "success",
              stale: false,
              complete: true,
              checkCount: 1,
              statusCount: 0,
            });
      },
    }),
  });
  try {
    const path = `/projects/${f.project.id}/github`,
      input = {
        repository: { owner: "octocat", name: "project" },
        mode: "public",
        revision: 0,
        confirm: true,
      };
    assert.equal((await f.call(path, "anonymous")).status, 401);
    assert.equal((await f.call(path, "agent", "PUT", input)).status, 403);
    const connection = githubConnectionSchema.parse(
      await (await f.call(path, "owner", "PUT", input)).json(),
    );
    assert.equal(calls, 0);
    const add = {
      url: "https://github.com/octocat/project/pull/1",
      issueRevision: 1,
    };
    assert.equal(
      (
        await f.call(
          `/issues/${f.issue.id}/github-evidence`,
          "read",
          "POST",
          add,
        )
      ).status,
      403,
    );
    const e = githubEvidenceSchema.parse(
      await (
        await f.call(
          `/issues/${f.issue.id}/github-evidence`,
          "agent",
          "POST",
          add,
        )
      ).json(),
    );
    assert.equal(calls, 0);
    const fresh = githubEvidenceSchema.parse(
      await (
        await f.call(`/github-evidence/${e.id}/refresh`, "agent", "POST", {
          revision: e.revision,
        })
      ).json(),
    );
    assert.equal(fresh.snapshot?.ci, "success");
    assert.equal(calls, 1);
    fail = true;
    const stale = githubEvidenceSchema.parse(
      await (
        await f.call(`/github-evidence/${e.id}/refresh`, "agent", "POST", {
          revision: fresh.revision,
        })
      ).json(),
    );
    assert.equal(stale.errorCode, "NETWORK");
    assert.equal(stale.checkedAt, fresh.checkedAt);
    assert.ok(!JSON.stringify(stale).includes("fixture-secret"));
    assert.equal(
      (await f.call(`/issues/${f.foreign.id}/github-evidence`, "agent")).status,
      403,
    );
    await f.call(path, "owner", "DELETE", {
      revision: connection.revision,
      confirm: true,
    });
    assert.equal(
      (
        await f.call(`/github-evidence/${e.id}/refresh`, "agent", "POST", {
          revision: stale.revision,
        })
      ).status,
      409,
    );
    assert.equal(calls, 2);
    assert.equal(
      githubEvidenceSchema.parse(
        await (await f.call(`/github-evidence/${e.id}`, "agent")).json(),
      ).disconnected,
      true,
    );
  } finally {
    await f.close();
  }
});
