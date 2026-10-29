import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubProviderFromEnvironment } from "../server/github-provider-config.js";
void test("GitHub provider is off by default and does not read configured files until explicitly enabled", () => {
  assert.deepEqual(
    githubProviderFromEnvironment({
      GITHUB_CREDENTIAL_CONFIG_PATH: "/does-not-exist",
    }),
    { enabled: false },
  );
  assert.deepEqual(
    githubProviderFromEnvironment({ GITHUB_READ_ENABLED: "true" }),
    { enabled: true },
  );
});
void test("operator credential references resolve privately and invalid config errors contain no secret", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sticker-github-config-")),
    path = join(dir, "provider.json");
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path,
    JSON.stringify({
      operator: { label: "Configured account", token: "fixture-config-token" },
    }),
  );
  const provider = githubProviderFromEnvironment({
    GITHUB_READ_ENABLED: "true",
    GITHUB_CREDENTIAL_CONFIG_PATH: path,
  });
  assert.equal(
    provider.credentials?.operator.resolve(),
    "fixture-config-token",
  );
  assert.ok(!JSON.stringify(provider).includes("fixture-config-token"));
  writeFileSync(
    path,
    JSON.stringify({
      operator: {
        label: "Configured account",
        token: "fixture-secret\nmalformed",
      },
    }),
  );
  assert.throws(
    () =>
      githubProviderFromEnvironment({
        GITHUB_READ_ENABLED: "true",
        GITHUB_CREDENTIAL_CONFIG_PATH: path,
      }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.ok(!String(e).includes("fixture-secret"));
      return true;
    },
  );
});
