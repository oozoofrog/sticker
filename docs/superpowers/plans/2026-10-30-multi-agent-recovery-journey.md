# STK72 multi-agent recovery journey implementation plan

> **For agentic workers:** Use executing-plans for this single test-only slice; independent review before coordinator publication.

**Goal:** Exercise two scoped agents competing over one issue and recovering after an unobserved committed creation response and server restart.
**Architecture:** One Node HTTP integration journey uses a new temporary SQLite directory, two distinct configured bearer principals and an owner login. Both agents read the same revision before concurrently outstanding PATCH requests; the losing actor explicitly rereads before retry. A stopped/recreated app reloads the same serialized synthetic agent grants and DB, then replays the original creation operation.
**Tech Stack:** Existing Node test runner, fetch, createApp, response schemas; no dependencies or production changes.
**Spec:** Coordinator-approved STK72 varied-user-scenario scope: same-issue multi-agent conflict, uncertain response observation, repeated operation and restart recovery. This document is the bounded design and execution plan.

## Approaches and constraints

- Chosen: real HTTP integration. Adds the missing composition of distinct authenticated agents, competing requests, actor-attributed history and complete app teardown/restart.
- Store-only tests are cheaper but already cover two database connections and receipt reopening; another would duplicate existing coverage.
- Browser/MCP expansion is not required to establish this API contract. No local browser launch, live credentials, private DB, Mac, Docker or unrelated PR work.
- Discarding a successful response body simulates lost **response observation**, not actual transport loss. PATCH has revision CAS, not an idempotency key; replaying a committed PATCH must return 409, not fabricated success.
- Existing correct production behavior may pass immediately. No invented product RED or deliberate product mutation. Test/harness failures are reported separately.

## Existing source coverage (new audit, not recovery of a missing matrix)

At baseline `af81491b0cb09e5109e5859a6bfad8ae7e54ad11`; source inspection alone is not a fresh execution claim.

| Journey                     | Existing evidence                                                                                     | Remaining boundary                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Onboarding/login            | `ui/workspace.test.tsx:100,205`, `auth.test.ts:8,75`                                                  | No new human/OS installation claim                                     |
| Issue creation/edit         | `api.test.ts:135`, `ui/workspace.test.tsx:100,275`                                                    | Integrated multi-agent recovery below                                  |
| Concurrent agent update     | `domain.test.ts:127` two Store connections, sequential owner writes; `mcp.test.ts:400` sequential CAS | Distinct bearer actors with outstanding competing HTTP writes          |
| Wiki/planning documents     | `document-journey.test.ts:9`, `document-journey-fixture.ts:19`, `ui/resources.spec.ts:4`              | Exact historical pin already covered                                   |
| MCP                         | `mcp.test.ts:108,296`, `mcp-sessions.test.ts:24`                                                      | Not reclassified as this HTTP journey                                  |
| Permissions                 | `api.test.ts:204`, `sessions.test.ts:243`, `resources.test.ts:311`                                    | Retain serialized scoped grants after app restart                      |
| History                     | `history.test.ts:65`, `ui/history.test.tsx:200,279`                                                   | Verify both competing actors and no rejected-write history             |
| Navigation                  | `ui/workspace.test.tsx:396`, `ui/router.test.ts:5`, document browser journey                          | Browser execution separate from source audit                           |
| Cancel                      | `ui/workspace.test.tsx:100`, `ui/resources.test.tsx:371,540`                                          | Already represented, no unrelated UI change                            |
| Repeated click/retry        | `ui/templates.test.tsx:410`, `template-application.test.ts:203`                                       | HTTP creation replay after later other-actor edits and app restart     |
| Disconnect/unknown response | `ui/history.test.tsx:279`, `ui/resources.test.tsx:371`, `ui/github.test.tsx:242`                      | Response observation loss only; no real network-fault claim            |
| Restart                     | `persistence.test.ts:17`, `template-application.test.ts:243`, `resources.test.ts:339`                 | Full app restart plus current actor grants and HTTP replay composition |

## Review focus

- Either actor may win; assert one success/one conflict without scheduler assumptions.
- Rejected and repeated writes add no activity/history and do not erase the winner's field.
- Creation replay returns the current issue, not an old revision snapshot (`domain.ts:595`).
- Same operation UUID with changed payload conflicts; readonly and foreign-project writes remain denied before/after restart.
- Every server/store/temp directory is released even if startup or assertion fails.

## Task 1: Real HTTP recovery journey

**Files:** Create `tests/multi-agent-recovery-journey.test.ts`; this plan only. No shared fixture or production edits.
**Interfaces:** Existing `createApp`, `agentsSchema`, issue/project/history schemas and `readJson`; fixture-local start/stop and owner/agent request helpers.

- [x] Write the journey assertions before fixture implementation. Intended breaks caught: missing CAS check, wrong author identity, missing receipt persistence, stale receipt snapshot, permission broadening, extra history on rejection/replay.
- [x] Implement isolated lifecycle helper, reading serialized synthetic grants afresh for each app instance; consume discarded response without parsing its entity.
- [x] Assert same revision reads; `Promise.all` PATCH yields statuses `[200,409]`; failed actor rereads, explicit retry preserves winning field; original committed PATCH replay is 409.
- [x] Stop app, restart against same temp DB; old owner cookie is 401; owner relogins. Same create operation returns same current issue and exactly three history entries with creation/winner/retry authors. Changed replay is 409; readonly/foreign project mutations are 403; no duplicates.
- [x] Run focused test, typecheck, lint, format, build and full suite. Record actual results, then independent review; coordinator owns all remote actions.

## Execution ledger

- Source audit complete; coordinator approved the bounded HTTP test-only approach. Baseline installation/full test execution owned by coordinator; no duplicate install.
- Coordinator read and approved this plan before test source implementation.
- Assertions written before fixture; initial run failed only because `recoveryFixture` was not yet defined. This is a harness-development failure, not a product RED or a discovered product bug.
- After the fixture was implemented, focused test passed 1/1 (and passed again after formatting). Existing production behavior required no changes.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run format:check` passed. Build retained existing Zod/Rollup annotation warnings; npm emitted environment/version notices.
- Full-suite main Node phase passed 374/374; the appended access-runtime phase was still running when this review snapshot was committed. Final result and independent review remain pending.
- Ruling: reuse the already-authorized isolated cloud checkout and coordinator baseline rather than create a nested worktree or reinstall dependencies. No shared runtime or other branch is changed.

- Final implementer full suite: `npm test` exited 0, main Node tests **374/374** and appended access-runtime tests **13/13**, no failures or skips.
- Independent review of `1b423ef3a6d0be55d5fac29da59c0f2d09905764`: no blocking findings. Reviewer independently repeated the focused journey twice, related domain/persistence/template/journey tests **20/20**, typecheck, targeted ESLint/Prettier, diff whitespace check, fresh build and compiled production smoke, then full `npm test` **374/374 + 13/13**, all passed. Existing npm environment/version and Zod/Rollup annotation notices remain non-fatal.
- This final update changes documentation only. Remote publication remains coordinator-owned. No human participant testing, actual network-loss injection, browser execution, Docker execution or Mac integration is claimed.
