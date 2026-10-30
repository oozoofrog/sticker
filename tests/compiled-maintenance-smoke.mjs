import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const dir = mkdtempSync(join(tmpdir(), "sticker-compiled-drain-")),
  origin = `http://127.0.0.1:${port}`,
  password = "synthetic-maintenance-password";
const child = spawn(process.execPath, ["dist/server/index.js"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dir,
    APP_ORIGIN: origin,
    OWNER_PASSWORD: password,
    LOCAL_OWNER_MODE: "off",
    AGENT_CONFIG_PATH: "",
    GITHUB_READ_ENABLED: "false",
    GITHUB_CREDENTIAL_CONFIG_PATH: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let upload;
const exited = new Promise((r) =>
  child.once("exit", (code, signal) => r({ code, signal })),
);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("Fixture server exited");
    try {
      ready = (await fetch(`${origin}/readyz`)).ok;
      if (ready) break;
    } catch {
      /* The isolated child may not have opened its listening socket yet. */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(ready);
  const login = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const body = JSON.stringify({
    name: "must not be created after shutdown",
    key: "DRAIN",
  });
  const response = new Promise((resolve, reject) => {
    upload = request(
      `${origin}/api/projects`,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      },
    );
    upload.once("error", reject);
  });
  void response.catch(() => {});
  // Drain must also wait a request that is still inside the JSON parser.
  upload.write(body.slice(0, 5));
  await new Promise((r) => setTimeout(r, 100));
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    child.signalCode,
    null,
    "second SIGTERM must not default-terminate an in-flight server",
  );
  assert.equal(
    child.exitCode,
    null,
    "in-flight request must keep graceful drain pending",
  );
  upload.end(body.slice(5));
  assert.equal(await response, 503);
  assert.deepEqual(await exited, { code: 0, signal: null });
  console.log(
    "Compiled maintenance passed: duplicate real SIGTERM, pending HTTP parser, 503 admission and graceful exit0.",
  );
} finally {
  upload?.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(dir, { recursive: true, force: true });
}
