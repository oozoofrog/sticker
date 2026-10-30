import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./native/dedicated-window/SwiftProbe.swift", import.meta.url),
  "utf8",
);
void test("Swift feasibility source retains official delegates and isolated store without a scripting bridge", () => {
  for (const name of [
    "NSApplicationDelegate",
    "NSWindowDelegate",
    "WKNavigationDelegate",
    "WKUIDelegate",
    "WKDownloadDelegate",
  ])
    assert.ok(source.includes(name));
  assert.ok(source.includes("settings.websiteDataStore = .nonPersistent()"));
  assert.ok(source.includes("@MainActor"));
  assert.doesNotMatch(
    source,
    /WKScriptMessageHandler|dlopen|unsafeBitCast|evaluateJavaScript/,
  );
});
void test("Swift fixture source exposes separate redirect and response gates and panel-safe quit", () => {
  assert.match(source, /decidePolicyFor response: WKNavigationResponse/);
  assert.match(source, /willPerformHTTPRedirection/);
  assert.match(source, /download_redirect_denied.*decisionHandler\(\.cancel\)/);
  assert.match(
    source,
    /pendingPanels > 0.*quit_cancelled_for_panel.*terminateCancel/,
  );
  assert.match(source, /fileExists\(atPath: url.path\)/);
  assert.doesNotMatch(source, /removeItem|replaceItem|createFile/);
});
void test("Swift fixture build does not auto-install tools or launch apps", () => {
  const build = readFileSync(
    new URL("./native/dedicated-window/build-swift.sh", import.meta.url),
    "utf8",
  );
  assert.match(build, /xcrun --find swiftc/);
  assert.match(build, /codesign --verify --deep --strict/);
  assert.doesNotMatch(
    build,
    /xcode-select --install|brew |sudo |open -|osascript/,
  );
});

void test("Swift download redirect native gate has a real synthetic trigger and target evidence", () => {
  const page = readFileSync(
    new URL("./native/dedicated-window/page.html", import.meta.url),
    "utf8",
  );
  const server = readFileSync(
    new URL("./native/dedicated-window/server.mjs", import.meta.url),
    "utf8",
  );
  assert.match(page, /href="\/download-redirect" download=/);
  assert.match(server, /download_redirect_response/);
  assert.match(server, /download_redirect_target_UNEXPECTED/);
});
