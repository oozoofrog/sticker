import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mcpSettingsFixture,
  mcpSettingsPassword,
} from "./mcp-settings-fixture.js";
void test("packaged-route smoke validates actual HTTP ZIP without installing or mutating projects", async () => {
  const f = await mcpSettingsFixture();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["tests/container-agent-install-smoke.mjs"],
        {
          env: {
            ...process.env,
            OWNER_PASSWORD: mcpSettingsPassword,
            APP_ORIGIN: "http://localhost:8787",
            STICKER_SMOKE_API_URL: f.base,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Installer smoke timed out"));
      }, 30000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        try {
          assert.equal(code, 0, output);
          assert.ok(output.includes("no local installer executed"));
          resolve();
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Installer smoke assertion failed", { cause: error }),
          );
        }
      });
    });
  } finally {
    await f.close();
  }
});
