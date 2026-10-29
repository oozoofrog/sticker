import test from "node:test";
import assert from "node:assert/strict";
import "../packaging/agent-install/core.js";
const core = globalThis.StickerInstallCore;
const file = "/fixture user/.codex/config.toml";
function config(version = "read-v1", sticker) {
  return {
    config: { mcp_servers: sticker ? { sticker } : {} },
    layers: [{ name: { type: "user", file }, version, config: {} }],
  };
}
test("existing MCP is reuse-only and preserves command, arguments, disabled/enabled tools and secret fields", () => {
  const raw = config("r1", {
    command: "/approved wrapper",
    args: ["arg"],
    enabled_tools: ["sticker_get_issue"],
    disabled_tools: ["sticker_update_issue"],
    env: { SECRET: "never-project-this" },
  });
  const snapshot = core.projectConfig(raw, file);
  assert.ok(!JSON.stringify(snapshot).includes("never-project-this"));
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
  const plan = core.planMcp(snapshot, null, ["sticker_list_projects"]);
  assert.equal(plan.kind, "reuse");
  assert.deepEqual(plan.expectedTools, ["sticker_get_issue"]);
  assert.deepEqual(core.casEdits(snapshot, plan, snapshot), []);
});
test("new MCP CAS uses only a fresh read version and precise key; conflict never retries or replaces existing settings", () => {
  const snapshot = core.projectConfig(config(), file),
    plan = core.planMcp(snapshot, "/approved wrapper", ["sticker_get_issue"]);
  assert.deepEqual(core.casEdits(snapshot, plan, snapshot), [
    {
      keyPath: "mcp_servers.sticker",
      mergeStrategy: "upsert",
      value: {
        command: "/approved wrapper",
        args: [],
        enabled_tools: ["sticker_get_issue"],
      },
    },
  ]);
  const fresh = core.projectConfig(config("r2"), file);
  assert.throws(() => core.casEdits(snapshot, plan, fresh), /config_changed/);
  assert.throws(
    () => core.projectConfig(config(), "/another/config.toml"),
    /target_layer/,
  );
  assert.throws(
    () => core.planMcp(snapshot, null, ["sticker_get_issue"]),
    /credential_required/,
  );
});
test("RPC success cannot hide toolsError, null info, missing/extra tools or incomplete pagination", () => {
  const row = {
    name: "sticker",
    serverInfo: { name: "sticker", version: "0.1.0" },
    tools: { sticker_get_issue: {} },
    toolsError: null,
    authStatus: "unsupported",
    runtimeStatus: null,
  };
  assert.equal(
    core.checkStatus({ data: [row], nextCursor: null }, ["sticker_get_issue"])
      .status,
    "discovered",
  );
  for (const result of [
    { data: [] },
    { data: [row, row] },
    { data: [{ ...row, toolsError: "SECRET-error" }] },
    { data: [{ ...row, serverInfo: null }] },
    { data: [{ ...row, tools: {} }] },
    { data: [row], nextCursor: "more" },
  ])
    assert.throws(
      () => core.checkStatus(result, ["sticker_get_issue"]),
      /mcp_unverified/,
    );
});
test("NDJSON request IDs, split lines and interactive requests are bounded and never authorized", () => {
  let written = "";
  const chunks = ['{"id":1,"res', 'ult":{"ok":true}}\r\n'];
  const rpc = core.createRpc(
    {
      write: (line) => {
        written += line;
      },
      read: () => chunks.shift() ?? null,
    },
    () => 0,
  );
  assert.deepEqual(rpc.request("initialize", {}, 100), { ok: true });
  assert.ok(!written.includes('"jsonrpc"'));
  const interactive = core.createRpc(
    {
      write: (line) => {
        written += line;
      },
      read: () => '{"id":9,"method":"exec","params":{"command":"danger"}}\n',
    },
    () => 0,
  );
  assert.throws(
    () => interactive.request("initialize", {}, 100),
    /interactive_request/,
  );
  assert.ok(!written.includes('"code":-32601'));
  const wrong = core.createRpc(
    { write: () => {}, read: () => '{"id":88,"result":{}}\n' },
    () => 0,
  );
  assert.throws(() => wrong.request("initialize", {}, 100), /rpc_id/);
  const malformed = core.createRpc(
    { write: () => {}, read: () => "{bad}\n" },
    () => 0,
  );
  assert.throws(() => malformed.request("initialize", {}, 100), /rpc_json/);
});
test("manifest is fixed-scope and cannot supply a command, arbitrary skill, path or grant mutation", () => {
  const release = {
    skillHash: "a".repeat(64),
    readTools: ["sticker_get_issue"],
  };
  const manifest = {
    schemaVersion: 1,
    product: "Sticker",
    version: "1.0.0",
    target: "codex-mac",
    scope: "user",
    components: { mcp: true, skill: true },
    agent: {
      id: "existing",
      name: "Existing",
      canWrite: false,
      projectIds: [],
    },
    skill: {
      name: "sticker-workflow",
      version: "1.0.0",
      sha256: release.skillHash,
    },
    readTools: release.readTools,
    previewHash: "b".repeat(64),
  };
  assert.equal(core.validateManifest(manifest, release).version, "1.0.0");
  for (const value of [
    { ...manifest, command: "execute" },
    { ...manifest, scope: "project" },
    { ...manifest, skill: { ...manifest.skill, sha256: "c".repeat(64) } },
    { ...manifest, readTools: ["sticker_update_issue"] },
    { ...manifest, agent: { ...manifest.agent, token: "secret" } },
  ])
    assert.throws(
      () => core.validateManifest(value, release),
      /manifest_invalid/,
    );
});

test("skills verification requires enabled exact plugin identity and rejects discovery-only impostors", () => {
  const row = {
    name: "sticker-integration:sticker-workflow",
    pluginId: "sticker-integration@sticker-local",
    enabled: true,
    scope: "user",
    path: "/fixture/plugins/cache/sticker-local/sticker-integration/1.0.0/skills/sticker-workflow/SKILL.md",
  };
  assert.equal(
    core.checkSkills({ data: [{ skills: [row] }] }, "/fixture").status,
    "discovered",
  );
  for (const patch of [
    { enabled: false },
    { pluginId: "foreign@market" },
    { path: "/elsewhere/SKILL.md" },
  ])
    assert.throws(
      () =>
        core.checkSkills(
          { data: [{ skills: [{ ...row, ...patch }] }] },
          "/fixture",
        ),
      /skill_unverified/,
    );
});
test("plugin source stays inside the explicitly selected Codex home, never the operating home", () => {
  assert.equal(
    core.pluginRoot("/fixture/Codex user"),
    " /fixture/Codex user/sticker-installer/1.0.0".trim(),
  );
  for (const invalid of ["/fixture/../other", "relative", "/fixture\nother"])
    assert.throws(() => core.pluginRoot(invalid), /target_layer/);
});
test("fixed plugin contents are rechecked immediately before reuse, including missing files", () => {
  const files = { "skills/SKILL.md": "reviewed" };
  const disk = new Map([["/fixture/plugin/skills/SKILL.md", "reviewed"]]);
  const io = {
    exists: (p) => disk.has(p),
    read: (p) => disk.get(p),
    canonical: (p) => p,
  };
  assert.equal(
    core.validatePluginFiles("/fixture/plugin", files, io, true),
    true,
  );
  disk.set("/fixture/plugin/skills/SKILL.md", "USER EDIT AFTER PREVIEW");
  assert.throws(
    () => core.validatePluginFiles("/fixture/plugin", files, io, true),
    /plugin_conflict/,
  );
  disk.clear();
  assert.throws(
    () => core.validatePluginFiles("/fixture/plugin", files, io, true),
    /plugin_conflict/,
  );
  assert.equal(
    core.validatePluginFiles("/fixture/plugin", files, io, false),
    true,
  );
});
test("unsupported interactive IDs are never reflected into synchronous child writes", () => {
  for (const id of ["x".repeat(250000), { nested: ["object"] }, null, 9]) {
    const writes = [];
    const rpc = core.createRpc(
      {
        write: (line) => writes.push(line),
        read: () => JSON.stringify({ id, method: "exec", params: {} }) + "\n",
      },
      () => 0,
    );
    assert.throws(
      () => rpc.request("initialize", {}, 100),
      /interactive_request/,
    );
    assert.equal(writes.length, 1);
    assert.ok(writes[0].length < 100);
  }
});
test("oversized outgoing requests fail before a synchronous pipe write", () => {
  let writes = 0;
  const rpc = core.createRpc(
    {
      write() {
        writes++;
      },
      read() {
        return null;
      },
    },
    () => 0,
  );
  assert.throws(
    () => rpc.request("config/batchWrite", { path: "x".repeat(5000) }, 100),
    /rpc_write_limit/,
  );
  assert.equal(writes, 0);
});
