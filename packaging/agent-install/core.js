/* Fixed portable protocol/policy core. No filesystem, subprocess, network or logging. */
globalThis.StickerInstallCore = (() => {
  function fail(code) {
    throw new Error(code);
  }
  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function own(value, key) {
    return object(value) && Object.prototype.hasOwnProperty.call(value, key);
  }
  function string(value, max = 4096) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      !/[\0\r\n]/.test(value)
    );
  }
  function path(value) {
    return (
      string(value) &&
      value.startsWith("/") &&
      !value.split("/").some((part) => part === "." || part === "..")
    );
  }
  function tools(value) {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 100 ||
      value.some(
        (item) =>
          typeof item !== "string" || !/^sticker_[a-z_]{1,100}$/.test(item),
      ) ||
      new Set(value).size !== value.length
    )
      fail("tools_scope");
    return [...value].sort();
  }
  function exact(value, keys) {
    return (
      object(value) &&
      Object.keys(value).sort().join("|") === keys.slice().sort().join("|")
    );
  }
  function validateManifest(value, release) {
    if (
      !exact(value, [
        "schemaVersion",
        "product",
        "version",
        "target",
        "scope",
        "components",
        "agent",
        "skill",
        "readTools",
        "previewHash",
      ]) ||
      value.schemaVersion !== 1 ||
      value.product !== "Sticker" ||
      value.version !== "1.0.0" ||
      value.target !== "codex-mac" ||
      value.scope !== "user"
    )
      fail("manifest_invalid");
    if (
      !exact(value.components, ["mcp", "skill"]) ||
      typeof value.components.mcp !== "boolean" ||
      typeof value.components.skill !== "boolean" ||
      (!value.components.mcp && !value.components.skill)
    )
      fail("manifest_invalid");
    if (
      !exact(value.skill, ["name", "version", "sha256"]) ||
      value.skill.name !== "sticker-workflow" ||
      value.skill.version !== "1.0.0" ||
      value.skill.sha256 !== release.skillHash ||
      !string(value.previewHash, 64) ||
      !/^[a-f0-9]{64}$/.test(value.previewHash)
    )
      fail("manifest_invalid");
    if (JSON.stringify(value.readTools) !== JSON.stringify(release.readTools))
      fail("manifest_invalid");
    if (value.components.mcp) {
      const agent = value.agent;
      if (
        !exact(agent, ["id", "name", "canWrite", "projectIds"]) ||
        !string(agent.id, 80) ||
        !string(agent.name, 80) ||
        typeof agent.canWrite !== "boolean" ||
        (agent.projectIds !== null &&
          (!Array.isArray(agent.projectIds) ||
            agent.projectIds.length > 1000 ||
            agent.projectIds.some((id) => !string(id, 100))))
      )
        fail("manifest_invalid");
    } else if (value.agent !== null) fail("manifest_invalid");
    return value;
  }
  function validatePluginFiles(root, files, io, complete) {
    for (const [relative, content] of Object.entries(files)) {
      const file = root + "/" + relative;
      if (io.canonical(file) !== file) fail("plugin_conflict");
      if (!io.exists(file)) {
        if (complete) fail("plugin_conflict");
      } else if (io.read(file) !== content) fail("plugin_conflict");
    }
    return true;
  }
  function pluginRoot(home) {
    if (!path(home)) fail("target_layer");
    return home + "/sticker-installer/1.0.0";
  }
  function projectConfig(raw, expectedFile) {
    if (!object(raw) || !path(expectedFile) || !Array.isArray(raw.layers))
      fail("target_layer");
    const matches = raw.layers.filter(
      (layer) =>
        object(layer) &&
        object(layer.name) &&
        layer.name.type === "user" &&
        layer.name.file === expectedFile,
    );
    if (matches.length !== 1 || !string(matches[0].version, 500))
      fail("target_layer");
    const config = raw.config;
    if (!object(config)) fail("config_shape");
    const servers = own(config, "mcp_servers") ? config.mcp_servers : {};
    if (!object(servers)) fail("config_shape");
    let existing = null;
    if (own(servers, "sticker")) {
      const value = servers.sticker;
      if (
        !object(value) ||
        !path(value.command) ||
        (own(value, "args") &&
          (!Array.isArray(value.args) || value.args.length > 100))
      )
        fail("existing_scope_unverified");
      existing = {
        command: value.command,
        argCount: Array.isArray(value.args) ? value.args.length : 0,
        expectedTools: tools(value.enabled_tools),
        disabledCount: Array.isArray(value.disabled_tools)
          ? value.disabled_tools.length
          : 0,
      };
    }
    // Never project env, argument values, complete config, or credential-derived hashes.
    return { file: expectedFile, version: matches[0].version, existing };
  }
  function planMcp(snapshot, wrapper, readTools) {
    if (snapshot.existing)
      return {
        kind: "reuse",
        expectedTools: [...snapshot.existing.expectedTools],
        command: snapshot.existing.command,
        argCount: snapshot.existing.argCount,
      };
    if (!path(wrapper)) fail("credential_required");
    return {
      kind: "create",
      command: wrapper,
      expectedTools: tools(readTools),
      argCount: 0,
    };
  }
  function casEdits(preview, plan, fresh) {
    if (
      preview.file !== fresh.file ||
      preview.version !== fresh.version ||
      Boolean(preview.existing) !== Boolean(fresh.existing)
    )
      fail("config_changed");
    if (plan.kind === "reuse") return [];
    if (plan.kind !== "create" || fresh.existing || !path(plan.command))
      fail("config_changed");
    return [
      {
        keyPath: "mcp_servers.sticker",
        mergeStrategy: "upsert",
        value: {
          command: plan.command,
          args: [],
          enabled_tools: tools(plan.expectedTools),
        },
      },
    ];
  }
  function checkStatus(result, expected) {
    if (
      !object(result) ||
      !Array.isArray(result.data) ||
      result.data.length !== 1 ||
      (result.nextCursor !== undefined && result.nextCursor !== null)
    )
      fail("mcp_unverified");
    const row = result.data[0];
    if (
      !object(row) ||
      row.name !== "sticker" ||
      !object(row.serverInfo) ||
      row.serverInfo.name !== "sticker" ||
      !string(row.serverInfo.version, 80) ||
      !object(row.tools)
    )
      fail("mcp_unverified");
    for (const key of [
      "error",
      "toolsError",
      "initializationError",
      "authError",
    ])
      if (row[key] !== undefined && row[key] !== null) fail("mcp_unverified");
    const actual = Object.keys(row.tools).sort(),
      allowed = tools(expected);
    if (JSON.stringify(actual) !== JSON.stringify(allowed))
      fail("mcp_unverified");
    return {
      status: "discovered",
      server: "sticker",
      serverVersion: row.serverInfo.version,
      tools: actual,
      apiAuthorization: "unverified",
      selectedAgentMatch: "unverified",
      existingGuiReload: "unverified",
    };
  }
  function checkSkills(result, home) {
    if (
      !path(home) ||
      !object(result) ||
      !Array.isArray(result.data) ||
      result.data.length > 100
    )
      fail("skill_unverified");
    const found = [];
    for (const entry of result.data) {
      if (
        !object(entry) ||
        !Array.isArray(entry.skills) ||
        entry.skills.length > 1000 ||
        (entry.errors && entry.errors.length)
      )
        fail("skill_unverified");
      for (const skill of entry.skills) {
        if (
          object(skill) &&
          skill.name === "sticker-integration:sticker-workflow"
        )
          found.push(skill);
      }
    }
    const expected =
      home +
      "/plugins/cache/sticker-local/sticker-integration/1.0.0/skills/sticker-workflow/SKILL.md";
    if (
      found.length !== 1 ||
      found[0].enabled !== true ||
      found[0].scope !== "user" ||
      found[0].pluginId !== "sticker-integration@sticker-local" ||
      found[0].path !== expected
    )
      fail("skill_unverified");
    return {
      status: "discovered",
      pluginId: "sticker-integration@sticker-local",
      version: "1.0.0",
      explicitInvocation: "unverified",
    };
  }
  function createRpc(transport, now = () => Date.now()) {
    let counter = 0,
      buffer = "",
      total = 0,
      messages = 0;
    function write(value) {
      const line = JSON.stringify(value) + "\n";
      if (line.length > 4096) fail("rpc_write_limit");
      transport.write(line);
    }
    function request(method, params, deadline) {
      const id = ++counter;
      write({ id, method, params });
      while (now() < deadline) {
        const at = buffer.indexOf("\n");
        if (at < 0) {
          const chunk = transport.read(deadline);
          if (chunk === null) fail(buffer ? "rpc_truncated" : "rpc_closed");
          if (typeof chunk !== "string") fail("rpc_chunk");
          total += chunk.length;
          buffer += chunk;
          if (total > 2 * 1024 * 1024 || buffer.length > 262144)
            fail("rpc_limit");
          continue;
        }
        const line = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        if (!line.length || line.length > 262144 || ++messages > 5000)
          fail("rpc_limit");
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          fail("rpc_json");
        }
        if (!object(value)) fail("rpc_shape");
        if (own(value, "method")) {
          if (own(value, "id")) {
            fail("interactive_request");
          }
          continue;
        }
        if (value.id !== id) fail("rpc_id");
        if (own(value, "error")) fail("rpc_error");
        if (!own(value, "result")) fail("rpc_shape");
        return value.result;
      }
      fail("rpc_timeout");
    }
    return { request, notify: (method, params) => write({ method, params }) };
  }
  return {
    validateManifest,
    projectConfig,
    pluginRoot,
    validatePluginFiles,
    planMcp,
    casEdits,
    checkStatus,
    checkSkills,
    createRpc,
    path,
    tools,
  };
})();
