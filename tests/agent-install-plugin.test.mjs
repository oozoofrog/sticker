import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
test("actual installer apply revalidates edited reviewed contents even when reusing an installed plugin", () => {
  const source = readFileSync(
    new URL("../packaging/agent-install/installer.jxa.js", import.meta.url),
    "utf8",
  );
  const owned = source.slice(
    source.indexOf("    function checkOwnedRoot()"),
    source.indexOf("    const selection ="),
  );
  const preview = source
    .slice(
      source.indexOf("        previewPlugin() {"),
      source.indexOf("        confirm(plan) {"),
    )
    .trim()
    .replace(/,$/, "");
  const install = source
    .slice(
      source.indexOf("        installPlugin(plan) {"),
      source.indexOf("        skillsParams() {"),
    )
    .trim()
    .replace(/,$/, "");
  const root = "/fixture/Sticker/AgentInstall/1.0.0";
  const files = {
    ".agents/plugins/marketplace.json": "reviewed market",
    "plugins/sticker-integration/.codex-plugin/plugin.json": "reviewed plugin",
    "plugins/sticker-integration/skills/sticker-workflow/SKILL.md":
      "reviewed skill",
    "plugins/sticker-integration/skills/sticker-workflow/agents/openai.yaml":
      "explicit only",
  };
  const marker = "owned-marker";
  const state = new Map([
    [root + "/sticker-install.json", marker],
    ...Object.entries(files).map(([p, c]) => [root + "/" + p, c]),
  ]);
  const entries = new Set(["sticker-install.json", ...Object.keys(files)]);
  for (const f of Object.keys(files)) {
    const parts = f.split("/");
    while (parts.length > 1) {
      parts.pop();
      entries.add(parts.join("/"));
    }
  }
  const listed = {
    installed: [
      {
        pluginId: "sticker-integration@sticker-local",
        name: "sticker-integration",
        marketplaceName: "sticker-local",
        version: "1.0.0",
        installed: true,
        enabled: true,
        source: {
          source: "local",
          path: root + "/plugins/sticker-integration",
        },
        marketplaceSource: { sourceType: "local", source: root },
      },
    ],
  };
  const commands = [];
  const context = {
    root,
    files,
    marker,
    cli: "/fixture/codex",
    environment: {},
    codexHome: "/fixture/codex-home",
    ObjC: { deepUnwrap: (v) => v },
    fm: {
      fileExistsAtPath: (p) => p === root || state.has(p),
      subpathsAtPath: () => [...entries],
    },
    canonical: (p) => p,
    text: (p) => {
      if (!state.has(p)) throw new Error("missing");
      return state.get(p);
    },
    fail: (code) => {
      throw new Error(code);
    },
    jsonCommand: (_cli, args) => {
      commands.push(args);
      return listed;
    },
    ensureDirectory() {
      throw new Error("unexpected directory write");
    },
    write() {
      throw new Error("unexpected file write");
    },
  };
  vm.createContext(context);
  vm.runInContext(
    readFileSync(
      new URL("../packaging/agent-install/core.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  context.core = context.StickerInstallCore;
  vm.runInContext(
    owned + "\nglobalThis.methods={" + preview + "," + install + "};",
    context,
  );
  const plan = context.methods.previewPlugin();
  state.set(
    root + "/plugins/sticker-integration/skills/sticker-workflow/SKILL.md",
    "USER EDIT AFTER PREVIEW",
  );
  let result;
  try {
    context.methods.installPlugin(plan);
    result = {
      outcome: "accepted",
      plan,
      editedSkillRetained: state.get(
        root + "/plugins/sticker-integration/skills/sticker-workflow/SKILL.md",
      ),
      commands,
    };
  } catch (e) {
    result = { outcome: "rejected", error: String(e) };
  }
  assert.equal(result.outcome, "rejected");
  assert.match(result.error, /plugin_conflict/);
  assert.equal(commands.length, 1);
  assert.equal(
    state.get(
      root + "/plugins/sticker-integration/skills/sticker-workflow/SKILL.md",
    ),
    "USER EDIT AFTER PREVIEW",
  );
});
