// Disposable fixture only: verifies immutable field history and restore receipts after recreate/restore.
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
const state = await api("/bootstrap"),
  project = state.projects.find((value) => value.name === "Portable fixture");
assert.ok(
  project &&
    state.issues.some((issue) => issue.title === "Persisted container issue"),
  "Only the disposable core fixture is accepted",
);
const title = "Container history fixture",
  operationId = "87000000-0000-4000-8000-000000000009";
if (phase === "initialize") {
  const created = await api("/issues", "POST", {
    projectId: project.id,
    title,
    description: "Original history body",
  });
  await api(`/issues/${created.id}`, "PATCH", {
    revision: 1,
    description: "Changed history body",
    priority: "high",
  });
  const source = (await api(`/issues/${created.id}/history`)).find(
    (change) => change.action === "updated",
  );
  assert.ok(source);
  const input = {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 2,
    operationId,
  };
  const preview = await api(`/issues/${created.id}/restore/preview`, "POST", {
    changeId: source.id,
    side: "before",
    fields: ["description"],
    revision: 2,
  });
  assert.deepEqual(preview.changes, [
    {
      field: "description",
      before: "Changed history body",
      after: "Original history body",
    },
  ]);
  const restored = await api(`/issues/${created.id}/restore`, "POST", input);
  assert.equal(restored.issue.revision, 3);
}
const issue = (await api("/bootstrap")).issues.find(
  (value) => value.projectId === project.id && value.title === title,
);
assert.ok(issue);
assert.equal(issue.revision, 3);
assert.equal(issue.priority, "high");
assert.equal(issue.description, "Original history body");
const history = await api(`/issues/${issue.id}/history`);
assert.equal(history.length, 3);
const source = history.find((change) => change.action === "updated"),
  restored = history.find((change) => change.action === "restored");
assert.ok(source && restored);
assert.equal(restored.sourceChangeId, source.id);
assert.deepEqual(restored.fields, ["description"]);
const detail = await api(`/issues/${issue.id}/history/${restored.id}`);
assert.deepEqual(detail.changes, [
  {
    field: "description",
    before: "Changed history body",
    after: "Original history body",
  },
]);
const replay = await api(`/issues/${issue.id}/restore`, "POST", {
  changeId: source.id,
  side: "before",
  fields: ["description"],
  revision: 2,
  operationId,
});
assert.equal(replay.issue.revision, 3);
assert.equal(replay.change.id, restored.id);
assert.equal((await api(`/issues/${issue.id}/history`)).length, 3);
console.log(`Container history smoke passed: ${phase}`);
