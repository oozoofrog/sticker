/* Explicit local execution only. No credential creation, shell interpolation or system policy changes. */
function run(argv) {
  ObjC.import("Foundation");
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  const fm = $.NSFileManager.defaultManager;
  const core = globalThis.StickerInstallCore,
    process = globalThis.StickerHostProcess;
  const release = globalThis.StickerInstallRelease;
  const fail = (code) => {
    throw new Error(code);
  };
  const text = (file) => {
    const data = $.NSData.dataWithContentsOfFile(file);
    if (process.isNil(data) || Number(data.length) > 2097152)
      fail("file_unverified");
    const value = $.NSString.alloc.initWithDataEncoding(
      data,
      $.NSUTF8StringEncoding,
    );
    if (process.isNil(value)) fail("file_encoding");
    const decoded = ObjC.unwrap(value);
    if (typeof decoded !== "string") fail("file_encoding");
    return decoded;
  };
  const canonical = (value) => {
    if (!core.path(value)) fail("path_unverified");
    return ObjC.unwrap(
      $(value).stringByStandardizingPath.stringByResolvingSymlinksInPath,
    );
  };
  const env = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
  const home = canonical(ObjC.unwrap($.NSHomeDirectory()));
  const cwd = canonical(ObjC.unwrap(fm.currentDirectoryPath));
  let child = null;
  const command = (executable, args, environment = env, directory = cwd) => {
    const result = process.command(
      executable,
      args,
      environment,
      directory,
      60000,
    );
    if (result.status !== 0) fail("command_unverified");
    return result.text;
  };
  const jsonCommand = (cli, args, environment, directory) => {
    let result;
    try {
      result = JSON.parse(command(cli, args, environment, directory));
    } catch {
      fail("cli_result_unverified");
    }
    return result;
  };
  const ensureDirectory = (path) => {
    if (
      !fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        path,
        true,
        $({ NSFilePosixPermissions: 448 }),
        null,
      )
    )
      fail("directory_unverified");
  };
  const write = (file, value) => {
    if (
      !$(value).writeToFileAtomicallyEncodingError(
        file,
        true,
        $.NSUTF8StringEncoding,
        null,
      )
    )
      fail("write_unverified");
  };
  try {
    if (argv.length !== 1 || argv[0] !== "manifest.json")
      fail("manifest_invalid");
    const manifest = core.validateManifest(
      JSON.parse(text(cwd + "/manifest.json")),
      release,
    );
    const skill = text(cwd + "/sticker-workflow/SKILL.md");
    const digest = command("/usr/bin/shasum", [
      "-a",
      "256",
      cwd + "/sticker-workflow/SKILL.md",
    ]).split(/\s/)[0];
    if (digest !== release.skillHash) fail("skill_content_unverified");
    const bundle = canonical(
      app
        .chooseApplication({ withPrompt: "Codex 앱 선택", as: "alias" })
        .toString()
        .replace(/\/$/, ""),
    );
    command("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      '=identifier "com.openai.codex" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "2DC432GLL2"',
      bundle,
    ]);
    let cli = canonical(bundle + "/Contents/Resources/codex-cli/bin/codex");
    if (!fm.isExecutableFileAtPath(cli))
      cli = canonical(
        app
          .chooseFile({ withPrompt: "선택한 Codex 앱 내부 CLI 선택" })
          .toString(),
      );
    if (
      !cli.startsWith(bundle + "/Contents/") ||
      !fm.isExecutableFileAtPath(cli)
    )
      fail("cli_path_unverified");
    const codexHome = canonical(
      app
        .chooseFolder({
          withPrompt: "Codex 사용자 설정 폴더 선택",
          defaultLocation: Path(home),
        })
        .toString()
        .replace(/\/$/, ""),
    );
    const configFile = codexHome + "/config.toml";
    if (canonical(configFile) !== configFile) fail("config_path_unverified");
    const environment = { ...env, CODEX_HOME: codexHome };
    const temporary =
      canonical(ObjC.unwrap($.NSTemporaryDirectory()).replace(/\/$/, "")) +
      "/sticker-schema-" +
      ObjC.unwrap($.NSUUID.UUID.UUIDString);
    try {
      ensureDirectory(temporary);
      command(
        cli,
        ["app-server", "generate-json-schema", "--out", temporary],
        environment,
        codexHome,
      );
      const entries = ObjC.deepUnwrap(fm.subpathsAtPath(temporary));
      if (!Array.isArray(entries) || entries.length > 5000)
        fail("schema_unverified");
      const schemas = Object.create(null);
      let schemaBytes = 0;
      // This installer targets the verified v2 standalone request documents.
      // Nested aggregate definitions keep a different local $ref root and must
      // never replace these documents. No basename or aggregate fallback.
      for (const name of [
        "ConfigReadParams",
        "ConfigBatchWriteParams",
        "ListMcpServerStatusParams",
        "SkillsListParams",
      ]) {
        const entry = "v2/" + name + ".json";
        if (entries.filter((candidate) => candidate === entry).length !== 1)
          fail("schema_unverified");
        const file = temporary + "/" + entry;
        if (canonical(file) !== file) fail("schema_unverified");
        const source = text(file);
        schemaBytes += source.length;
        if (schemaBytes > 16 * 1024 * 1024) fail("schema_unverified");
        const value = JSON.parse(source);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.title !== name
        )
          fail("schema_unverified");
        schemas[name] = value;
      }
      globalThis.StickerInstallSchema.verify(schemas);
      for (const args of [
        ["plugin", "list", "--help"],
        ["plugin", "add", "--help"],
        ["plugin", "marketplace", "add", "--help"],
      ])
        if (!command(cli, args, environment, codexHome).includes("--json"))
          fail("cli_capability_unverified");
    } finally {
      fm.removeItemAtPathError(temporary, null);
    }
    const root = core.pluginRoot(codexHome);
    if (canonical(root) !== root) fail("plugin_path_unverified");
    const market = {
      name: "sticker-local",
      interface: { displayName: "Sticker" },
      plugins: [
        {
          name: "sticker-integration",
          source: { source: "local", path: "./plugins/sticker-integration" },
        },
      ],
    };
    const plugin = {
      name: "sticker-integration",
      version: "1.0.0",
      description: "Sticker instruction-only workflow",
      skills: "./skills/",
    };
    const files = {
      ".agents/plugins/marketplace.json":
        JSON.stringify(market, null, 2) + "\n",
      "plugins/sticker-integration/.codex-plugin/plugin.json":
        JSON.stringify(plugin, null, 2) + "\n",
      "plugins/sticker-integration/skills/sticker-workflow/SKILL.md": skill,
      "plugins/sticker-integration/skills/sticker-workflow/agents/openai.yaml":
        "policy:\n  allow_implicit_invocation: false\n",
    };
    const marker =
      JSON.stringify({
        product: "Sticker",
        version: "1.0.0",
        skillHash: release.skillHash,
      }) + "\n";
    function checkOwnedRoot() {
      if (!fm.fileExistsAtPath(root)) return;
      if (
        !fm.fileExistsAtPath(root + "/sticker-install.json") ||
        text(root + "/sticker-install.json") !== marker
      )
        fail("plugin_conflict");
      const allowed = new Set(["sticker-install.json", ...Object.keys(files)]);
      for (const file of Object.keys(files)) {
        const parts = file.split("/");
        while (parts.length > 1) {
          parts.pop();
          allowed.add(parts.join("/"));
        }
      }
      const entries = ObjC.deepUnwrap(fm.subpathsAtPath(root));
      if (!Array.isArray(entries) || entries.length > 40)
        fail("plugin_conflict");
      for (const entry of entries)
        if (
          !allowed.has(entry) ||
          canonical(root + "/" + entry) !== root + "/" + entry
        )
          fail("plugin_conflict");
    }
    const checkPluginContents = (complete) =>
      core.validatePluginFiles(
        root,
        files,
        {
          exists: (p) => Boolean(fm.fileExistsAtPath(p)),
          read: text,
          canonical,
        },
        complete,
      );
    const selection = {
      home: codexHome,
      configFile,
      cwd: codexHome,
      wrapper: null,
    };
    const connect = () => {
      const transport = process.spawn(
        cli,
        ["app-server", "--stdio"],
        environment,
        codexHome,
      );
      child = transport;
      const rpc = core.createRpc(transport, Date.now);
      return {
        request: (method, params) =>
          rpc.request(method, params, Date.now() + 60000),
        notify: rpc.notify,
        close() {
          transport.close();
          if (child === transport) child = null;
        },
      };
    };
    // Read first to avoid asking for or changing a wrapper on an existing registration.
    if (manifest.components.mcp) {
      const probe = connect();
      try {
        probe.request("initialize", {
          clientInfo: { name: "sticker-installer-preview", version: "1.0.0" },
          capabilities: { explicitGatewayOauth: true },
        });
        probe.notify("initialized", {});
        const snapshot = core.projectConfig(
          probe.request("config/read", { includeLayers: true, cwd: codexHome }),
          configFile,
        );
        if (!snapshot.existing) {
          selection.wrapper = canonical(
            app
              .chooseFile({ withPrompt: "승인된 Sticker MCP 실행 파일 선택" })
              .toString(),
          );
          if (!fm.isExecutableFileAtPath(selection.wrapper))
            fail("wrapper_unverified");
        }
      } finally {
        probe.close();
      }
    }
    const receipt = globalThis.StickerInstallFlow.run(
      {
        connect,
        previewPlugin() {
          checkOwnedRoot();
          const listed = jsonCommand(
            cli,
            ["plugin", "list", "--json"],
            environment,
            codexHome,
          );
          if (!listed || !Array.isArray(listed.installed))
            fail("plugin_list_unverified");
          const matches = listed.installed.filter(
            (p) =>
              p.pluginId === "sticker-integration@sticker-local" ||
              p.name === "sticker-integration" ||
              p.marketplaceName === "sticker-local",
          );
          for (const p of matches)
            if (
              p.pluginId !== "sticker-integration@sticker-local" ||
              p.version !== "1.0.0" ||
              p.source?.source !== "local" ||
              p.source.path !== root + "/plugins/sticker-integration" ||
              p.marketplaceSource?.sourceType !== "local" ||
              p.marketplaceSource.source !== root ||
              p.enabled !== true
            )
              fail("plugin_conflict");
          for (const [relative, content] of Object.entries(files)) {
            const path = root + "/" + relative;
            if (canonical(path) !== path) fail("plugin_conflict");
            if (fm.fileExistsAtPath(path) && text(path) !== content)
              fail("plugin_conflict");
          }
          checkPluginContents(matches.length === 1);
          return { root, reuse: matches.length === 1, version: "1.0.0" };
        },
        confirm(plan) {
          const mcp = plan.mcp
            ? `MCP: ${plan.mcp.kind === "reuse" ? "기존 등록 유지" : "새 등록"}\n${plan.mcp.command}\n도구: ${plan.mcp.expectedTools.join(", ")}\n`
            : "";
          const skillPlan = plan.skill
            ? `스킬: sticker-workflow 1.0.0\n${root}\n명시 호출\n`
            : "";
          try {
            return (
              app.displayDialog(
                mcp + skillPlan + "API 권한·선택 에이전트 일치: 미확인",
                {
                  withTitle: "Sticker 변경 확인",
                  buttons: ["취소", "적용"],
                  defaultButton: "취소",
                  cancelButton: "취소",
                },
              ).buttonReturned === "적용"
            );
          } catch (error) {
            // Standard Additions cancelButton raises userCanceledErr. Only
            // this pre-apply confirmation maps that exact code to cancellation.
            if (error?.errorNumber === -128) return false;
            throw error;
          }
        },
        installPlugin(plan) {
          checkOwnedRoot();
          checkPluginContents(plan.reuse);
          if (!plan.reuse) {
            ensureDirectory(root);
            if (!fm.fileExistsAtPath(root + "/sticker-install.json"))
              write(root + "/sticker-install.json", marker);
            for (const [relative, content] of Object.entries(files)) {
              const path = root + "/" + relative;
              ensureDirectory(path.slice(0, path.lastIndexOf("/")));
              if (fm.fileExistsAtPath(path)) {
                if (text(path) !== content) fail("plugin_conflict");
              } else write(path, content);
            }
            checkPluginContents(true);
            const added = jsonCommand(
              cli,
              ["plugin", "marketplace", "add", root, "--json"],
              environment,
              codexHome,
            );
            if (added.marketplaceName !== "sticker-local")
              fail("marketplace_unverified");
            const installed = jsonCommand(
              cli,
              ["plugin", "add", "sticker-integration@sticker-local", "--json"],
              environment,
              codexHome,
            );
            if (
              installed.pluginId !== "sticker-integration@sticker-local" ||
              installed.version !== "1.0.0"
            )
              fail("plugin_install_unverified");
          }
          const listed = jsonCommand(
            cli,
            ["plugin", "list", "--json"],
            environment,
            codexHome,
          );
          const rows = listed?.installed?.filter(
            (p) => p.pluginId === "sticker-integration@sticker-local",
          );
          if (
            !rows ||
            rows.length !== 1 ||
            rows[0].installed !== true ||
            rows[0].enabled !== true ||
            rows[0].version !== "1.0.0"
          )
            fail("plugin_install_unverified");
        },
        skillsParams() {
          return {};
        },
      },
      selection,
      manifest,
    );
    const summary = receipt.cancelled
      ? "취소됨 · 변경 적용 안 함" +
        (receipt.error ? `\n확인 실패: ${receipt.error}` : "")
      : `MCP: ${receipt.mcp}\n스킬: ${receipt.skill}\nAPI 권한·에이전트 일치·기존 앱 새로고침: 미확인` +
        (receipt.error ? `\n확인 실패: ${receipt.error}` : "");
    app.displayDialog(summary, {
      withTitle: "Sticker 로컬 검증",
      buttons: ["닫기"],
      defaultButton: "닫기",
    });
    return JSON.stringify(receipt);
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
        ? error.message
        : "local_verification_incomplete";
    app.displayDialog("설치·검증 미완료: " + code, {
      withTitle: "Sticker",
      buttons: ["닫기"],
    });
    return JSON.stringify({
      schemaVersion: 1,
      source: "local-user-provided",
      error: code,
    });
  } finally {
    if (child) child.close();
  }
}

// osascript invokes the named run handler.
globalThis.run = run;
