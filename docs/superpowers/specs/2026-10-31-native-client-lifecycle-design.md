# Native client lifecycle design

**Date:** 2026-10-31

**Status:** Proposed implementation design; documents only in this task.

**Programme:** Separate host integration increment after domain MCP parity.
**Evidence:** test-results/github-app-plan/client-install-feasibility.md and docs/superpowers/specs/2026-10-31-mcp-product-parity-design.md.

## Product outcome

A user opens MCP 연결 and chooses 연결, 업데이트 or 연결 삭제 for a detected supported client. The product determines installation, launch command and supported configuration mechanics. Normal interaction has zero custom path, JSON/TOML, token, API origin or auth-strategy inputs. Display brief necessary access/target intent before the action. Keep OS/provider/account authorization explicit where actually required.

This increment manages Sticker-owned client registration plus the explicit scoped managed-agent bootstrap and revocation needed for a new client's first connection. It does not upgrade client apps, revoke existing configured/shared tokens, manage host Docker or change domain issue operations. Domain MCP parity does not wait for this increment. The completed product must prove the selected client can discover Sticker tools, while distinguishing a saved entry, a direct protocol probe and a still-running client's stale catalogue.

## Engineering choices and release boundary

1. Generic native file/shell/config bridge is rejected. It would turn webpage/model inputs into host authority and repeats the stopped PR93 direction.
2. CLI remove/add plus hash-check/rename is rejected as an implementation of strict concurrent-write safety. Installed Codex has add/remove/get/list, no dedicated update command; its help/version also attempted PATH-alias writes that the sandbox blocked.
3. Selected: a small native manager with fixed client profiles, shared typed UI/MCP adapters, private ownership/transaction records and the official Codex app-server versioned config writer. Implement its narrow synthetic conformance gate next; enable only the exact supported runtime/profile after that gate. Other clients remain capability-gated.

**Concurrency contract:** preserve ordinary concurrent user/client changes, never knowingly overwrite a changed config or foreign entry, and fail closed on any API version conflict. Direct hash-check+rename has a race and is not the writer. We do not require proof against a malicious process rewriting arbitrary bytes outside the client's documented storage protocol. Unsupported/uncertain behavior stops the operation; it never falls back to a direct write.

The first complete lifecycle target is Codex using its supported expectedVersion API, private backup and inverse versioned rollback. The existing older-version synthetic evidence makes this a concrete implementation path, with current-version conformance still required. Detection/preview alone is explicitly incomplete under the user's requirement; it may ship as an interim state but cannot substitute for connect/update/remove acceptance. Domain parity continues independently.

## Global constraints

- macOS 11.3+, Swift 5 language mode, Foundation/AppKit/WebKit; preserve the existing access app and installation manifest.
- Existing configured agents and domain authorization stay unchanged; new dedicated scoped managed grants occur only after the runtime Connect summary and native+owner consent, never during development against production.
- No normal custom path, JSON/TOML, token, server-address or auth-strategy input.
- UI and host MCP use one typed NativeConnectionManager; no arbitrary shell, host path, URL, environment or generic config/RPC payload.
- No Docker socket, host-home mount, client auto-restart, app auto-upgrade or OS security-policy/external-account setting change; runtime scoped Connect may create only its own approved Keychain item and managed server grant.
- Only a manifest-owned matching Sticker entry may be changed; unmanaged or user-modified entries fail closed.
- Config mutation uses the supported expectedVersion transaction and rejects reported conflicts; raw-file rename is never a CAS fallback.
- Synthetic fixture roots and injected transports first; real config/Keychain/grant changes happen only after the user's runtime Connect/Delete intent, never as development operations.
- The PR93 stopped write primitive and denied Codex help/version alias probes remain stopped; no retry or workaround.
- No subagents in this design task; no source/runtime/config mutations during document preparation.

## Existing implementation and official evidence

The MCP settings screen currently copies a syntax-only Docker STDIO TOML fragment after a user enters source cwd. Its owner-only HTTP route exposes safe agent metadata, application=manual and verification=unknown. It cannot inspect host configuration or mint credentials. The native app owns service status/start/stop and safe navigation/panels/downloads; it has no WKScriptMessageHandler for configuration. Its sticker-access-v2 manifest pins a source root and Docker/context/project, not ownership of a client MCP entry.

Recorded Codex CLI 0.166.0-alpha.5.1 is bundled with ChatGPT. Its recorded help establishes add/remove/get/list but not an atomic lifecycle transaction. No further probes are permitted here. Official configuration documents command/args/cwd/env_vars and client filters; preserve existing policy rather than replacing it. [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The official app-server overview documents atomic config/batchWrite, reload and status APIs. Parent-supplied existing public schema/synthetic evidence for0.165.0-alpha.1.2 additionally establishes expectedVersion, filePath and reloadUserConfig on batchWrite; returned status/version/filePath; configVersionConflict and configValidationError with unchanged fixture bytes. These artifacts were read locally only; no raw evidence or config values are published here. They are older than the installed0.166.0-alpha.5.1 and do not replace its conformance gate. [App-server overview](https://learn.chatgpt.com/docs/app-server)

**Version-token nuance:** prior successful update used a fresh config/read user-layer version; using ConfigWriteResponse.version directly as expectedVersion produced configVersionConflict in the recorded fixture. Therefore every write and rollback obtains a fresh user-layer version and checks the owned entry again. A returned write version is a receipt, not assumed to be the next CAS token. The recorded tests do not establish remove/null semantics or every external-editor interleaving; these are explicit next conformance cases.

Claude Code has documented add/add-json/remove and scoped registration. Claude Desktop uses a separate provider-managed extension lifecycle; CLI support is not Desktop support. [Claude Code MCP](https://code.claude.com/docs/en/mcp), [scope and validation guide](https://code.claude.com/docs/en/mcp-quickstart), [Desktop extensions](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

## Fixed client profiles and support state

Use fixed client IDs, not paths or model-provided names:

| ClientId          | Detection                                                                                     | Initial support                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex-local       | Verified standard executable/bundled app metadata and Launch Services; known identity/version | First complete implementation target; expectedVersion writer after conformance, explicit scoped bootstrap or matched existing managed reference, plus user action |
| claude-code-local | Verified standard Claude Code executable metadata                                             | Detection plus official support requirements; lifecycle disabled until a versioned writer and launcher/runtime tests are certified                                |
| claude-desktop    | Verified Claude Desktop bundle identity                                                       | provider_managed; no unattended Sticker lifecycle promise; no undocumented config-file shortcut                                                                   |

A standard candidate set comes from native home/Applications/Launch Services and a checked profile definition, never caller-supplied paths or shell expansion. Bound candidate count16; do not recursively scan user folders. Multiple viable distinct installs return ambiguous_installation; no guessed winner. A custom executable/config root or unsupported version returns unsupported_profile. Absence from checked locations means not_detected, not globally absent.

Codex user registration is the first target. Project registration is deferred because repository trust/layering complicates no-input setup. Future Claude Code user scope is a separate tested target; local/project entries and managed/shadowing policies remain unchanged. Existing16-tool versus expanded visibility is shown in update preview; never silently remove allow/deny lists or per-tool approvals.

## Typed shared contract

Wire protocol version1, strict JSON, maximum message64KiB. All identifiers are opaque handles or fixed enums; secret/config bytes are never wire values. Swift owns authority and state; TypeScript mirrors schemas for UI and local host-MCP adapter.

```text
ClientId = codex-local | claude-code-local | claude-desktop
Action = connect | update | remove
Availability = ready | not_detected | ambiguous_installation | unsupported_profile
             | provider_managed | policy_blocked | credential_unavailable
             | permission_required | writer_unavailable | owned_conflict
             | companion_unavailable
Registration = unknown | absent | owned | modified_owned | unmanaged_conflict
ProtocolCheck = not_checked | initialized | tools_verified | failed
ClientLoad = unknown | refresh_required | verified | policy_blocked
Phase = planned | awaiting_native_confirmation | provisioning | grant_provisional
      | prepared | provider_applied | activating | cleanup_pending
      | verifying | committed | rolled_back | canceled | conflict | uncertain
```

ClientSnapshot contains clientId, displayName, safeVersion, availability, registration, ownershipRevision, allowedActions, credentialState=available|grant_required|provisional|expired|unverified, protocolCheck, clientLoad, checkedAt and bounded reason codes. No local paths, hashes of secrets, account identifiers or unprojected process output. A writer certification ID may be included for diagnostics; it is not an authorization token.

credentialState=grant_required is the normal first-use state and still permits Connect when owner/native intent, selected project and supported writer are available. credential_unavailable means an actual secure-store/bootstrap failure, not merely absence of a manually pre-provisioned secret.

ConnectionPlan contains planId, action, clientId, safe target/rights summary, managed field changes, retained filter summary, expectedOwnershipRevision, expectedProviderVersion handle, digest, expiresAt, requiredIntent and verification expectation. Private plan retains native target identity/credentialRef and exact candidate patch. Digest is SHA256 of versioned canonical action+client+installation+target+desired managed entry+versions+credential reference identity+expiry; no raw secret in the hash input exposed to model text.

Exact public verbs:

| Verb             | Input                                                    | Result                                                     |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| detectClients    | requestId, refreshMetadata:boolean                       | ClientSnapshot[]                                           |
| planChange       | requestId, clientId, action, expectedOwnershipRevision   | ConnectionPlan or explicit unavailable reason              |
| applyChange      | requestId, planId, digest, operationId                   | OperationSnapshot; cannot accept a caller approval boolean |
| getOperation     | requestId, operationId                                   | Own safe OperationSnapshot                                 |
| verifyConnection | requestId, clientId, expectedOwnershipRevision           | VerificationSnapshot                                       |
| planRollback     | requestId, appliedOperationId, expectedOwnershipRevision | New ConnectionPlan constrained to that operation           |
| cancelPlan       | requestId, planId                                        | canceled                                                   |

Apply invokes a native confirmation for the exact digest unless that same native user action already approved the prepared inline plan. The native service records the decision internally with requester/plan/digest/expiry. JavaScript/MCP cannot self-certify it. Duplicate operationId+identical intent joins/returns the same operation; different input409-equivalent operation_conflict. Plans live5min, at most4 per client; operations retained up to100 safe terminal summaries. On native navigation/logout/peer disconnect, invalidate unapproved plans, preserving already admitted transaction recovery.

## UI and MCP adapters

UI renders detected client rows with one contextual primary action and concise inline state. No setup wizard, copied config or advanced fields in the normal path. When Connect is available, an automatically prepared inline summary states selected client, Sticker rights and visibility; the single primary button confirms that visible plan. A new client with no credential can Connect through the required scoped bootstrap, not a manual-token blocker. Missing owner authority, unsupported writer or policy stays an honest brief authorization/block state; never a fake connection.

For Update show only meaningful changes, including additional visible tools or changed scope. For an exclusive managed grant Remove says “이 앱의 스티커 연결과 전용 접근 권한을 삭제합니다.” For a preexisting shared credential it states that only the registration is removed. Do not delete an existing user-created sticker entry by name. Adoption of unmanaged entries is deferred; report owned_conflict.

The WK bridge is limited to the verified pinned local application origin, current main frame/navigation generation and current authenticated owner context, with strict message schema. External/subframe/blob/file pages and stale navigation cannot invoke it. Origin is not sufficient authority: actual native user intent is required for mutation. Safe Markdown must not acquire a host primitive.

Host MCP exposes sticker_client_list, sticker_client_plan, sticker_client_apply, sticker_client_operation, sticker_client_verify, sticker_client_plan_rollback and sticker_client_cancel; these map directly to the same verbs. Mutation requires the native user confirmation; no generic permission grant tool. Host MCP is a separate local companion facade. Domain Docker STDIO does not gain host config access, home mounts or sockets; when the companion is absent it reports companion_unavailable while ordinary Sticker MCP work continues.

Use same-user XPC/protected native IPC with peer identity and installation-bound authorization. No public host-control HTTP listener or generic host-write route; the narrow server grant endpoints below manage server authority only. Actual endpoint/session security is independently reviewed before enabling a host facade; mere same-UID data from an arbitrary process is not a native user decision. The helper is not a new root service or persistent polling daemon.

## Required owner-approved credential bootstrap

This section supersedes the existing-credential-only limitation in the initial feasibility report. A new client's first Connect is **in scope**: implementing and synthetically testing the gated provisioning action is approved product work. It does not authorize issuing an actual production token, creating an operating Keychain item or granting owner access during development. Real issuance occurs only when the runtime user chooses Connect after the exact grant summary.

### Current source gaps

AuthManager parses a static agents array at startup; index.ts reads AGENT_CONFIG_PATH once, and compose.agents.yaml mounts that operator file read-only. It has no runtime provision/activate/revoke registry. MCP settings project auth.directory metadata; TemplateService currently captures an actor-array snapshot. Editing the operator file or restarting the service is not a product bootstrap mechanism and would violate the desired zero-custom-setup flow.

Add a small managed-client grant service in the existing SQLite/StoreContext transaction system. Existing configured agents/tokens/files are untouched. AuthManager retains static behavior and consults a managed hash registry on **every request**, with no positive cache surviving revocation. A bootstrap-only registry attachment before app.listen avoids changing source configuration. Settings and template-assignee directory use a live safe actor provider rather than a startup snapshot; provisional/revoked/expired identities are excluded.

### Exact consent and scope

For the first supported release, Connect's short summary says “Codex에 [현재 프로젝트] 읽기·작성을 허용합니다.” It binds a single existing current project, requested canWrite=true, native installation/connection/client IDs and exact plan digest. Owner-only actions remain owner-only. Existing matched managed credentials retain their previously approved scope/write rights; an ordinary launcher/config update does not rotate or broaden them.

projectIds is an explicit one-element existing-project array, never null/global, a wildcard, all future projects or inferred owner access. If no current project exists, report project_required; domain project creation and STK67 new-project agent access stay separate. A meaningful project choice can use the normal project selector; there is no auth-strategy/path/token wizard. Any later scope/right change needs a new visible grant plan, not silent Update behavior.

There are two independent permissions: the existing authenticated owner authorizes a scoped **server grant**; the native digest-bound user action authorizes **private storage and the exact host-client config change**. An owner session by itself never grants generic host filesystem/Keychain access. A JavaScript approved=true, same UID, agent Bearer or matching origin is not a native user decision.

### Minimum secret delivery: generate privately at the recipient

Avoid a token-returning API, encrypted delivery escrow or new authorization server. After native intent and writer readiness are established, the native app receives32 random bytes from the OS CSPRNG, encodes a high-entropy token privately, and writes a pending per-connection item to its own protected Keychain namespace. It computes SHA256 and sends **only the hash** to the existing owner-authenticated Sticker origin over a private native URLSession request. Server never sees or returns the raw token.

A fixed native launcher later receives the raw token privately from that owned Keychain item and supplies it only to the fixed adapter process environment. Raw token/hash never enters browser JavaScript, MCP arguments/results, config/argv, ownership manifest, audit/log or public error. No external crypto protocol is needed because the secret is generated where it will be used; server stores only its verifier. Private request schemas are distinct from public UI/MCP schemas.

Use the existing exact Sticker owner authority through a trusted native OwnerAuthorityProvider: verified current trusted-loopback deployment when explicitly applicable, or the app's own narrowly filtered owner session/private native login. No foreign browser-profile/cookie enumeration. If owner authentication is missing, a brief native owner-authentication step is necessary; credentials stay native/private. No existing agent token falls back to owner, no owner credential is persisted as the new agent's identity.

### Server grant contract

The new table records grantId/agentId, installationId/connectionId/clientId, tokenHash, one-project scope, requestedCanWrite, ownerId, approvalDigest, planExpiresAt, operationId, revision, provisionalUntil, state, timestamps and safe audit attribution. State is provisional|active|revoked; expired is derived from provisionalUntil, so authentication does not need a polling job or write-on-read. Raw token is absent from DB, backups and operations.

Use distinct managed IDs such as client-<UUID>. Uniqueness covers managed IDs/hash **and static configured IDs/hash**; never replace a configured actor. Capacity is100 combined static plus live active/unexpired-provisional agents, matching the existing safe directory bound. Expired/revoked rows may remain for audit but do not consume live capacity. Startup/config changes that create a collision fail closed rather than pick one identity.

| Private HTTP action                            | Authentication and strict input                                                                                                                                              | Safe output                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST /api/client-grants                        | Actual current owner, same-origin JSON; connection/client/installation IDs, single projectId, requestedCanWrite, tokenHash, native operationId, approvalDigest, confirm:true | grantId/agentId/state=provisional/revision/expiresAt and exact safe scope; no hash/token                           |
| POST /api/client-grants/:id/activate           | Fresh current owner; exact grant revision, matching native operation/digest, unexpired plan/grant, confirm:true                                                              | Active safe metadata; no token                                                                                     |
| POST /api/client-grants/:id/revoke             | Current owner; exact owned grant/revision/operationId/confirm:true                                                                                                           | Revoked safe metadata; cannot target configured agents                                                             |
| GET /api/client-grants/operations/:operationId | Current owner                                                                                                                                                                | Safe original operation result plus current effective state; no hash/token                                         |
| GET /api/client-grants/self/verify             | Exact managed token only; fixed no-content proof                                                                                                                             | Its identity, state, requested one-project scope, requestedCanWrite and effective canWrite=false while provisional |

These are narrow private bootstrap/domain authority endpoints, not generic host-write APIs. Default domain MCP never accepts tokenHash or exposes a raw credential-generation tool. sticker_client_apply invokes the same native bootstrap privately; route coverage maps these internal credential actions to that lifecycle operation with an explicit private-transport classification.

Same operationId+identical hash/scope/digest returns the same safe grant outcome, never generates a replacement token; changed input conflicts. At most one provisional grant per native operation; TTL5min. Activation requires both the original plan and grant unexpired, same owner identity and live owner authentication, matching revision/scope/digest, and no known config uncertainty in the native state machine. Stale owner/plan/grant cannot activate. Provision records planExpiresAt bounded by the native decision and5min server TTL. The native manager enforces known-config-success before activate; a caller boolean is not host attestation, and the owner endpoint grants only server authority, never host-write permission. All mutations use shared transaction/CAS and secret-free lifecycle audit events.

### Provisional means no domain access

Provisional tokens are **not ordinary read-only agents**. AuthManager gives effective canWrite=false, and authenticated API middleware permits only GET /api/session and GET /api/client-grants/self/verify. No bootstrap/issues/resources/GitHub/search reads and no domain writes are allowed; other routes deny before the handler. Static/active-agent paths are unchanged. This bounded proof plus MCP initialize/tools/list is enough for pre-activation verification; tools/list is protocol metadata, not domain access.

Activation changes the registry state to active and grants exactly the consented projectIds/canWrite. Native then performs safe MCP capabilities/project read under that token and compares actual rights to the summary. Revocation/expiry invalidates subsequent requests immediately through the real AuthManager lookup; it does not retroactively undo an already admitted operation. Managed identity state must not be copied into a stale auth cache or long-lived startup directory.

### Connect / Update / Remove ordering

1. Detect/plan includes desired grant and existing credential reuse decision. No secret is generated on render, detection, preview or an MCP request without native user intent.
2. Native Connect confirms the short exact scope and host action; verify writer conformance/readiness, current owner and plan. Reuse a matched active managed credential if its Keychain reference, connection binding and approved rights match; do not rotate needlessly.
3. For a new grant, create pending native Keychain item first, provision the hash-only provisional grant, and persist only its safe IDs in the journal. A lost provision response is recovered by the same operationId and pending native item; never silently mint another token.
4. Use provisional token only for identity/scope proof and initialize/tools/list. Apply exact client config via supported expectedVersion writer; require known success and fresh readback of the exact owned entry. An API timeout/unknown outcome, stale owner or stale plan forbids activation.
5. With fresh owner authentication and unchanged grant/plan/digest/revision, activate the grant. Perform safe domain read after activation and verify actual scope/rights. Actual selected-client catalogue may still be refresh_required; do not say connected until separately verified.
6. Failure/cancel before activation uses the unified compensation routine below. Before any config apply, clean only the new provisional grant/private item when outcomes are known. After a known config apply, expiry/owner loss/cancellation/activation refusal/verification failure all require inverse-CAS config cleanup plus separately tracked new-grant and secret cleanup. Never delete the secret or declare rollback complete while a dangling applied entry or an uncertain cleanup remains. Unknown activation is queried first; foreign edits and existing credentials are preserved.
7. Ordinary Update reuses an active matched credential. On failure it must not revoke a previously working grant it did not create. Missing/lost managed private item is repaired only by an explicit fresh Connect grant plan; no manual token field or automatic scope increase.
8. Remove first version-deletes the exact owned entry, then revokes **its exclusive managed grant** and removes the associated Keychain item. If revocation/cleanup is pending, report cleanup_pending rather than complete. Never revoke a configured/shared/preexisting credential. Revoked grants cannot be resurrected by rollback; reconnect requires fresh explicit consent.

Journal recovery distinguishes provisioned, config_applied, activated and each compensation receipt defined below. Persist IDs/approval digest/reference IDs only; no raw token/hash. Do not activate after config uncertainty just because desired bytes happen to match. Owner expiry does not erase an applied-config cleanup obligation; retain ownership, private credential reference and inverse-patch recovery until independently resolved. No automatic login or wider grant.

### Unified post-apply compensation (review N1)

Every failure/cancellation after a **known successful config apply** and before successful activation plus required verification enters the same journaled compensation routine: plan/grant expiry, owner-session loss, native cancellation, definitive activation refusal and verification failure. Credential-only cleanup is never sufficient for this phase.

The journal tracks independent receipts: configCompensation=not_needed|pending|restored|conflict|uncertain, newGrantCleanup=not_created|pending|revoked|confirmed_expired|uncertain, and secretCleanup=not_owned|retained|deleted. It also records known-applied config identity/version/inverse patch and activation outcome. All refer only to the exact admitted operation and newly created exclusive grant; an Update's reused working/shared credential is never revoked or deleted.

Compensation revalidates the recorded installation/ownership and reads the latest user-layer version. If the current config and owned entry still satisfy the exact applied-state checks, submit the inverse owned patch with fresh expectedVersion, then read back and journal restored. Never restore the entire backup or overwrite an intervening edit. A version/owned-state change stops this attempt as conflict; a new explicit planRollback may later re-evaluate only the owned inverse against current state, preserving every foreign edit.

The original admitted native intent covers this bounded inverse cleanup even after the original plan expires or server owner authority is lost. It never permits activation, a fresh grant or a broader host edit. Local compensation rechecks the trusted native installation/requester; grant revocation still requires its real current server authority. No stale owner cookie reuse, automatic login or generic repair primitive is introduced.

Config compensation, new-grant revocation/confirmed expiry and safe secret disposal converge independently. **Retain the pending Keychain item and ownership/recovery record until config is restored/not applied (or otherwise conclusively no longer references it) and the new grant is confirmed terminal.** If config cleanup conflicts, revocation cannot be confirmed, owner authority is missing, or any outcome is unknown, report cleanup_pending/conflict/uncertain; do not label canceled/rolled_back/removed. Provisional TTL limits access but is not a fabricated cleanup receipt.

A lost apply/activation response is resolved by the existing safe journal/readback and server operation-query rules before deciding cleanup; matching bytes alone do not prove an unknown apply, and unknown activation must not be treated as merely expired provisional. No uncertain mutation is blindly repeated and no revoked authority is resurrected.

Retry/restart resumes the same operation's incomplete compensation receipts. getOperation is read-only. A “정리 다시 시도” action may reuse applyChange with the recorded plan/digest/operationId to resume only this admitted cleanup; it cannot bypass new-action expiry to activate or issue credentials. Once config and grant cleanup are confirmed, delete only the operation-owned secret/reservation and mark rolled_back; the next explicit Connect can start normally without technical fields. If a user edit prevents compensation, keep it intact and offer the existing fresh bounded rollback preview, not overwrite/adoption.

### Persistence and restoration

Managed grants survive ordinary server restart by persisted hash/state; static operator config remains read-only and unchanged. Extend migration/schema manifest/backup validation with the actual next available migration agreed by the source writer. Supported backup restoration must invalidate restored managed grants before serving, so restoring an old DB cannot revive revoked client access; existing configured agents remain governed by their operator file. This is an explicit restore hook/test, not an OS security change or a new cryptographic epoch service.

Implement the gated server/native action and synthetic tests as a **required part of this lifecycle increment**. No real Keychain write, permanent token, owner grant or production activation is performed during development. At runtime the user's scoped Connect choice supplies that specific authorization; it is not a technical setup prerequisite to be completed manually elsewhere.

## Ownership and preservation

Private manager state lives in a fixed Sticker application-support root, current-user owner,0700 directories/0600 records; no symlink or hardlink traversal. Limit configuration input2MiB, plan64KiB and journal256KiB per transaction; unsupported larger config fails rather than truncates. Full backups contain other entries/secrets: never expose them as artifacts/tool results, preserve securely, retain newest3 per target plus any unresolved transaction (bounded total32MiB; refuse new apply if retention cannot safely free capacity).

OwnershipManifest v1 stores installationId, fixed client/profile ID, target kind/scope, exact server key sticker, connectionId, managed entry digest, last provider version, ownershipRevision, creation operationId, launcher build identity, credential reference ID, managedGrantId/revision/ownership (or preexisting-shared), verification summary and transaction state. No caller-controlled file path or raw credential. Same server name is not ownership. For Connect only, an absent target entry plus no existing connection manifest permits a new ownership reservation bound to the preview version; if another writer creates that entry before apply, the version conflict stops creation. An existing entry without a matching manifest, changed managed leaf or foreign installation returns owned_conflict; no automatic adoption or repair.

The provider privately projects the exact owned leaf. Unknown fields, unowned servers, comments, user filters/approvals and non-Sticker settings must be preserved. Native planning emits only the fixed owned-subtree edit through the official provider, never a full-file TOML/JSON reserialization; raw bytes are kept only for private backup. Provider parsing/edit semantics that cannot preserve supported content fail conformance or return unsupported_profile. No separate native TOML editor or raw-file writer is introduced.

## Supported versioned writer and conformance gate

Native writer interface is deliberately narrow:

```text
readOwnedTarget(profileId, connectionId) -> PrivateConfigSnapshot
canMutate(snapshot) -> CertifiedVersionedWriter | writer_unavailable
applyOwnedPatch(expectedVersion, exactOwnedPatch, operationId) ->
  Applied(newVersion, privateReceipt) | Conflict | Denied | Uncertain
readOperation(operationId) -> Applied | NotApplied | Conflict | Unknown
restoreOwnedPatch(expectedCurrentVersion, inverseOwnedPatch, operationId) ->
  Applied | Conflict | Denied | Uncertain
```

The public API never exposes provider method names, key paths or config file locations. Implement CodexAppServerWriter around config/read with includeLayers:true and config/batchWrite. Select the user layer only, validate its fixed derived target privately, and construct edits only for the manifest-owned mcp_servers.sticker subtree. expectedVersion comes from that fresh layer, filePath is internally derived/validated, reloadUserConfig:false. Never forward arbitrary RPC/filePath/keyPath/edits from callers. Preserve unrelated fields, custom tool filters and approvals.

Map data.config_write_error_code=configVersionConflict to conflict with no retry; configValidationError to invalid with no partial success; status=okOverridden to saved-but-policy-overridden, never connected. Persist returned receipt privately, then obtain a fresh user-layer snapshot before inverse rollback or any later write. Provider has no established operationId/durable operation-query RPC: the manager's operationId is local journal/idempotency metadata, not an invented batchWrite parameter. readOperation in the narrow adapter means local receipt/journal plus safe readback; unprovable outcome stays Unknown and is not blindly repeated.

Next synthetic conformance gate for exact supported Codex version: missing-config create from read version; valid update preserving foreign settings/comments and custom filters; stale read after ordinary external edit returns conflict and leaves new bytes intact; two app-server writers competing from the same version have at most one accepted conflicting write; invalid multi-edit batch makes no partial change; exact owned-entry delete through documented supported edit semantics; fresh-read inverse rollback; intervening foreign edit rejects rollback; target/permission/I/O errors and unknown outcomes. Do not assume null means delete until the isolated fixture proves the supported semantics. If no supported leaf deletion exists, remove remains unavailable while that gap is resolved; never replace the whole mcp_servers map as a shortcut.

Until conformance passes the profile reports writer_unavailable; afterward enable the tested Codex writer only. Fake CAS tests prove manager logic, not runtime certification. Raw-file CLI/editor fallback and stopped PR93 primitives remain disabled; no force/ignore-conflict bypass. The exact unresolved guarantee is supported ordinary concurrent-edit detection and preservation in current-version batchWrite, not impossible protection against every malicious filesystem writer.

## Transaction, private backup and rollback

Manager serializes operations per fixed target and uses provider CAS. Private Sticker-owned state itself can use fsync and same-volume atomic rename; that does not supply CAS for shared config.

1. Revalidate plan expiry/digest/requester/native decision, ownershipRevision, installation/client identity and credential reuse or exact new-grant intent. Obtain fresh config/read user-layer snapshot and check its version and owned entry against preview. Mismatch → conflict, no mutation; no automatic new plan silently incorporates a foreign change.
2. Persist bounded private full backup and inverse owned patch; record PREPARED with expected version, operationId and intent. fsync backup/journal. Full bytes never enter public result.
3. Call certified applyOwnedPatch once with expectedVersion. On conflict/denial keep config unchanged and return precise reason; on unknown outcome use readOperation/readOwnedTarget before deciding. Never blind retry an uncertain write.
4. Record PROVIDER_APPLIED receipt, then read back the fresh user-layer version and exact owned leaf before updating manifest atomically. A write response version is not reused as a CAS token. Cross-file journal recovery handles interruption; no pretend two-file transaction.
5. For a new grant, pre-activation verification uses only identity/self-proof+initialize/tools/list. After config success/readback and fresh owner/plan validation, activate; only then perform a safe domain read and compare effective scope/write rights. Existing matched active references use their current approved rights. No model turn or domain mutation.
6. Every post-apply failure/cancellation before successful activation/required verification enters Unified post-apply compensation (N1), including expiry, owner loss and activation refusal. Use fresh expectedVersion inverse CAS only for the recorded unchanged applied state, track config/grant/secret receipts separately and preserve foreign edits. Cleanup unavailable/unknown is pending/conflict/uncertain, never completed credential-only rollback. A merely stale actual-client catalogue remains refresh_required, not a transport failure.
7. Commit safe verification result and ownership revision, retain rollback capability. A user-requested rollback is a new inverse-owned patch plan against current state, not an arbitrary backup path.
8. Recovery inspects journal/receipt and fresh readback. A supported no-write error can mark failed. A known applied operation may continue verification only with current valid activation authority/plan; otherwise resume its bounded compensation, never stale activation. Unknown apply/activation is queried/read back under established rules, not inferred from matching bytes or replayed blindly. Unresolved cleanup pins backup, ownership and the operation-owned secret reference.

Remove follows exact owned-leaf deletion, then revokes only its exclusive managed grant and deletes that Keychain item. Revoke failure stays cleanup_pending; a configured/shared credential is untouched. Parent containers may be removed only if manager-created and still empty. No live client process is terminated; revoked managed-token requests fail while stale catalogue may remain refresh_required.

## Verification truth and simple feedback

VerificationSnapshot separates:

- config: not_checked | saved | conflict | invalid;
- protocol: not_checked | initialized | tools_verified | failed;
- actualClient: unknown | refresh_required | verified | policy_blocked;
- catalog: expected count/names digest, available count, missing safe names;
- actor: safe current role/canWrite/project scope summary;
- checkedAt, bounded error code and suggested single next action.

A new direct SDK process can initialize while the selected client's current session still uses old filters. Show “설정 저장됨 · 새 대화에서 확인 필요” where client runtime reload cannot be verified. Claim “연결됨” only when actualClient=verified and tools_verified with successful safe read under intended identity. “다시 시작 필요” is used only for a verified provider/runtime requirement, never as a guess; no automatic restart.

Safe probes invoke only fixed Sticker launcher, initialize/tools/list, bounded provisional self-proof before activation and safe capabilities/project reads after activation. Timeout15s, one probe per client, no unrelated MCP servers. Tools/list does not prove write rights; effective permission comes from verified server identity/capabilities. Client status APIs must be projected privately; raw CLI JSON/stdout may contain secrets and unrelated configuration.

## Acceptance and release gates

| Gate                 | Required evidence                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex metadata/UI    | Fixed profiles; safe not-detected/ambiguous/unsupported states; no CLI re-probe or operating config values in this docs task                          |
| Pure plans/ownership | Zero normal text fields; same typed action through UI/MCP; unowned/modified entries cannot apply                                                      |
| Native authority     | Origin/frame/navigation checks, authenticated peer and native digest-bound user decision; forged caller fields rejected                               |
| Credential           | Required owner-approved scoped provision/activate/revoke; provisional domain access denied; configured/shared tokens preserved                        |
| Real writer          | Exact runtime synthetic conformance for supported expectedVersion/conflict/atomic batch/delete/inverse rollback; otherwise affected mutation disabled |
| Transaction          | Private backup, operation replay, journal recovery, inverse CAS rollback refusing foreign writes                                                      |
| Protocol/client      | initialize/tools/safe read evidence separate from actual runtime/reload state; no fake connected state                                                |
| Live rollout         | Separate actual config/access authorization; no account/OS/security/client restart without explicit separate intent                                   |

Measure ordinary eligible flow: one visible product action after the inline plan is ready; zero custom technical inputs. Record native security/provider prompts separately. The new-client credential bootstrap is required for acceptance; only absent owner authority or failed bootstrap is a blocker, not mere absence of a pre-provisioned token. Unsupported writers remain blocked/unshipped.

## Test matrix

Use injected discovery, fixture-only roots, fake storage-enforced CAS and fixture credentials initially. No actual operating config read/write, Keychain mutation, live account, CLI startup/help probe, PR93 primitive or GUI operation in this design task.

Tests cover wrong client IDs, ambiguous metadata, config limits/duplicate keys/Unicode, unmanaged and modified-owned entry, expired plans, altered digest/requester, peer/frame/origin/navigation forgery, missing/expired credentials, concurrent foreign update before/during/after apply and rollback, unknown provider outcome, every journal crash boundary, backup limits/permissions, cancellation and same-operation replay, missing tool/permission drift, actual client stale/blocked state and secret-free responses. A fake CAS test cannot enable a real backend. Client certification remains a separately reviewed offline-first gate, with actual mutations separately authorized.

## Outstanding decisions are explicit blockers

Codex has an identified supported versioned write path and older public/synthetic evidence; current-version concurrent-edit/delete/rollback conformance remains to be implemented, not a permanent architectural impossibility. Unsupported/failed conformance keeps that action disabled. Server hashes cannot recover secrets; the required owner-approved native-generated-secret/hash-only bootstrap handles first connection without manual secret setup. Claude Code certification/runtime is pending; Claude Desktop is provider-managed. Full lifecycle remains incomplete until gated new-client provision/activate, ordinary update reuse, exclusive managed revoke, connect/update/remove and selected-client verification pass. Domain parity is independent. No PR93 stopped action or Codex alias probe is retried.
