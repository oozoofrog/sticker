import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../server/app.js";
void test("Docker trusted-owner HTTP fixture exercises real isolated native API before hosted Docker execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-container-fixture-"));
  const token = "disposable-local-fixture-agent";
  const origin = "http://127.0.0.1:43129";
  const instance = createApp({
    dataDir: directory,
    ownerPassword: "",
    localOwnerMode: "trusted-loopback",
    appOrigin: origin,
    agents: [
      {
        id: "fixture",
        name: "Fixture",
        tokenHash: createHash("sha256").update(token).digest("hex"),
        projectIds: null,
        canWrite: false,
      },
    ],
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(
      process.execPath,
      ["tests/container-local-owner-smoke.mjs"],
      {
        env: {
          ...process.env,
          STICKER_SMOKE_API_URL: `http://127.0.0.1:${String(address.port)}`,
          APP_ORIGIN: origin,
          LOCAL_OWNER_MODE: "trusted-loopback",
          OWNER_PASSWORD: "",
          STICKER_AGENT_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (value: Buffer) => {
      output += value.toString();
    });
    child.stderr.on("data", (value: Buffer) => {
      output += value.toString();
    });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(status, 0, output);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    instance.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
