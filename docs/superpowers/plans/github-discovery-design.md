# GitHub connection selection — STK-70 design

## Goal and boundary

Replace normal owner/name/credentialRef typing with source selection → repository selection → connect. Existing Sticker owner-only connection administration stays owner-only. No OAuth registration, new token, expanded privileges, host credential discovery, filesystem/home dependency or automatic connection. Fresh installs without known owner or configured credentials cannot identify a GitHub account automatically; this remains an explicit onboarding gap, not a claimed universal zero-input success.

## Alternatives

1. Existing configured-source/known-public-owner discovery (chosen bounded first slice): portable, uses already enabled read provider, no new credential grant; cannot bootstrap an unknown identity.
2. GitHub OAuth/App login: addresses fresh install identity, but registration/callback/secrets/consent are new authorization and deployment scope; separate future proposal only.
3. Search all GitHub or inspect host git credentials: not a trustworthy identity mechanism; rejected. Optional typed search may filter already loaded entries but is never required on supported paths.

## Interaction

Connection modal shows source choices with friendly labels. Public choices derive only from existing PUBLIC connection owner metadata, including this project’s last disconnected public owner (labeled 이전 공개 연결) to support reversible disconnect; authenticated choices derive from explicitly configured credential entries. Never expose token or credentialRef, never reuse a private connection's owner as publicly asserted metadata. Choose source → paged repository choices (full name, visibility, archived status) → select → explicit Connect. Existing connection remains until successful confirmed CAS mutation. No default first repo, no automatic switch on discovery, no big manual/help panel. Separate loading/empty/provider-disabled/no-source/rate-limit/forbidden states and retry control.

## Contract and safety

New owner-only per-project discovery APIs. Opaque source identifiers resolved on server; not base64 credentialRef. Use bounded process-local identifier map or signed opaque mapping with boot-local randomness, no credential secret in response/log. Include revision/source binding; recheck owner/project/source after async requests and before connection. No private results persisted to global cache or shown across source changes. Never treat repository listing as token least-privilege verification; retain permissionsVerified:false.

Fixed GitHub API origin, GET-only, redirect rejection, existing response byte/time/schema limits. Build paths server-side, do not follow client URLs or arbitrary Link headers. Public /users/{known-owner}/repos (organization route after validated type if required), existing authenticated /user/repos only where supported by supplied credential. No additional token type assumption: unsupported authentication returns a distinct honest error. Paginate using bounded page cursor tied to source/project/current connection revision, fetch one page per explicit next action. Cursor cannot select a different source or escalate page bounds. Dedupe repository IDs/full names. Preserve old connection revision conflict review. Selection validation and repository recheck before save must not mark old data as verified on uncertainty. Do not expose raw GitHub error bodies, auth headers or config refs.

## Acceptance tests

- Existing public connection: zero typed strings to select another public repo and connect.
- Configured auth label selection: zero credentialRef entry; only repositories returned for that source; agents get403 and no credential metadata.
- Provider off, no sources, empty page, expired/removed source, 401/403/429, timeout/oversize/malformed responses produce bounded actionable states, no auto retry loop.
- Public calls send no Authorization; authenticated calls never fall back to tokenless silently.
- Pagination duplicate handling, final/partial page, cap reached, source/project/revision cursor tampering fail closed.
- Select A→B while delayed A resolves; close/reopen/logout; stale query/result cannot replace B/restore private entries. Network uncertainty never submits cached selection as fresh verification.
- CAS change leaves previous connection intact and asks selection review, unknown-save response requery distinguishes actual saved state.
- Keyboard labels/focus/list selection and 375px layout without manual text; no raw descriptions/remote images/scripts needed.
- Fresh-clone Docker fixtures, no live account/token calls or host dependency; tests preserve original current-provider behavior and pinned CI evidence refresh guards.

Official API reference checked 2026-10-30: https://docs.github.com/en/rest/repos/repos?apiVersion=2026-03-10 (authenticated repository listing and unauthenticated public user repository listing are distinct).

Canonical STK-70: 28687d16-6a1c-4bbe-9846-07dd38e1bc10. Implementation is isolated from production; exact-head CI and local deployment/use remain later gates.

## Implementation review rulings

- Reconnect: preserve current-project prior PUBLIC owner on disconnect with explicit prior-connection label; private provenance is excluded. Disconnect still invalidates old tickets through revision.
- Selected repository verification checks GitHub numeric ID, full name, visibility and disabled state before CAS save.
- Uncertain save uses owner-only ticket status comparison with exact revision+1, repo/mode/internal credential identity. It never uses visible labels to infer credential identity.
- Actual local Chromium launch was unavailable due environment socket permission rejection; no alternate launch flags/routes were tried. Hosted browser CI remains required.
