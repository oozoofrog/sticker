# Codex Mac agent installer

Owner navigation **에이전트 설치** prepares a fixed, versioned ZIP. Preparing it or requesting a browser download does not install anything. Extract it and explicitly run `Install Sticker.command` on the Mac. The browser/server never mounts the host home, invokes a remote shell, or starts the installer.

The local installer verifies the selected Codex application's whole-bundle signature and sealed CLI, probes that CLI's schema/capabilities, selects the user configuration directory and previews changes. It does not alter Gatekeeper, quarantine, login items or security settings. If macOS blocks execution, installation remains unverified; do not bypass OS protection.

Existing `sticker` MCP registration is reused, including the explicit tool allowlist. It is never replaced with `mcp add`. A new registration requires an existing approved executable wrapper selected locally; the installer creates no tokens or server grants. Only `mcp_servers.sticker` is written using the selected user layer's fresh `config/read` CAS version. A changed version stops the operation. The write response's version is not reused. No full-configuration rollback is performed.

The new-registration preview lists six read-only tools. This is not the user's existing tool grant, and it cannot increase server permissions. Configured agent metadata shown in Sticker does not prove that a selected local wrapper uses that agent. Raw config, environment secrets, argument contents and CAS hashes stay local and are never included in the downloadable bundle, logs or verification receipt.

The fixed instruction-only `sticker-workflow` skill is versioned 1.0.0 and requests explicit invocation. Its local marketplace persists inside the explicitly selected Codex home (`sticker-installer/1.0.0`); unknown or edited contents and foreign same-name plugins are preserved as conflicts. Partial registration/cache effects can remain after a failed CLI operation. Retrying rechecks actual state; it does not remove caches or roll back unrelated configuration.

A separate spawned app-server verifies MCP initialization/tool discovery and enabled skill identity. These are distinct from actual Sticker API authority, selected-agent identity, existing GUI reload, and explicit skill invocation, which remain unverified. Interactive app-server requests are refused. Only processes spawned by the installer are cleaned up.

## Verification boundary

Portable tests cover owner-only API, sanitized bundles, fixed ZIP entries, CAS conflict/cancellation, NDJSON error handling and browser state. JXA Foundation calls, Archive Utility executable permissions, signed-app capability detection, actual CLI plugin installation and skill invocation additionally require isolated Mac fixtures. Do not infer those results from Linux tests or a successful download. This feature does not provide automatic installation on Linux or Windows.
