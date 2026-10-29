// Executed inside the built runtime image, never against an operator's server.
import assert from "node:assert/strict";
const phase = process.argv[2];
assert.ok(
  ["initialize", "verify", "mutate"].includes(phase),
  "Unknown smoke phase",
);
const base = process.env.STICKER_SMOKE_API_URL ?? "http://127.0.0.1:8787";
const origin = process.env.APP_ORIGIN;
assert.ok(process.env.OWNER_PASSWORD, "Disposable fixture password required");
assert.equal((await fetch(`${base}/healthz`)).status, 200);
assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
const login = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ password: process.env.OWNER_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
async function api(path, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin,
      ...(body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${path}`);
  return response;
}
const bytes = "Sticker portable attachment fixture\n";
if (phase === "initialize") {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await page.text();
  assert.match(html, /스티커/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
  assert.ok(assets.length > 0, "Compiled SPA assets required");
  for (const [, asset] of assets)
    assert.equal((await fetch(base + asset)).status, 200);
  const initial = await (await api("/api/bootstrap")).json();
  assert.equal(
    initial.projects.length,
    0,
    "Disposable volume must start empty",
  );
  const project = await (
    await api(
      "/api/projects",
      "POST",
      { name: "Portable fixture", key: "PORT" },
      201,
    )
  ).json();
  const issue = await (
    await api(
      "/api/issues",
      "POST",
      { projectId: project.id, title: "Persisted container issue" },
      201,
    )
  ).json();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/plain" }), "fixture.txt");
  await api(`/api/issues/${issue.id}/attachments`, "POST", form, 201);
} else if (phase === "mutate") {
  const state = await (await api("/api/bootstrap")).json();
  await api(
    "/api/issues",
    "POST",
    { projectId: state.projects[0].id, title: "Must disappear on restore" },
    201,
  );
} else {
  const state = await (await api("/api/bootstrap")).json();
  assert.deepEqual(state.projects.map((p) => p.name).sort(), [
    "Container template fixture",
    "Portable fixture",
  ]);
  assert.deepEqual(
    state.issues.map((i) => i.title).sort(),
    [
      "Container history fixture",
      "Container shared resource reference",
      "Container template provenance fixture",
      "Persisted container issue",
    ],
    "Backup restore must replace later writes and preserve every fixture issue",
  );
  const core = state.issues.find(
    (i) => i.title === "Persisted container issue",
  );
  assert.ok(core);
  const detail = await (await api(`/api/issues/${core.id}`)).json();
  assert.equal(detail.attachments.length, 1);
  const path = `/api/attachments/${detail.attachments[0].id}/file`;
  assert.equal((await fetch(base + path)).status, 401, "Files remain private");
  assert.equal(
    await (await api(path)).text(),
    bytes,
    "Attachment bytes must persist",
  );
}
console.log(`Container HTTP smoke passed: ${phase}`);
