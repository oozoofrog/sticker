import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
void test("Docker access snapshot captures logical SQLite rows and immutable upload bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "access-snapshot-"));
  try {
    mkdirSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads", "fixture.txt"), "preserved");
    const db = new DatabaseSync(join(root, "sticker.sqlite"));
    db.exec(
      "CREATE TABLE records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO records VALUES ('one','kept')",
    );
    db.close();
    const run = () =>
      spawnSync(process.execPath, ["tests/container-access-snapshot.mjs"], {
        env: { ...process.env, DATA_DIR: root },
        encoding: "utf8",
      });
    const before = run();
    assert.equal(before.status, 0, before.stderr);
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, before.stdout);
    assert.ok(before.stdout.includes("kept"));
    writeFileSync(join(root, "uploads", "fixture.txt"), "changed");
    const changed = run();
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(changed.stdout, before.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("Docker access contract checker preserves readiness versus browser-evidence distinction", () => {
  const value = {
    schemaVersion: 1,
    state: "ready",
    containerRunning: true,
    appResponse: "verified",
    browserReachability: "unverified",
    urlScope: "docker_host",
    url: "http://localhost:9876",
    action: "url_only",
  };
  const run = (input: unknown) =>
    spawnSync(
      process.execPath,
      ["tests/container-access-smoke.mjs", "url_only"],
      {
        input: JSON.stringify(input),
        env: { ...process.env, APP_ORIGIN: value.url },
        encoding: "utf8",
      },
    );
  assert.equal(run(value).status, 0);
  assert.notEqual(run({ ...value, state: "starting" }).status, 0);
  assert.notEqual(run({ ...value, browserReachability: "verified" }).status, 0);
});
