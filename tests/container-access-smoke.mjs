// Docker-only contract checker for the disposable access CLI lifecycle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const actual = JSON.parse(readFileSync(0, "utf8"));
const expected = process.argv[2];
assert.equal(actual.schemaVersion, 1);
assert.equal(actual.browserReachability, "unverified");
assert.equal(actual.urlScope, "docker_host");
if (expected === "stopped") {
  assert.equal(actual.state, "stopped");
  assert.equal(actual.containerRunning, false);
} else {
  assert.equal(actual.state, "ready");
  assert.equal(actual.containerRunning, true);
  assert.equal(actual.appResponse, "verified");
  assert.equal(actual.url, process.env.APP_ORIGIN);
  if (expected === "url_only") assert.equal(actual.action, "url_only");
  if (expected === "started") assert.equal(actual.action, "started");
  if (expected === "unchanged") assert.equal(actual.action, "none");
}
console.log(`Access CLI contract verified: ${expected}`);
