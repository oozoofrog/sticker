# MCP connection settings (#72)

## Intent and boundaries

Make the existing owner-managed Docker STDIO connection discoverable in the app without implying automatic setup or a verified Codex connection. The app may inspect its in-memory, hash-free agent grant directory; it must not create credentials, alter agent/Codex files, read the client's filesystem/environment, launch processes, contact another service, or infer personal paths. No schema migration or new MCP tool is needed.

The exact starting snapshot is `ae45cb1f8abb981c4fd963085a73083c925864d5`; it includes S6/S7/#49 but its composed aggregate gates have not yet been established. Work is isolated at `/workspace/shared/sticker-mcp-settings`.

## Approaches and selected shape

The coordinator approved Approach A: a separate owner-only read-only settings endpoint plus an app modal and local config builder. Approach B (extend owner bootstrap) would avoid a request but couple every workspace refresh and its contract to setup metadata. A client-only page cannot truthfully report server grants because bootstrap contains only the current actor. A is selected for narrow authority and separation.

## Safe server status

`GET /api/mcp/settings` is mounted after the existing authentication middleware, returns 401 anonymously and 403 for every agent, including writable/all-project agents. Its explicitly projected response contains only transport `stdio`, application mode `manual`, verification `unknown`, and configured agent IDs/names/read-write flags/project-ID scopes. It never serializes `AgentConfig`, token hashes, owner password, filesystem/config paths, or environment values. `null`, `[]` and explicit project-ID scopes remain distinct. Unknown/deleted project IDs remain visibly unavailable rather than silently becoming all-project access.

Configured grants mean the currently running server loaded them, not that a client token matches or Codex is connected. Refresh checks only that server snapshot. A copied configuration never changes any server/client connection state.

## UI and local builder

An owner-only persistent `MCP 연결` control opens an accessible modal using the existing modal/focus machinery. It shows compact facts: `서버 자격증명: 미설정/설정됨`, `Codex 연결: 확인 안 됨`, `설정 적용: 수동`, and configured grants with their actual read-only/write and project scopes. `권장 권한: 읽기 전용` is a recommendation, never a claim that existing write grants were changed. No token/hash field or secret capture is provided.

The owner enters the source installation directory. Empty, relative, control-character/newline and malformed-Unicode paths are rejected; absolute POSIX paths, Windows drive paths and UNC paths can be represented without relying on the server OS. Quotes/backslashes/spaces/non-ASCII remain correctly escaped in TOML. Validation is syntax-only: existence, Docker availability, matching compose files and client environment are all unverified. No `~` or environment expansion is performed. The compact status `토큰 환경변수 필요` remains visible: `env_vars` forwards an already available client environment variable; it does not set the token or guarantee that a GUI-launched Codex inherited it.

Read-only selectable output exposes `command`, `args`, `cwd`, environment-variable name and the full Codex TOML fragment. Docker remains `compose run --rm --no-deps -T -e STICKER_AGENT_TOKEN mcp`; the token is only an environment reference, never an interpolated value. Clipboard success produces copy feedback only. Clipboard absence/rejection produces a concise accessible error and retains selectable output for manual copying. No localStorage persistence or configuration-file write is needed. A separate operational-docs link replaces tutorial panels.

## Files and verification

- New `server/contracts/mcp-settings.ts` and `server/routes/mcp-settings.ts`; a narrow route registration in `server/app.ts`, using the existing safe `auth.directory()` projection.
- New `client/features/mcp-settings/{McpSettings,config}.tsx/ts` and feature CSS; narrow owner entrypoint/modal composition in App and main CSS import.
- New HTTP/contract and pure builder tests: anonymous/agent rejection, safe projection/no secret leakage, scope distinctions, path boundaries/TOML injection/Unicode escaping, no mutation/config writes.
- New DOM real-HTTP tests: discoverability, configured/unconfigured/unverified distinction, read/write/scope facts, refresh failure, path validation, accessible selectable fallback, clipboard success/rejection, Close/Escape/focus return.
- New hosted Playwright scenario: desktop/375px, keyboard path/copy/focus and overflow/screenshots. Only test discovery locally; actual browser execution remains hosted.
- Actual SDK STDIO fixture verifies the configured read-only scoped identity can initialize/list/read and cannot write. Existing Docker STDIO lifecycle coverage must be preserved; do not claim generated commands or a real Codex Mac connection were verified without the corresponding execution evidence.
- Update `docs/MCP.md` with the new entrypoint and honest boundaries. Run focused RED→GREEN, full application tests, strict lint/typecheck/build/production/format and diff checks. Coordinate aggregate-run timing to avoid CPU-contention misdiagnosis.

## Approval checkpoint

Approach A and this full short design were approved by the coordinator on 2026-10-28 under the user's delegated product choices, with the token-environment nuance above. No live credentials, Codex files, Mac installation or external writes are part of this implementation.
