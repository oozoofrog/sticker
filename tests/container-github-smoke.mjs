// Fixture-only lifecycle check; no provider, token, or external account required.
import assert from "node:assert/strict";
const phase = process.argv[2],
  base = process.env.STICKER_SMOKE_API_URL ?? "http://127.0.0.1:8787",
  origin = process.env.APP_ORIGIN;
assert.ok(["initialize", "verify"].includes(phase));
assert.ok(process.env.OWNER_PASSWORD, "Disposable fixture password required");
const login = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ password: process.env.OWNER_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
}
const before = await api("/bootstrap"),
  project = before.projects.find((p) => p.name === "Portable fixture"),
  issue = before.issues.find((i) => i.title === "Persisted container issue");
assert.ok(project && issue, "Only the disposable core fixture is accepted");
const path = `/projects/${project.id}/github`;
const original = await api(path);
const discovery = await api(`${path}/sources`);
assert.equal(discovery.providerEnabled, false);
assert.deepEqual(discovery.sources, []);
assert.equal(discovery.revision, original.revision);
assert.equal(
  original.providerEnabled,
  false,
  "Lifecycle fixture must not enable external GitHub access",
);
if (phase === "initialize") {
  await api(path, "PUT", {
    repository: { owner: "octocat", name: "portable-fixture" },
    mode: "public",
    revision: original.revision,
    confirm: true,
  });
  await api(`/issues/${issue.id}/github-evidence`, "POST", {
    url: "https://github.com/octocat/portable-fixture/pull/1",
    issueRevision: issue.revision,
  });
}
const connection = await api(path);
assert.deepEqual(connection.repository, {
  owner: "octocat",
  name: "portable-fixture",
});
assert.equal(connection.mode, "public");
assert.equal(connection.connected, true);
assert.equal(connection.permissionsVerified, false);
assert.equal(connection.lastVerifiedAt, null);
const evidence = await api(`/issues/${issue.id}/github-evidence`);
assert.equal(evidence.length, 1);
assert.equal(
  evidence[0].url,
  "https://github.com/octocat/portable-fixture/pull/1",
);
assert.equal(evidence[0].snapshot, null);
assert.equal(evidence[0].disconnected, true);
assert.equal(evidence[0].stale, true);
assert.equal(evidence[0].checkedAt, null);
const after = await api("/bootstrap");
assert.deepEqual(after.issues, before.issues);
assert.equal(after.projects.length, before.projects.length);
assert.equal(after.versions.length, before.versions.length);
console.log(`Container GitHub evidence smoke passed: ${phase}`);
