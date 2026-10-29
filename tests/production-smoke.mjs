import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const directory = mkdtempSync(join(tmpdir(), "sticker-production-smoke-"));
const origin = `http://127.0.0.1:${port}`,
  password = "ephemeral-production-smoke-password";
const child = spawn(process.execPath, ["dist/server/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: directory,
    APP_ORIGIN: origin,
    OWNER_PASSWORD: password,
    LOCAL_OWNER_MODE: "off",
    AGENT_CONFIG_PATH: "",
    GITHUB_READ_ENABLED: "false",
    GITHUB_CREDENTIAL_CONFIG_PATH: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => {
  logs += d;
});
child.stderr.on("data", (d) => {
  logs += d;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Production process exited: ${logs}`);
    try {
      const r = await fetch(`${origin}/healthz`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server may not have bound its listening socket yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready, `Production server never became ready: ${logs}`);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await page.text();
  assert.match(html, /스티커/);
  for (const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)])
    assert.equal((await fetch(origin + asset[1])).status, 200, asset[1]);
  assert.equal((await fetch(`${origin}/api/bootstrap`)).status, 401);
  const login = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const create = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ name: "Production fixture", key: "PROD" }),
  });
  assert.equal(create.status, 201);
  const bootstrap = await (
    await fetch(`${origin}/api/bootstrap`, { headers: { cookie } })
  ).json();
  assert.equal(bootstrap.projects[0].name, "Production fixture");
  console.log(
    "Production smoke passed: compiled server, health, SPA assets, security headers, private API, login, SQLite write.",
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  rmSync(directory, { recursive: true, force: true });
}
