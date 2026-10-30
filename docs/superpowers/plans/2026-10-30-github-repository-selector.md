# STK-70 GitHub Repository Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task.

**Goal:** Select known public owners/configured authentication and repositories without typing identifiers.
**Architecture:** Extend fixed-origin read client with bounded paged listing. Add owner-only discovery service using short-lived random source/cursor/selection IDs mapped server-side, then verified CAS connect. Existing manual API remains compatible; the normal UI uses selection only.
**Tech Stack:** Existing TypeScript/Zod/Express/React, no dependencies/schema migration.
**Spec:** github-discovery-design.md; canonical STK-70 UUID28687d16-6a1c-4bbe-9846-07dd38e1bc10.

## Global Constraints

- No OAuth/token creation, new grants, live accounts, host-home or docker-socket assumptions.
- Owner-only metadata; no credentialRef/token/path in response. Public sources come from connected public repository owner metadata or this project’s last public connection; disconnected owners of other projects are excluded.
- No mandatory owner/repo/ref inputs. Fresh identity-less installation explicitly has no choices, not a claimed automatic login.
- GET-only fixed GitHub origin, redirects rejected, bounded time/bytes/schema; private results stay ephemeral.
- Existing revision CAS and all previous evidence-source/revision protection preserved.

## Review Focus

- A credential/public source disappears between listing and connect: fail before replacing old connection.
- Source A response arrives after B selection or close: do not restore A/private results.
- Uncertain save response: block another save until requery, do not blindly overwrite.
- Opaque IDs from another project/revision/source: reject; API input never supplies network URLs.
- Full final page and pagination cap: represent continuation honestly and avoid unbounded fetch loops.

## Task 1: Read transport

Files server/contracts/github-discovery.ts, server/github-read-client.ts, tests/github-discovery-client.test.ts.

- [ ] Write failing transport tests for public user/org vs authenticated repositories; verify no Authorization on public, GET fixed origin, owner/full_name validation, redirect/rate/oversize errors, 30-item pages, maximum100 pages, duplicate ID handling, continuation when fullpage.
- [ ] Add `listRepositories(input:{publicOwner?:string,page:number}):Promise<{items:GithubRepositoryOption[],hasMore:boolean}>`; public owner metadata type resolves user/org route, authenticated input has no owner.
- [ ] Run focused tests red then green, typecheck.

## Task 2: Owner discovery and verified connect

Files server/features/github-discovery.ts, server/features/github.ts, server/routes/github.ts, server/contracts/github-discovery.ts, tests/github-discovery.test.ts, tests/github-discovery-http.test.ts.

- [ ] Write failing tests owner-only source DTO, expired/mismatched source/cursor/selection, removed source, delayed list/connect versus CAS mutation, provider disabled network0, unchanged old connection on verify fail.
- [ ] Add optional `listRepositories` to injected ReadClient contract to preserve legacy fixtures; new discovery service receives safe callbacks for owner/project checks, connection revision, known public owners/configured credentials, read client and existing connect.
- [ ] Ephemeral random UUID tickets expire15minutes and max4096 combined entries; current source identity revalidated on every step. Source tickets bind project+revision, cursor and selected repo bind source. Full pages expose next cursor up to page100 then explicit limit.
- [ ] GET `/api/projects/:id/github/sources`; POST `/repositories` with sourceId+optionalcursor; POST `/select` with sourceId+selectionId+revision+confirm. Do not change existing PUT contract. Connect verifies chosen repository then rechecks source/revision before synchronous existing CAS connect.
- [ ] Run HTTP/domain tests red then green; token/credentialRef not present in serialized DTO/errors.

## Task 3: Selection UI

Files client/features/github/GithubConnectionEditor.tsx, new client/features/github/GithubRepositoryPicker.tsx (if cohesion warrants), GithubSettings.tsx, tests/ui/github-discovery.test.tsx, tests/ui/github.test.tsx.

- [ ] Write failing tests zero text entry source→repo→confirmation; keyboard selection, empty/disabled/error/retry, A→B delayed results, unmount, source switching resets consent, stale save requery.
- [ ] Replace three identifier fields with labeled native selects/list choices and explicit page buttons/status. Keep current CAS conflict review, separate scope preview, existing connection preserved on cancel.
- [ ] Submit opaque selection; uncertain error blocks save until reload, current comparison informs user, never invent saved-success.
- [ ] Run UI tests red then green, no broad assertion weakening.

## Task 4: Actual browser and portable verification

Files tests/github-provider-fixture.ts, tests/ui/github.spec.ts, tests/container-github-smoke.mjs as needed, docs/GITHUB-EVIDENCE.md.

- [ ] Extend deterministic injected fixture lists (no live credentials), seed known public connection by fixture API before UI selection. Preserve existing CI/evidence verification coverage.
- [ ] Desktop/375px zero-text workflow, paging/keyboard/cancel/repeated source selections; screenshot actual result. Docker contract tests use disposable data only.
- [ ] Run typecheck, lint maxwarnings0, format, full test, build, production smoke, real Chromium UI. Independent source/test review before commit/publication; report limitations explicitly.

## Implementation review rulings

- Reconnect: preserve current-project prior PUBLIC owner on disconnect with explicit prior-connection label; private provenance is excluded. Disconnect still invalidates old tickets through revision.
- Selected repository verification checks GitHub numeric ID, full name, visibility and disabled state before CAS save.
- Uncertain save uses owner-only ticket status comparison with exact revision+1, repo/mode/internal credential identity. It never uses visible labels to infer credential identity.
- Actual local Chromium launch was unavailable due environment socket permission rejection; no alternate launch flags/routes were tried. Hosted browser CI remains required.
