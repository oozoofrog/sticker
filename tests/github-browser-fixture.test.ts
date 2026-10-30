import test from "node:test";
import assert from "node:assert/strict";
import { githubBrowserFixture } from "./github-provider-fixture.js";
import { parseGithubUrl } from "../server/contracts/github.js";
import { GithubReadError } from "../server/github-read-client.js";

void test("isolated browser owners each retain first verification before a refresh failure", async () => {
  const provider = githubBrowserFixture();
  const client = provider.client?.({ mode: "public", credentialRef: null });
  assert.ok(client);
  for (const owner of ["fixture-desktop", "fixture-iphone", "fixture-retry"]) {
    const target = parseGithubUrl(`https://github.com/${owner}/project/pull/7`);
    const first = await client.inspect(target);
    assert.equal(first.ci, "success");
    assert.equal(first.snapshotCi, "success");
    assert.equal(first.snapshotSha, "a".repeat(40));
    await assert.rejects(
      client.inspect(target),
      (error) => error instanceof GithubReadError && error.code === "NETWORK",
    );
  }
});
