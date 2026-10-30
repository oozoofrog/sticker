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
    if (process.platform !== "darwin") {
      assert.notEqual(f.run("--mac", join(f.temp, "Sticker.app")).status, 0);
    }
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

void test("VM direct quit handler records busy requests and exits only when idle", async () => {
  const { runInNewContext } = await import("node:vm");
  let exits = 0;
  const context: {
    quit?: () => void;
    activeTask?: object | null;
    shouldQuit?: boolean;
    pendingAction?: string | null;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
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
  assert.throws(
    () => context.quit?.(),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "errorNumber" in error &&
      error.errorNumber === -128,
  );
  assert.equal(exits, 0);
  assert.equal(context.shouldQuit, true);
  context.activeTask = null;
  context.pendingAction = "start";
  context.quit();
  assert.equal(context.pendingAction, null);
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

void test("VM Dock queues open without a management window and confirms stop explicitly", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: {
    run?: () => void;
    reopen?: () => void;
    requestAction?: (action: string) => void;
    pendingAction?: string | null;
    confirmingStop?: boolean;
    activeTask?: object | null;
    ensureMenu?: () => void;
    ensureWindow?: () => void;
    render?: () => void;
    window?: object;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {},
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  assert.ok(context.requestAction);
  assert.ok(context.run);
  assert.ok(context.reopen);
  let shown = 0;
  context.ensureMenu = () => undefined;
  context.ensureWindow = () => undefined;
  context.render = () => undefined;
  context.window = {
    makeKeyAndOrderFront: () => {
      shown++;
    },
  };
  context.run();
  assert.equal(context.pendingAction, "open");
  context.requestAction("start");
  assert.equal(context.pendingAction, "open");
  context.reopen();
  assert.equal(shown, 0);
  assert.equal(context.pendingAction, "open");
  context.pendingAction = null;
  context.requestAction("stop");
  assert.equal(context.confirmingStop, true);
  assert.equal(context.pendingAction, null);
  context.requestAction("cancel-stop");
  assert.equal(context.confirmingStop, false);
  assert.equal(context.pendingAction, null);
  context.requestAction("stop");
  context.requestAction("confirm-stop");
  assert.equal(context.pendingAction, "stop");
  context.requestAction("confirm-stop");
  assert.equal(context.pendingAction, "stop");
  context.pendingAction = null;
  context.activeTask = {};
  context.requestAction("start");
  assert.equal(context.pendingAction, null);
});

void test("VM idle polls a live child once, cleans a completed child before exit, and reopening refreshes stale state", async () => {
  const { runInNewContext } = await import("node:vm");
  const order: string[] = [];
  const context: {
    idle?: () => number;
    reopen?: () => void;
    requestAppQuit?: () => void;
    activeTask?: { task: object };
    pendingAction?: string | null;
    snapshot?: string;
    ensureMenu?: () => void;
    ensureWindow?: () => void;
    render?: () => void;
    finishOperation?: () => void;
    window?: object;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {
      exit: () => {
        order.push("exit");
      },
    },
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8") +
      "\n" +
      readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  assert.ok(context.idle);
  assert.ok(context.requestAppQuit);
  assert.ok(context.reopen);
  context.render = () => undefined;
  context.ensureMenu = () => undefined;
  context.ensureWindow = () => undefined;
  context.window = { makeKeyAndOrderFront: () => undefined };
  context.snapshot = "old snapshot";
  context.reopen();
  assert.equal(context.pendingAction, "open");
  context.pendingAction = null;
  let polls = 0;
  let running = true;
  context.activeTask = {
    task: {
      get running() {
        polls++;
        return running;
      },
    },
  };
  context.finishOperation = () => {
    order.push("cleanup");
  };
  assert.equal(context.idle(), 1);
  assert.equal(polls, 1);
  context.requestAppQuit();
  assert.deepEqual(order, []);
  running = false;
  assert.equal(context.idle(), 1);
  assert.deepEqual(order, ["cleanup", "exit"]);
});

void test("VM completion discards stale health and cleans up when native output metadata is nil", async () => {
  const { runInNewContext } = await import("node:vm");
  const nil = Object.assign(() => undefined, { isNil: () => true });
  let cleaned = 0;
  const context: {
    finishOperation?: (operation: object) => void;
    cleanupOperation?: () => void;
    snapshot?: string;
    ObjC: unknown;
    $: unknown;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {
      NSFileManager: {
        defaultManager: { attributesOfItemAtPathError: () => nil },
      },
    },
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  assert.ok(context.finishOperation);
  context.cleanupOperation = () => {
    cleaned++;
  };
  context.snapshot = "previously ready";
  context.finishOperation({ output: "/fixture/missing" });
  assert.equal(context.snapshot, "");
  assert.equal(cleaned, 1);
});

void test("VM cwd diagnostic stops on first timeout, sends TERM only once, and never claims running-child cleanup", async () => {
  const { runInNewContext } = await import("node:vm");
  let now = 11000;
  let terms = 0;
  let closes = 0;
  let running = true;
  const events: string[] = [];
  const nil = Object.assign(() => undefined, { isNil: () => true });
  const context: {
    observe?: () => void;
    active?: object | null;
    halted?: boolean;
    index?: number;
    trace?: (event: string) => void;
    ObjC: unknown;
    $: unknown;
    Date: unknown;
  } = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {
      NSFileManager: {
        defaultManager: { attributesOfItemAtPathError: () => nil },
      },
    },
    Date: { now: () => now },
  };
  runInNewContext(
    readFileSync(
      join(root, "tests/fixtures/access-cwd-probe/probe.jxa"),
      "utf8",
    ),
    context,
  );
  assert.ok(context.observe);
  context.trace = (event: string) => {
    events.push(event);
  };
  context.active = {
    spec: { id: "fixture" },
    task: {
      get running() {
        return running;
      },
      processIdentifier: 123,
      terminationStatus: 0,
      get terminate() {
        terms++;
        return undefined;
      },
    },
    handle: {
      get closeFile() {
        closes++;
        return undefined;
      },
    },
    output: "/fixture/output",
    startedAt: 0,
    termAt: null,
    markerSeen: false,
    cleanupReported: false,
  };
  context.observe();
  assert.equal(terms, 1);
  assert.equal(context.halted, true);
  assert.equal(closes, 0);
  now = 17000;
  context.observe();
  context.observe();
  assert.equal(terms, 1);
  assert.equal(closes, 0);
  assert.equal(
    events.filter((event) => event === "cleanup-unconfirmed-stop").length,
    1,
  );
  assert.ok(context.active);
  running = false;
  context.observe();
  assert.equal(context.active, null);
  assert.equal(closes, 1);
  assert.equal(context.index, 0);
});

void test("VM start-and-open requires fresh ready health and coalesces Dock requests", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: Record<string, unknown> = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: { exit: () => undefined },
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8") +
      "\n" +
      readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  const action = context.requestAction as (value: string) => void;
  const completed = context.operationCompleted as (verb: string) => void;
  context.render = () => undefined;
  context.showProblem = () => undefined;
  context.hideProblem = () => undefined;
  context.snapshot = JSON.stringify({
    schemaVersion: 1,
    state: "stopped",
    containerRunning: false,
    appResponse: "not_checked",
    browserReachability: "unverified",
    urlScope: "docker_host",
    daemon: "local_socket",
    url: "http://localhost:8787",
    reason: "stopped",
    action: "none",
    lockName: "",
  });
  action("start-open");
  assert.equal(context.pendingAction, "start");
  action("open");
  action("open");
  assert.equal(context.pendingAction, "start");
  context.pendingAction = null;
  context.snapshot = "{}";
  assert.equal(typeof completed, "function");
  completed("start");
  assert.equal(context.pendingAction, null);
  context.snapshot = JSON.stringify({
    schemaVersion: 1,
    state: "stopped",
    containerRunning: false,
    appResponse: "not_checked",
    browserReachability: "unverified",
    urlScope: "docker_host",
    daemon: "local_socket",
    url: "http://localhost:8787",
    reason: "stopped",
    action: "none",
    lockName: "",
  });
  action("start-open");
  context.pendingAction = null;
  context.snapshot = JSON.stringify({
    schemaVersion: 1,
    state: "ready",
    containerRunning: true,
    appResponse: "verified",
    browserReachability: "unverified",
    urlScope: "docker_host",
    daemon: "local_socket",
    url: "http://localhost:8787",
    reason: "none",
    action: "started",
    lockName: "",
  });
  completed("start");
  assert.equal(context.pendingAction, "open");
  action("quit");
  assert.equal(context.pendingAction, null);
});

void test("VM native menu adapter retains its item and explicit controls without blocking menu tracking", async () => {
  const { runInNewContext } = await import("node:vm");
  type Item = {
    title: string;
    enabled?: boolean;
    submenu?: Menu;
    tag?: number;
  };
  type Menu = { items: Item[]; addItem: (item: Item) => void };
  const menus: Menu[] = [];
  let shown = 0;
  let methods: Record<string, { implementation: () => void }> = {};
  const native = {
    NSVariableStatusItemLength: -1,
    StickerAccessTarget: { alloc: { init: {} } },
    NSStatusBar: {
      systemStatusBar: {
        statusItemWithLength: () => ({
          button: { setAccessibilityLabel: () => undefined },
        }),
      },
    },
    NSMenu: {
      alloc: {
        initWithTitle: () => {
          const value: Menu = {
            items: [],
            addItem(item) {
              this.items.push(item);
            },
          };
          menus.push(value);
          return value;
        },
      },
    },
    NSMenuItem: {
      alloc: {
        initWithTitleActionKeyEquivalent: (title: string) => ({ title }),
      },
    },
    NSWindow: {
      alloc: {
        initWithContentRectStyleMaskBackingDefer: () => {
          shown++;
          throw new Error("normal Dock must not show a window");
        },
      },
    },
  };
  const context: Record<string, unknown> = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: (value: { methods: typeof methods }) => {
        methods = value.methods;
      },
    },
    $: native,
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8") +
      "\n" +
      readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  (context.run as () => void)();
  assert.equal(shown, 0);
  assert.equal(context.pendingAction, "open");
  assert.ok(context.statusItem);
  context.pendingAction = null;
  context.snapshot = JSON.stringify({
    schemaVersion: 1,
    state: "ready",
    containerRunning: true,
    appResponse: "verified",
    browserReachability: "unverified",
    urlScope: "docker_host",
    daemon: "local_socket",
    url: "http://localhost:8787",
    reason: "none",
    action: "opened",
    lockName: "",
  });
  (context.render as () => void)();
  assert.equal(menus[0]?.items[1]?.title.includes("\n"), false);
  context.pendingAction = "open";
  (context.render as () => void)();
  assert.deepEqual(
    menus[0]?.items
      .map((item) => item.title)
      .filter((title) => title !== "스티커 열기 중…"),
    ["스티커 열기", "새로고침", "서비스 시작", "서비스 중지", "앱 종료"],
  );
  assert.deepEqual(
    menus[1]?.items.map((item) => item.title),
    ["중지 확인", "취소"],
  );
  context.pendingAction = null;
  methods["menuWillOpen:"].implementation();
  assert.equal(context.pendingAction, null);
  context.pendingAction = null;
  const request = context.requestAction as (action: string) => void;
  request("cancel-stop");
  assert.equal(context.pendingAction, null);
  request("confirm-stop");
  assert.equal(context.pendingAction, "stop");
  request("open");
  assert.equal(context.openAfterCurrent, false);
});

void test("VM launch failure shows the compact problem state without leaving a task", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: Record<string, unknown> = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {},
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8") +
      "\n" +
      readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  let problems = 0;
  context.beginOperation = () => undefined;
  context.render = () => undefined;
  context.showProblem = () => {
    problems++;
  };
  context.pendingAction = "open";
  (context.idle as () => number)();
  assert.equal(problems, 1);
  assert.equal(context.activeTask, null);
  assert.equal(context.pendingAction, null);
});

void test("VM fresh ready health never converts failed or busy starts into successful automatic opening", async () => {
  const { runInNewContext } = await import("node:vm");
  const context: Record<string, unknown> = {
    ObjC: {
      import: () => undefined,
      bindFunction: () => undefined,
      registerSubclass: () => undefined,
    },
    $: {},
  };
  runInNewContext(
    readFileSync(join(root, "packaging/macos/contract.js"), "utf8") +
      "\n" +
      readFileSync(join(root, "packaging/macos/Sticker.jxa"), "utf8"),
    context,
  );
  const complete = context.operationCompleted as (verb: string) => void;
  let problems = 0;
  context.render = () => undefined;
  context.showProblem = () => {
    problems++;
  };
  const ready = (action: string, reason: string) =>
    JSON.stringify({
      schemaVersion: 1,
      state: "ready",
      containerRunning: true,
      appResponse: "verified",
      browserReachability: "unverified",
      urlScope: "docker_host",
      daemon: "local_socket",
      url: "http://localhost:8787",
      reason,
      action,
      lockName: "",
    });
  for (const [action, reason] of [
    ["failed", "mutation_failed"],
    ["busy", "mutation_busy"],
    ["started", "target_changed"],
    ["none", "unknown"],
    ["url_only", "none"],
  ] as const) {
    context.openAfterCurrent = true;
    context.pendingAction = null;
    context.snapshot = ready(action, reason);
    complete("start");
    assert.equal(context.pendingAction, null, `${action}/${reason}`);
  }
  assert.equal(problems, 5);
  for (const action of ["none", "started"]) {
    context.openAfterCurrent = true;
    context.pendingAction = null;
    context.snapshot = ready(action, "none");
    complete("start");
    assert.equal(context.pendingAction, "open", action);
  }
});

void test(
  "Mac native installation compiles and strictly signs the owned bundle",
  { skip: process.platform !== "darwin" },
  () => {
    const f = fixture();
    try {
      const target = join(f.temp, "Sticker.app");
      const result = f.run("--mac", target);
      assert.equal(result.status, 0, result.stderr);
      const executable = join(target, "Contents/MacOS/Sticker");
      assert.equal(lstatSync(executable).isFile(), true);
      assert.equal(
        spawnSync("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          target,
        ]).status,
        0,
      );
      assert.match(
        readFileSync(join(target, "Contents/Info.plist"), "utf8"),
        /org.oozoofrog.sticker.access/,
      );
      assert.match(result.stdout, /Swift/);
      const manifest = readFileSync(
        join(target, "Contents/Resources/sticker-source"),
        "utf8",
      );
      assert.equal(manifest.split("\n")[3], "desktop-linux");
      writeFileSync(
        join(f.temp, "bin/docker"),
        "#!/bin/sh\necho other-context\n",
        { mode: 0o755 },
      );
      assert.notEqual(f.run("--mac", target).status, 0);
      assert.equal(
        readFileSync(join(target, "Contents/Resources/sticker-source"), "utf8"),
        manifest,
      );
      assert.equal(
        spawnSync("/usr/bin/codesign", [
          "--verify",
          "--deep",
          "--strict",
          target,
        ]).status,
        0,
      );
    } finally {
      f.close();
    }
  },
);
