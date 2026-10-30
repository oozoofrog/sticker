// Disposable compose fixture; credentials stay inside this process and never print.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const base = "http://127.0.0.1:8787",
  phase = process.argv[2];
assert.ok(["exercise", "verify"].includes(phase));
const login = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: process.env.APP_ORIGIN,
  },
  body: JSON.stringify({ password: process.env.OWNER_PASSWORD }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
async function request(path, method = "GET", body) {
  return fetch(`${base}/api${path}`, {
    method,
    headers: {
      cookie,
      origin: process.env.APP_ORIGIN,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
async function value(path, method = "GET", body) {
  const r = await request(path, method, body);
  assert.ok(r.ok, `${path}: ${r.status}`);
  return r.json();
}
const initial = await value("/maintenance");
assert.equal(initial.state, "serving");
if (phase === "verify") {
  assert.notEqual(initial.instanceId, process.argv[3]);
  assert.equal(
    (
      await request("/maintenance/resume", "POST", {
        instanceId: process.argv[3],
        revision: 0,
        confirm: true,
      })
    ).status,
    409,
  );
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  console.error(
    "Maintenance restart verified: serving, new instance, stale control rejected.",
  );
} else {
  const before = await value("/bootstrap");
  const client = new Client({
    name: "maintenance-container-fixture",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["/app/dist/server/mcp.js"],
    env: {
      PATH: process.env.PATH,
      STICKER_API_URL: base,
      STICKER_AGENT_TOKEN: process.env.STICKER_AGENT_TOKEN,
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const agentDenied = await fetch(`${base}/api/maintenance/begin`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.STICKER_AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        instanceId: initial.instanceId,
        revision: initial.revision,
        confirm: true,
      }),
    });
    assert.equal(agentDenied.status, 403);
    const draining = await value("/maintenance/begin", "POST", {
      instanceId: initial.instanceId,
      revision: initial.revision,
      confirm: true,
    });
    assert.equal(draining.state, "draining");
    assert.equal(draining.drained, true);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    const blocked = await client.callTool({
      name: "sticker_list_projects",
      arguments: {},
    });
    assert.equal(blocked.isError, true);
    const error = JSON.parse(blocked.content[0].text);
    assert.equal(error.code, "MAINTENANCE");
    assert.equal(error.retryAfterSeconds, 5);
    assert.equal(error.maintenance.instanceId, initial.instanceId);
    const resumed = await value("/maintenance/resume", "POST", {
      instanceId: draining.instanceId,
      revision: draining.revision,
      confirm: true,
    });
    const result = await client.callTool({
      name: "sticker_list_projects",
      arguments: {},
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(await value("/bootstrap"), before);
    await value("/maintenance/begin", "POST", {
      instanceId: resumed.instanceId,
      revision: resumed.revision,
      confirm: true,
    });
    console.error(
      "Maintenance STDIO verified: owner gate, drain rejection, same bridge explicit recovery, data unchanged.",
    );
    process.stdout.write(initial.instanceId);
  } finally {
    await client.close();
  }
}
