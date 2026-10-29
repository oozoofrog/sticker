import test from "node:test";
import assert from "node:assert/strict";
import "../packaging/agent-install/core.js";
import "../packaging/agent-install/flow.js";
const selection = {
  cwd: "/fixture",
  home: "/fixture",
  configFile: "/fixture/config.toml",
  wrapper: "/approved wrapper",
};
const manifest = {
  components: { mcp: true, skill: false },
  readTools: ["sticker_get_issue"],
};
function fixture({
  conflict = false,
  cancel = false,
  writeError = false,
} = {}) {
  let version = "r1",
    sticker,
    reads = 0,
    connects = 0,
    closed = 0;
  const calls = [];
  return {
    calls,
    get connects() {
      return connects;
    },
    get closed() {
      return closed;
    },
    io: {
      confirm: () => !cancel,
      connect() {
        connects++;
        return {
          notify() {},
          close() {
            closed++;
          },
          request(method, params) {
            calls.push({ method, params });
            if (method === "initialize") return {};
            if (method === "config/read") {
              reads++;
              if (conflict && reads === 2) version = "external";
              return {
                config: { mcp_servers: sticker ? { sticker } : {} },
                layers: [
                  {
                    name: { type: "user", file: selection.configFile },
                    version,
                    config: {},
                  },
                ],
              };
            }
            if (method === "config/batchWrite") {
              if (writeError) throw new Error("rpc_error");
              assert.equal(params.expectedVersion, "r1");
              sticker = params.edits[0].value;
              version = "read-r2";
              return { status: "ok", version: "different-write-version" };
            }
            if (method === "mcpServerStatus/list")
              return {
                data: [
                  {
                    name: "sticker",
                    serverInfo: { name: "sticker", version: "0.1.0" },
                    tools: { sticker_get_issue: {} },
                  },
                ],
              };
            throw new Error("unexpected_method");
          },
        };
      },
    },
  };
}
test("fresh CAS reads, precise edits, separate verification connection, and no authorization success inferred", () => {
  const f = fixture();
  const result = globalThis.StickerInstallFlow.run(f.io, selection, manifest);
  assert.equal(result.mcp, "discovered");
  assert.equal(result.apiAuthorization, "unverified");
  assert.equal(f.connects, 2);
  assert.equal(f.closed, 2);
  assert.equal(f.calls.filter((c) => c.method === "config/read").length, 3);
  assert.deepEqual(
    f.calls
      .find((c) => c.method === "config/batchWrite")
      .params.edits.map((e) => e.keyPath),
    ["mcp_servers.sticker"],
  );
  assert.ok(!JSON.stringify(result).includes("r1"));
});
test("cancel and fresh-read conflict never mutate or start discovery", () => {
  for (const options of [{ cancel: true }, { conflict: true }]) {
    const f = fixture(options);
    const result = globalThis.StickerInstallFlow.run(f.io, selection, manifest);
    assert.ok(result.cancelled || result.error === "config_changed");
    assert.equal(
      f.calls.some((c) => c.method === "config/batchWrite"),
      false,
    );
    assert.equal(f.connects, 1);
    assert.equal(f.closed, 1);
  }
});
test("ambiguous write result is not rolled back or retried and remains unverified", () => {
  const f = fixture({ writeError: true });
  const result = globalThis.StickerInstallFlow.run(f.io, selection, manifest);
  assert.equal(result.mcp, "write_pending");
  assert.equal(result.error, "rpc_error");
  assert.equal(
    f.calls.filter((c) => c.method === "config/batchWrite").length,
    1,
  );
});
test("existing twelve-tool registration is reused byte-for-byte and never batch-written", () => {
  const tools = [
    "sticker_get_issue",
    "sticker_get_session",
    "sticker_list_issues",
    "sticker_list_pending_requests",
    "sticker_list_projects",
    "sticker_report_session_event",
    "sticker_report_status",
    "sticker_update_issue",
    "sticker_add_comment",
    "sticker_create_issue",
    "sticker_list_sessions",
    "sticker_list_reports",
  ];
  const original = {
    command: "/fixture/approved-wrapper",
    args: ["secret-argument-not-exported"],
    enabled_tools: tools,
    env: { TOKEN: "secret-config-not-exported" },
    disabled_tools: [],
  };
  let writes = 0,
    connections = 0;
  const io = {
    confirm: () => true,
    connect() {
      connections++;
      return {
        notify() {},
        close() {},
        request(method) {
          if (method === "initialize") return {};
          if (method === "config/read")
            return {
              config: { mcp_servers: { sticker: original } },
              layers: [
                {
                  name: { type: "user", file: selection.configFile },
                  version: "same-version",
                  config: {},
                },
              ],
            };
          if (method === "config/batchWrite") {
            writes++;
            throw Error("unexpected_write");
          }
          return {
            data: [
              {
                name: "sticker",
                serverInfo: { name: "sticker", version: "0.1.0" },
                tools: Object.fromEntries(tools.map((t) => [t, {}])),
              },
            ],
          };
        },
      };
    },
  };
  const result = globalThis.StickerInstallFlow.run(io, selection, manifest);
  assert.equal(result.mcp, "discovered");
  assert.equal(writes, 0);
  assert.equal(connections, 2);
  assert.equal(original.enabled_tools.length, 12);
  assert.ok(!JSON.stringify(result).includes("secret-"));
});
test("initialization failure closes its own spawned connection and preserves cleanup uncertainty", () => {
  let closed = 0;
  const io = {
    connect() {
      return {
        request() {
          throw new Error("rpc_error");
        },
        notify() {},
        close() {
          closed++;
          throw new Error("cleanup_unverified");
        },
      };
    },
  };
  const result = globalThis.StickerInstallFlow.run(io, selection, manifest);
  assert.equal(closed, 1);
  assert.equal(result.error, "rpc_error");
  assert.equal(result.cleanup, "unverified");
});
test("partial plugin failure keeps phase evidence and does not roll back MCP or caches", () => {
  const f = fixture();
  let installed = 0;
  f.io.previewPlugin = () => ({ version: "1.0.0" });
  f.io.installPlugin = () => {
    installed++;
    throw new Error("plugin_install_unverified");
  };
  const result = globalThis.StickerInstallFlow.run(f.io, selection, {
    ...manifest,
    components: { mcp: true, skill: true },
  });
  assert.equal(installed, 1);
  assert.equal(result.mcp, "written_unverified");
  assert.equal(result.skill, "partial_possible");
  assert.equal(result.error, "plugin_install_unverified");
  assert.equal(
    f.calls.filter((c) => c.method === "config/batchWrite").length,
    1,
  );
  assert.equal(f.closed, 1);
});
