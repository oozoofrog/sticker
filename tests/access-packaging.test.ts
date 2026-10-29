import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "sticker-access-package-"));
  const source = join(temp, 'Source " $ ` % 스티커');
  mkdirSync(source);
  for (const directory of ["scripts", "packaging"]) {
    cpSync(join(root, directory), join(source, directory), { recursive: true });
  }
  const bin = join(temp, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\n[ "$1 $2" = "context show" ] && echo desktop-linux\n',
    { mode: 0o755 },
  );
  const run = (...args: string[]) =>
    spawnSync("bash", [join(source, "scripts/install-access.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: temp,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });
  return {
    temp,
    source,
    run,
    close: () => {
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

void test("Linux entry installs explicit actions, escapes Exec and updates only owned files", () => {
  const f = fixture();
  try {
    const target = join(f.temp, "Sticker.desktop");
    const first = f.run("--linux", target);
    assert.equal(first.status, 0, first.stderr);
    const content = readFileSync(target, "utf8");
    assert.match(content, /Actions=Open;Status;Start;Stop;/);
    assert.match(content, /Terminal=true/);
    assert.match(content, /%%/);
    assert.match(content, /\\\\\$/);
    assert.match(content, /\\\\`/);
    assert.match(content, /\\\\"/);
    assert.equal(f.run("--linux", target).status, 0);
    assert.equal(readFileSync(target, "utf8"), content);
    writeFileSync(target, content.replace("Name=스티커", "Name=Personal edit"));
    assert.notEqual(f.run("--linux", target).status, 0);
    assert.match(readFileSync(target, "utf8"), /Personal edit/);
  } finally {
    f.close();
  }
});

void test("foreign entry and symlink targets remain untouched", () => {
  const f = fixture();
  try {
    const target = join(f.temp, "Other.desktop");
    writeFileSync(target, "foreign");
    assert.notEqual(f.run("--linux", target).status, 0);
    assert.equal(readFileSync(target, "utf8"), "foreign");
    const linked = join(f.temp, "linked.desktop");
    spawnSync("ln", ["-s", target, linked]);
    assert.notEqual(f.run("--linux", linked).status, 0);
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
  } finally {
    f.close();
  }
});

void test("headless and WSL print explicit commands without installing or starting services", () => {
  const f = fixture();
  try {
    const result = f.run("--headless");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sticker.sh/);
    assert.match(result.stdout, /status/);
    assert.match(result.stdout, /start/);
    assert.match(result.stdout, /URL/);
    const wsl = f.run("--wsl");
    assert.equal(wsl.status, 0, wsl.stderr);
    assert.match(wsl.stdout, /WSL/);
    assert.match(wsl.stdout, /미검증/);
  } finally {
    f.close();
  }
});

void test("newline target and missing parent reject without creating files", () => {
  const f = fixture();
  try {
    assert.notEqual(f.run("--linux", join(f.temp, "bad\n.desktop")).status, 0);
    assert.notEqual(
      f.run("--linux", join(f.temp, "missing", "x.desktop")).status,
      0,
    );
    assert.notEqual(f.run("--mac", join(f.temp, "Sticker.app")).status, 0);
  } finally {
    f.close();
  }
});

void test("Mac controller rejects malformed state and distinguishes browser dispatch from health", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: {
    StickerAccess?: {
      parse: (value: string) => { state: string; url: string | null };
      label: (value: string) => string;
    };
  } = {};
  assert.doesNotThrow(() =>
    runInNewContext(
      readFileSync(join(root, "packaging/macos/contract.js"), "utf8"),
      context,
    ),
  );
  const api = context.StickerAccess;
  assert.ok(api);
  const valid = {
    schemaVersion: 1,
    state: "ready",
    containerRunning: true,
    appResponse: "verified",
    browserReachability: "unverified",
    daemon: "local_socket",
    url: "http://127.0.0.1:8787",
    urlScope: "docker_host",
    reason: "none",
    action: "opened",
    lockName: "",
  };
  assert.equal(api.parse(JSON.stringify(valid)).state, "ready");
  assert.match(api.label(JSON.stringify(valid)), /브라우저 요청 전달/);
  assert.match(
    api.label(JSON.stringify({ ...valid, daemon: "remote" })),
    /원격 Docker/,
  );
  assert.equal(api.parse("{}").state, "unknown");
  assert.equal(api.parse("{bad").state, "unknown");
  assert.equal(
    api.parse(JSON.stringify({ ...valid, schemaVersion: 2 })).state,
    "unknown",
  );
  assert.equal(
    api.parse(JSON.stringify({ ...valid, url: "https://evil.example" })).state,
    "unknown",
  );
  assert.match(
    api.label(
      JSON.stringify({ ...valid, reason: "future_reason", action: "none" }),
    ),
    /상세 상태 미확인/,
  );
  assert.equal(
    api.parse(
      JSON.stringify({
        ...valid,
        state: "stopped",
        containerRunning: false,
        appResponse: "not_checked",
        url: null,
      }),
    ).state,
    "stopped",
  );
});

void test("installation pins context and rejects changed scope on repeat", () => {
  const f = fixture();
  try {
    const target = join(f.temp, "Sticker.desktop");
    assert.equal(f.run("--linux", target).status, 0);
    assert.match(
      readFileSync(target + ".sticker-manifest", "utf8"),
      /desktop-linux/,
    );
    writeFileSync(
      join(f.temp, "bin/docker"),
      "#!/bin/sh\necho other-context\n",
      { mode: 0o755 },
    );
    assert.notEqual(f.run("--linux", target).status, 0);
    assert.match(
      readFileSync(target + ".sticker-manifest", "utf8"),
      /desktop-linux/,
    );
  } finally {
    f.close();
  }
});
