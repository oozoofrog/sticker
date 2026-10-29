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

void test("Linux control keeps pinned context/project and invokes the selected executable without shell expansion", () => {
  const f = fixture();
  try {
    const target = join(f.temp, "Sticker.desktop");
    assert.equal(f.run("--linux", target).status, 0);
    writeFileSync(
      join(f.source, "scripts/sticker.sh"),
      '#!/bin/bash\nprintf "%s|%s|%s|%s\\n" "$1" "$DOCKER_CONTEXT" "${COMPOSE_PROJECT_NAME:-unset}" "${DOCKER_HOST:-unset}"\ndocker context show\n',
    );
    const result = spawnSync(
      "bash",
      [
        join(f.source, "packaging/linux/control.sh"),
        target + ".sticker-manifest",
        "status",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: f.temp,
          DOCKER_CONTEXT: "wrong",
          DOCKER_HOST: "tcp://other",
          COMPOSE_PROJECT_NAME: "other-project",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status\|desktop-linux\|unset\|unset/);
    assert.match(result.stdout, /desktop-linux/);
  } finally {
    f.close();
  }
});

void test("Mac status supports the verified default HTTP port and rejects inconsistent ready responses", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: {
    StickerAccess?: {
      parse: (value: string) => { state: string; url: string | null };
    };
  } = {};
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8"),
    context,
  );
  const api = context.StickerAccess;
  assert.ok(api);
  const status = {
    schemaVersion: 1,
    state: "ready",
    containerRunning: true,
    appResponse: "verified",
    browserReachability: "unverified",
    daemon: "local_socket",
    url: "http://localhost",
    urlScope: "docker_host",
    reason: "none",
    action: "none",
    lockName: "",
  };
  assert.equal(api.parse(JSON.stringify(status)).url, "http://localhost");
  assert.equal(
    api.parse(JSON.stringify({ ...status, appResponse: "unavailable" })).state,
    "unknown",
  );
});

void test("running Mac app identity handles NFC/NFD and filesystem aliases", async () => {
  const { runInNewContext } = await import("node:vm");
  function running(target: string, actual: string, sameIdentity: boolean) {
    const context: {
      run?: (args: string[]) => string;
      ObjC: unknown;
      $: unknown;
    } = {
      ObjC: { import: () => undefined, unwrap: (value: unknown) => value },
      $: {
        NSWorkspace: {
          sharedWorkspace: {
            runningApplications: {
              count: 1,
              objectAtIndex: () => ({
                bundleURL: { isNil: () => false, path: actual },
              }),
            },
          },
        },
        NSFileManager: {
          defaultManager: {
            attributesOfItemAtPathError: (path: string) => ({
              isNil: () => false,
              objectForKey: (key: string) => ({
                isNil: () => false,
                stringValue:
                  key === "NSFileSystemNumber"
                    ? "1"
                    : sameIdentity || path === target
                      ? "101"
                      : "102",
              }),
            }),
          },
        },
      },
    };
    runInNewContext(
      readFileSync(join(root, "packaging/macos/is-running.jxa"), "utf8"),
      context,
    );
    assert.ok(context.run);
    return context.run([target]);
  }
  assert.equal(
    running(
      "/tmp/한글/Sticker.app",
      "/tmp/한글/Sticker.app".normalize("NFD"),
      false,
    ),
    "running",
  );
  assert.equal(running("/tmp/Sticker.app", "/tmp/alias.app", true), "running");
  assert.equal(running("/tmp/Sticker.app", "/tmp/Other.app", false), "stopped");
});

void test("Mac quit exits only its idle process and defers while a service operation is active", async () => {
  const { runInNewContext } = await import("node:vm");
  let exits = 0;
  const context: {
    quit?: () => void;
    activeTask?: object | null;
    shouldQuit?: boolean;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: { import: () => undefined, bindFunction: () => undefined },
    $: {
      exit: (status: number) => {
        assert.equal(status, 0);
        exits++;
      },
    },
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  assert.ok(context.quit);
  context.activeTask = {};
  context.quit();
  assert.equal(exits, 0);
  assert.equal(context.shouldQuit, true);
  context.activeTask = null;
  context.quit();
  assert.equal(exits, 1);
});

void test("Mac identity rejects bridged nil targets and skips nil/non-string running bundle paths", async () => {
  const { runInNewContext } = await import("node:vm");
  const nil = Object.assign(() => undefined, { isNil: () => true });
  const number = (value: string) => ({
    isNil: () => false,
    stringValue: value,
  });
  const attributes = {
    isNil: () => false,
    objectForKey: (key: string) =>
      number(key === "NSFileSystemNumber" ? "1" : "9007199254740993"),
  };
  const applications = [
    { bundleURL: nil },
    { bundleURL: { isNil: () => false, path: nil } },
    { bundleURL: { isNil: () => false, path: 123 } },
    {
      bundleURL: { isNil: () => false, path: "/tmp/한글.app".normalize("NFD") },
    },
  ];
  const context: {
    run?: (args: string[]) => string;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: { import: () => undefined, unwrap: (value: unknown) => value },
    $: {
      NSWorkspace: {
        sharedWorkspace: {
          runningApplications: {
            count: applications.length,
            objectAtIndex: (index: number) => applications[index],
          },
        },
      },
      NSFileManager: {
        defaultManager: {
          attributesOfItemAtPathError: (path: string) =>
            path === "/missing.app" ? nil : attributes,
        },
      },
    },
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/is-running.jxa"), "utf8"),
    context,
  );
  assert.ok(context.run);
  assert.equal(context.run(["/missing.app"]), "unknown");
  assert.equal(context.run(["/tmp/한글.app"]), "running");
  assert.equal(context.run(["relative.app"]), "unknown");
});

void test("nonmodal diagnostic queues no second start while busy or quitting", async () => {
  const { runInNewContext } = await import("node:vm");
  let start: (() => void) | undefined;
  const events: string[] = [];
  const context: {
    pending?: string | null;
    task?: object | null;
    quitRequested?: boolean;
    ObjC: unknown;
    trace: (event: string) => void;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: (definition: {
        methods: Record<string, { implementation: () => void }>;
      }) => {
        start = definition.methods["start:"].implementation;
      },
    },
    trace: (event: string) => {
      events.push(event);
    },
  };
  runInNewContext(
    readFileSync(
      join(root, "tests/fixtures/access-quit-probe/nonmodal.jxa"),
      "utf8",
    ),
    context,
  );
  assert.ok(start);
  start();
  assert.equal(context.pending, "start");
  context.pending = null;
  context.task = {};
  start();
  assert.equal(context.pending, null);
  context.task = null;
  context.quitRequested = true;
  start();
  assert.equal(context.pending, null);
  assert.equal(
    events.filter((event) => event === "button-start-queued").length,
    1,
  );
});

void test("diagnostic C separates internal quit from experimental AppleEvent cancellation", async () => {
  const { runInNewContext } = await import("node:vm");
  let exits = 0;
  const context: {
    quit?: () => void;
    idle?: () => number;
    task?: object | null;
    pending?: string | null;
    quitRequested?: boolean;
    ObjC: unknown;
    $: unknown;
    trace: () => void;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {
      exit: () => {
        exits++;
      },
    },
    trace: () => undefined,
  };
  const base = readFileSync(
    join(root, "tests/fixtures/access-quit-probe/nonmodal.jxa"),
    "utf8",
  ).replace("pending = null; quit();", "pending = null; requestQuit();");
  runInNewContext(
    base +
      "\n" +
      readFileSync(
        join(root, "tests/fixtures/access-quit-probe/cancel.jxa"),
        "utf8",
      ),
    context,
  );
  assert.ok(context.quit);
  assert.ok(context.idle);
  context.task = { running: true };
  assert.throws(
    () => context.quit?.(),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "errorNumber" in error &&
      error.errorNumber === -128,
  );
  assert.equal(context.quitRequested, true);
  assert.equal(exits, 0);
  context.pending = "quit";
  assert.equal(context.idle(), 1);
  assert.equal(exits, 0);
  context.task = null;
  context.quit();
  assert.equal(exits, 1);
});
