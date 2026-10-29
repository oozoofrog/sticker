# MCP Connection Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. The coordinator assigned native execution with no subagents and independent final review.

**Goal:** Expose honest, secret-free owner MCP settings and safely copy the existing Docker STDIO launcher into Codex configuration.

**Architecture:** A read-only owner endpoint projects the current AuthManager directory into a strict response contract. An accessible modal independently displays server grant facts and builds a client-local TOML fragment; it never writes or verifies client settings. Existing SDK/native and hosted Docker fixtures preserve actual protocol/authorization coverage.

**Tech Stack:** Existing TypeScript/Zod/Express/React/Node24, Testing Library/JSDOM, official MCP SDK, hosted Playwright. No new dependency or migration.

**Spec:** `docs/superpowers/specs/2026-10-28-mcp-connection-settings-design.md`.

## Global Constraints

- No live credentials, configuration-file writes, filesystem/environment reads for discovery, process launch by app, external calls, personal paths or automatic Codex/Mac setup.
- Owner-only settings; every agent gets403. No token/hash/password/path/environment values in status, logs, history or copied settings.
- Configured grants are not verified connectivity. Copied settings are not applied settings. `env_vars` only forwards an existing client variable; show `토큰 환경변수 필요`.
- Preserve null/empty/explicit scopes and unavailable project IDs. Display actual read/write permission separately from recommended read-only access.
- Paths are syntax-only, no filesystem claims. TOML escaping and selectable clipboard fallback are required. UI is controls/facts/errors, not tutorial prose.
- Baseline `ae45cb1` is composed but not yet aggregate-verified; coordinate full-suite timing with parent. No local browser escalation or remote writes.

## Review Focus

- Writable/all-project bearer credentials must not access the owner's whole grant directory: Task1 tests all configured principals, not only readonly.
- Deleted/empty scopes must not silently expand to all projects: Task1 preserves raw scopes; Task2 displays unavailable IDs and distinguishes none/all.
- Quotes, backslashes, line breaks and lone surrogates must not inject TOML: Task1 tests builder boundaries; available Python `tomllib` independently parses emitted fragments without becoming a new application/test dependency.
- Clipboard failure or permission rejection must not become apparent setup success: Task2 retains selectable output and explicit error, resets copy feedback after edits, preserves unknown/manual states.
- Late status responses, closing/reopening and375px keyboard interaction must not leak stale authority or lose accessible output/focus: Task2 DOM tests and Task3 hosted spec cover interrupted/repeated flows.

---

### Task1: Safe status contract and pure config builder

**Files:** create `server/contracts/mcp-settings.ts`, `server/routes/mcp-settings.ts`, `client/features/mcp-settings/config.ts`, `tests/mcp-settings.test.ts`; modify only route registration in `server/app.ts`.

**Interfaces:** `mcpSettingsSchema` strictly accepts `{transport:"stdio",application:"manual",verification:"unknown",tokenEnvironmentVariable:"STICKER_AGENT_TOKEN",agents:Array<{id,name,canWrite,projectIds:string[]|null}>}`. `registerMcpSettingsRoutes(app, directory:()=>Actor[])` enforces owner access through existing `requestActor`. `buildCodexMcpConfig(cwd:string)` returns `{command,args,cwd,envVars,toml}` or a bounded validation error; fixed launcher is `docker compose run --rm --no-deps -T -e STICKER_AGENT_TOKEN mcp`.

- [x] Write HTTP RED tests: GET401 anonymous/403 each agent, safe owner projection, no token/hash/password, scopes null/[]/deleted ID unchanged, no mutation endpoint.
- [x] Write pure-builder RED tests: reject empty/relative/tilde/C0/newline/malformed Unicode/overlong paths; preserve valid POSIX/drive/UNC/Unicode/spaces/quotes/backslashes; exact command/args and environment reference with no secret values or shell interpolation.
- [x] Run `node --import tsx --test tests/mcp-settings.test.ts` and record the expected missing-route/module failures before product implementation.
- [x] Implement the strict contract, explicit owner-safe projection, route registration and pure builder. Use structured launch arguments and JSON-compatible TOML basic-string escaping after rejecting invalid controls/surrogates; no shell execution or host-OS path normalization.
- [x] Rerun focused tests; independently parse representative emitted TOML with installed `python3`/`tomllib`, asserting exact cwd/args/env_vars and no injected section.
- [x] Commit this independently testable backend/builder checkpoint after focused typecheck/lint.

### Task2: Owner modal and interrupted-copy behavior

**Files:** create `client/features/mcp-settings/McpSettings.tsx`, `client/features/mcp-settings/mcp-settings.css`, `tests/ui/mcp-settings.test.tsx`; modify narrow App modal/owner entrypoint/inert composition and CSS import in `client/main.tsx`.

**Interfaces:** `<McpSettings projects={Project[]} onClose={()=>void}/>` reads `mcpSettingsSchema` through the existing path-specific resource hook and uses Task1's builder. It consumes no secret and performs only GET plus explicitly requested clipboard writes. The App entrypoint is owner-only `MCP 연결`; existing modal supplies Escape/focus behavior.

- [x] Write real-HTTP DOM RED cases for discoverability, no configured grants, configured read/write/all/none/deleted scopes, manual/unknown/environment-required facts, syntax errors, visible copyable command/cwd/env/TOML, clipboard success/rejection/absence and retained output, copy-feedback reset, close/reopen/Escape/focus return, failed refresh without false verification.
- [x] Run focused DOM tests, record RED before UI code.
- [x] Implement compact labeled facts, grant summaries, source-root input, readonly selectable output, copy buttons/status/error and docs link. Do not persist the path or copied state to localStorage, or reinterpret selecting/viewing a grant as selecting its token.
- [x] Add feature-only responsive CSS with min-width0/contained output overflow. Preserve existing App ownership/compositions, register no new hash listener and do not change business states.
- [x] Rerun Task1 + Task2 focused tests, typecheck and strict lint; commit the UI checkpoint.

### Task3: Protocol/hosted coverage, docs and final gates

**Files:** add actual SDK fixture case to `tests/mcp-settings.test.ts` and `tests/ui/mcp-settings.spec.ts`; update `docs/MCP.md`. Preserve existing Docker driver/MCP fixture; coordinate any necessary narrow driver hook with parent instead of replacing its lifecycle checks.

- [x] Add native real-SDK STDIO test: scoped readonly fixture initializes/lists/reads only its project, write denied403; owner status agrees with current grant metadata; no settings/grant-management MCP tool is exposed.
- [x] Add hosted desktop + exact375px keyboard scenario: open MCP settings, validate/edit path, inspect/copy safe output and failure fallback, close/reopen focus, screenshots and no horizontal page overflow. Local `--list` is discovery only.
- [x] Update docs for owner entrypoint, separate server-configured/manual/unknown statuses and token-environment forwarding; retain operational credential setup/revocation instructions and Docker security caveat outside app.
- [x] Run focused tests, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:production`, `npm run format:check`, `git diff --check`; run full `npm test` in the coordinated slot. Record exact counts and all failures honestly, no timeout/assertion weakening.
- [x] Commit final tests/docs, update `/workspace/shared/sticker-issue-context/mcp-settings-report.md` with exact commits/evidence/limits, and request parent's independent review + hosted browser/Docker checks. Do not claim actual Codex/Mac connection or publish externally.

## Self-review

All design requirements map to Tasks1–3; Task1 interfaces are the names consumed by Task2. Each listed review risk has an explicit test owner. Parent retains remote publication, real Mac activation and final hosted/composed walkthrough authority.
