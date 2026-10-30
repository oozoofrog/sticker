import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = resolve(import.meta.dirname, "native/dedicated-window");
type Policy = {
  origin: (url: string) => string | null;
  navigation: (input: {
    origin: string;
    url: string;
    sourceOrigin: string | null;
    mainFrame: boolean;
    link: boolean;
    download: boolean;
  }) => string;
  once: (callback: (value: unknown) => void) => (value: unknown) => boolean;
};
function policy(): Policy {
  const path = resolve(root, "policy.js");
  assert.ok(existsSync(path), "native feasibility policy must exist");
  const context: { WindowProbePolicy?: Policy } = {};
  runInNewContext(readFileSync(path, "utf8"), context);
  assert.ok(context.WindowProbePolicy);
  return context.WindowProbePolicy;
}
void test("fixture origin normalizes port80 and rejects nonexact loopback or userinfo", () => {
  const p = policy();
  assert.equal(p.origin("http://127.0.0.1:80/a"), "http://127.0.0.1:80");
  assert.equal(p.origin("http://127.0.0.1/a"), "http://127.0.0.1:80");
  for (const url of [
    "http://localhost.evil/",
    "http://user@localhost/",
    "http://ｌocalhost/",
    "file:///tmp/a",
    "http://127.0.0.1:0",
    "http://localhost:65536",
    "http://localhost\\@evil/",
  ])
    assert.equal(p.origin(url), null);
});
void test("fixture navigation allows trusted sameorigin and cancels automatic external or untrusted frames", () => {
  const p = policy(),
    origin = "http://127.0.0.1:8787";
  const input = {
    origin,
    url: origin + "/a",
    sourceOrigin: origin,
    mainFrame: true,
    link: true,
    download: false,
  };
  assert.equal(p.navigation(input), "allow");
  assert.equal(
    p.navigation({ ...input, url: "https://example.com/" }),
    "external",
  );
  assert.equal(
    p.navigation({ ...input, url: "https://example.com/", link: false }),
    "cancel",
  );
  assert.equal(
    p.navigation({ ...input, url: "https://example.com/", mainFrame: false }),
    "cancel",
  );
  assert.equal(
    p.navigation({
      ...input,
      url: "https://example.com/",
      sourceOrigin: "http://other",
    }),
    "cancel",
  );
  assert.equal(
    p.navigation({ ...input, url: "javascript:alert(1)" }),
    "cancel",
  );
  for (const url of [
    "https:///broken",
    "https://user@host/",
    "https://example.com:99999/",
    "https://example.com\\evil/",
  ]) {
    assert.equal(p.navigation({ ...input, url }), "cancel");
  }
  assert.equal(
    p.navigation({ ...input, url: "blob:" + origin + "/uuid", download: true }),
    "download",
  );
  assert.equal(
    p.navigation({ ...input, url: "blob:" + origin + "/uuid" }),
    "cancel",
  );
  assert.equal(
    p.navigation({
      ...input,
      url: "blob:http://localhost:8787/uuid",
      download: true,
    }),
    "cancel",
  );
});
void test("native decision wrapper invokes callback at most once even if callback throws", () => {
  let calls = 0;
  const once = policy().once(() => {
    calls++;
    throw new Error("native callback unavailable");
  });
  assert.throws(() => once(false), /unavailable/);
  assert.equal(once(true), false);
  assert.equal(calls, 1);
});

void test("fixture run/reopen focuses retained content without reconstructing it", () => {
  type FixtureWindow = {
    makeKeyAndOrderFront: () => void;
    draft: string;
    route: string;
    scroll: number;
  };
  const context: {
    ObjC: unknown;
    $: unknown;
    console: unknown;
    contentWindow?: FixtureWindow;
    stopped?: boolean;
    createWindow?: () => void;
    run?: () => void;
    reopen?: () => void;
  } = {
    ObjC: { import: () => undefined, registerSubclass: () => undefined },
    $: {
      NSApplication: {
        sharedApplication: { activateIgnoringOtherApps: () => undefined },
      },
    },
    console: { log: () => undefined },
  };
  runInNewContext(readFileSync(resolve(root, "Probe.jxa"), "utf8"), context);
  let created = 0,
    focused = 0;
  context.createWindow = () => {
    created++;
    context.contentWindow = {
      makeKeyAndOrderFront: () => {
        focused++;
      },
      draft: "draft",
      route: "#draft",
      scroll: 500,
    };
  };
  assert.ok(context.run);
  assert.ok(context.reopen);
  context.run();
  const original = context.contentWindow;
  for (let count = 0; count < 10; count++) context.reopen();
  assert.equal(created, 1);
  assert.equal(focused, 11);
  assert.equal(context.contentWindow, original);
  assert.ok(context.contentWindow);
  assert.equal(context.contentWindow.draft, "draft");
  assert.equal(context.contentWindow.route, "#draft");
  assert.equal(context.contentWindow.scroll, 500);
  context.stopped = true;
  context.reopen();
  assert.equal(focused, 11);
  assert.equal(created, 1);
});
