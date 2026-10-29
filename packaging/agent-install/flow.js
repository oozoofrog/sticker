// Dependency-injected local installation. Raw config and CAS versions never enter receipts.
globalThis.StickerInstallFlow = (() => {
  const core = globalThis.StickerInstallCore;
  function run(io, selection, manifest) {
    const receipt = {
      schemaVersion: 1,
      source: "local-user-provided",
      mcp: "not_selected",
      skill: "not_selected",
      apiAuthorization: "unverified",
      selectedAgentMatch: "unverified",
      existingGuiReload: "unverified",
      explicitSkillInvocation: "unverified",
    };
    let connection;
    function connect() {
      const rpc = io.connect();
      try {
        rpc.request("initialize", {
          clientInfo: { name: "sticker-local-installer", version: "1.0.0" },
          capabilities: { explicitGatewayOauth: true },
        });
        rpc.notify("initialized", {});
        return rpc;
      } catch (error) {
        try {
          rpc.close();
        } catch {
          receipt.cleanup = "unverified";
        }
        throw error;
      }
    }
    try {
      connection = connect();
      const initial = core.projectConfig(
        connection.request("config/read", {
          includeLayers: true,
          cwd: selection.cwd,
        }),
        selection.configFile,
      );
      const plan = manifest.components.mcp
        ? core.planMcp(initial, selection.wrapper, manifest.readTools)
        : null;
      const pluginPlan = manifest.components.skill ? io.previewPlugin() : null;
      if (!io.confirm({ mcp: plan, skill: pluginPlan })) {
        receipt.cancelled = true;
        return receipt;
      }
      if (plan) {
        const fresh = core.projectConfig(
          connection.request("config/read", {
            includeLayers: true,
            cwd: selection.cwd,
          }),
          selection.configFile,
        );
        const edits = core.casEdits(initial, plan, fresh);
        if (edits.length) {
          receipt.mcp = "write_pending";
          const response = connection.request("config/batchWrite", {
            filePath: fresh.file,
            expectedVersion: fresh.version,
            reloadUserConfig: false,
            edits,
          });
          if (!response || !["ok", "okOverridden"].includes(response.status))
            throw new Error("config_write_unverified");
          receipt.mcp = "written_unverified";
        } else receipt.mcp = "reused_unverified";
        const readback = core.projectConfig(
          connection.request("config/read", {
            includeLayers: true,
            cwd: selection.cwd,
          }),
          selection.configFile,
        );
        const actual = core.planMcp(readback, null, manifest.readTools);
        if (
          actual.kind !== "reuse" ||
          actual.command !== plan.command ||
          actual.argCount !== plan.argCount ||
          (plan.kind === "reuse" && readback.version !== fresh.version) ||
          JSON.stringify(actual.expectedTools) !==
            JSON.stringify(plan.expectedTools)
        )
          throw new Error("config_readback_unverified");
      }
      if (pluginPlan) {
        receipt.skill = "partial_possible";
        io.installPlugin(pluginPlan);
        receipt.skill = "installed_unverified";
      }
      connection.close();
      connection = null;
      connection = connect();
      if (plan) {
        core.checkStatus(
          connection.request("mcpServerStatus/list", {
            serverName: "sticker",
            detail: "toolsAndAuthOnly",
            limit: 10,
          }),
          plan.expectedTools,
        );
        receipt.mcp = "discovered";
      }
      if (pluginPlan) {
        core.checkSkills(
          connection.request("skills/list", io.skillsParams(selection)),
          selection.home,
        );
        receipt.skill = "discovered";
      }
      return receipt;
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : "verification_failed";
      receipt.error = code;
      return receipt;
    } finally {
      if (connection) {
        try {
          connection.close();
        } catch {
          receipt.cleanup = "unverified";
          receipt.error = receipt.error || "cleanup_unverified";
        }
      }
    }
  }
  return { run };
})();
