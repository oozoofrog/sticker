import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexMcpConfig } from "../client/features/mcp-settings/config.js";

void test("Codex config uses separate Docker STDIO arguments and forwards only the token variable name", () => {
  const result = buildCodexMcpConfig('/Volumes/Team "A"/스티커');
  assert.deepEqual(result, {
    command: "docker",
    args: [
      "compose",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-e",
      "STICKER_AGENT_TOKEN",
      "mcp",
    ],
    cwd: '/Volumes/Team "A"/스티커',
    envVars: ["STICKER_AGENT_TOKEN"],
    toml: String.raw`[mcp_servers.sticker]
command = "docker"
args = ["compose", "run", "--rm", "--no-deps", "-T", "-e", "STICKER_AGENT_TOKEN", "mcp"]
cwd = "/Volumes/Team \"A\"/스티커"
env_vars = ["STICKER_AGENT_TOKEN"]
startup_timeout_sec = 15
tool_timeout_sec = 30
`,
  });
});

void test("Codex paths preserve spaces, Unicode and backslashes without server-OS normalization or shell interpolation", () => {
  for (const [cwd, line] of [
    ["/Volumes/자료 😀/sticker", 'cwd = "/Volumes/자료 😀/sticker"'],
    [
      String.raw`C:\Team Space\스티커`,
      String.raw`cwd = "C:\\Team Space\\스티커"`,
    ],
    [
      String.raw`\\host\share\Sticker`,
      String.raw`cwd = "\\\\host\\share\\Sticker"`,
    ],
    [
      "/tmp/$(not-a-shell-command)/sticker",
      'cwd = "/tmp/$(not-a-shell-command)/sticker"',
    ],
  ]) {
    const config = buildCodexMcpConfig(cwd);
    assert.equal(config.cwd, cwd);
    assert.ok(config.toml.split("\n").includes(line));
    assert.equal(config.command, "docker");
    assert.ok(!config.args.includes(cwd));
  }
});

void test("Codex config rejects relative, ambiguous, control-character and malformed-Unicode paths before producing output", () => {
  for (const cwd of [
    "",
    " ",
    ".",
    "sticker",
    "~/sticker",
    "$HOME/sticker",
    "C:relative",
    String.raw`\root-relative`,
    String.raw`\\host`,
    "/tmp/\u0000sticker",
    "/tmp/\tsticker",
    "/tmp/\u007fsticker",
    "/tmp/\ud800",
    "/tmp/\udfff",
    "/" + "x".repeat(4096),
    '/tmp/sticker"\n[mcp_servers.injected]\ncommand = "danger"',
  ])
    assert.throws(() => buildCodexMcpConfig(cwd), /설치 위치/);
});
