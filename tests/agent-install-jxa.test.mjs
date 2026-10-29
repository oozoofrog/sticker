import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("Foundation truthy nil proxies are rejected separately from JavaScript null", () => {
  const dollar = () => ({
    dataUsingEncoding() {
      return {};
    },
  });
  dollar.NSUTF8StringEncoding = 4;
  const sandbox = { ObjC: { import() {}, registerSubclass() {} }, $: dollar };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(
      new URL("../packaging/agent-install/process.jxa.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  const proxy = function () {};
  proxy.isNil = () => true;
  assert.equal(sandbox.StickerHostProcess.isNil(proxy), true);
  assert.equal(sandbox.StickerHostProcess.isNil(null), true);
  assert.equal(sandbox.StickerHostProcess.isNil(undefined), true);
  assert.equal(sandbox.StickerHostProcess.isNil({ isNil: () => false }), false);
});
test("local launcher source contains no Gatekeeper bypass, mcp add, token creation or shell-string execution", () => {
  const source = readFileSync(
    new URL("../packaging/agent-install/installer.jxa.js", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "xattr",
    "spctl",
    "doShellScript",
    'mcp","add',
    'mcp", "add',
    "launchctl",
  ])
    assert.ok(!source.includes(forbidden));
  assert.ok(source.includes("codesign"));
  assert.ok(source.includes("2DC432GLL2"));
  assert.ok(source.includes("generate-json-schema"));
  assert.ok(source.includes("checkOwnedRoot"));
});
test("post-launch reader failure cleans its own child even if the run-loop pump also fails", () => {
  let running = false,
    pipeIndex = 0,
    terminated = 0,
    closed = 0;
  const task = {
    launch() {
      running = true;
    },
    get isRunning() {
      return running;
    },
    terminate() {
      terminated++;
      running = false;
    },
  };
  const dollar = (value) => ({
    dataUsingEncoding() {
      return value;
    },
  });
  Object.assign(dollar, {
    NSUTF8StringEncoding: 4,
    NSTask: { alloc: { init: task } },
    NSPipe: {
      get pipe() {
        const i = pipeIndex++;
        return {
          fileHandleForReading: {
            fileDescriptor: 100 + i,
            readInBackgroundAndNotify() {
              throw Error("reader failure");
            },
            closeFile() {
              closed++;
            },
          },
          fileHandleForWriting: {
            closeFile() {
              closed++;
            },
          },
        };
      },
    },
    NSMutableData: {
      get data() {
        return { setLength() {} };
      },
    },
    NSNotificationCenter: {
      defaultCenter: {
        addObserverSelectorNameObject() {},
        removeObserver() {},
      },
    },
  });
  const sandbox = {
    $: dollar,
    ObjC: {
      import() {},
      registerSubclass() {
        dollar.StickerInstallPipeObserverV1 = { alloc: { init: {} } };
      },
      bindFunction() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(
      new URL("../packaging/agent-install/process.jxa.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  assert.throws(
    () => sandbox.StickerHostProcess.spawn("/fixture/cli", [], {}, "/fixture"),
    /process_start/,
  );
  assert.equal(running, false);
  assert.equal(terminated, 1);
  assert.ok(closed >= 3);
});
