# Native client lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This documents-only delegation does not authorize implementation, subagents, operating configuration changes or retries of stopped probes.

**Goal:** Build the smallest Codex-first native connection manager with zero custom setup fields, shared UI/MCP typed operations and truthful blocked/verified states.

**Architecture:** A native Swift manager owns fixed discovery profiles, private ownership/transaction records and a fail-closed provider-writer interface. WK UI and a separate host MCP facade call the same manager; ordinary Docker domain MCP receives no host filesystem capability. Codex config/read user-layer versions and config/batchWrite expectedVersion are the selected write path; enable after narrow current-version conformance. Required first-use bootstrap generates a secret privately in native storage and provisions only its scoped hash after runtime owner/native consent. Raw-file fallback remains barred.

**Tech Stack:** Swift5/Foundation/AppKit/WebKit, existing TypeScript/zod/MCP SDK/React/node:test; native fixture runners following tests/native/run-access-core.sh; macOS11.3+. No new dependency or privileged daemon in the initial design.

**Spec:** docs/superpowers/specs/2026-10-31-native-client-lifecycle-design.md

## Global Constraints

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

Future source work must coordinate with the root's single writer and exact base. Do not commit/publish/deploy from this plan without the current parent authorization. Existing independent domain-parity work continues separately.

## Review Focus

- Same-name foreign or user-modified owned entry must never be adopted/deleted automatically (Tasks2/4).
- Foreign update between snapshot/apply/rollback must remain intact even after verification failure or crash (Tasks3/4).
- WK origin/peer checks and caller approval flags must never replace a real native digest-bound decision (Task7).
- No new token on detect/preview; runtime native+owner consent is required, provisional access is tightly bounded, and configured actors never change (Tasks5–6).
- Direct initialize success with stale actual-client tool filters must show refresh_required, not connected (Task8).

## File responsibilities and dependency map

Proposed new files are explicit implementation targets, not files created by this docs task.

| Files                                                             | Responsibility                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| packaging/macos/client-lifecycle/LifecycleTypes.swift             | Strict bounded Codable wire DTOs and enums                                             |
| packaging/macos/client-lifecycle/ClientProfiles.swift             | Fixed client IDs, metadata-only candidates and support table                           |
| packaging/macos/client-lifecycle/OwnedConnectionStore.swift       | Private manifest/journal/backup ownership and bounded state                            |
| packaging/macos/client-lifecycle/ConnectionPlanner.swift          | Private exact-owned-leaf changes and digest-bound public plans                         |
| packaging/macos/client-lifecycle/VersionedWriter.swift            | Narrow versioned protocol, capability gate and test-only fake CAS                      |
| packaging/macos/client-lifecycle/CodexAppServerWriter.swift       | Fixed user-layer read/batchWrite adapter, expectedVersion/conflict/override projection |
| tests/native/client-lifecycle/CodexWriterConformanceTests.swift   | Synthetic exact-version writer conformance without live config/grants                  |
| packaging/macos/client-lifecycle/NativeConnectionManager.swift    | Serialized plan/apply/verify/rollback state machine                                    |
| packaging/macos/client-lifecycle/ExistingCredentialProvider.swift | Matched managed-reference reuse without unnecessary rotation                           |
| packaging/macos/client-lifecycle/StickerConnectionLauncher.swift  | Fixed installed launcher/probe mechanics with private environment                      |
| packaging/macos/client-lifecycle/ConnectionVerifier.swift         | SDK/protocol and actual-client verification projections                                |
| packaging/macos/client-lifecycle/LifecycleBridge.swift            | WK origin/frame/navigation and native intent adapter                                   |
| packaging/macos/client-lifecycle/LifecycleIPC.swift               | Fixed same-user host-facade peer/framing boundary                                      |
| client/features/mcp-settings/lifecycle-contract.ts                | zod mirror + public operation schemas                                                  |
| client/features/mcp-settings/NativeClientConnections.tsx          | Simple detected client cards and one contextual action                                 |
| client/features/mcp-settings/useNativeLifecycle.ts                | Typed bridge lifecycle, cancellation and stale response guard                          |
| server/mcp/native-client-lifecycle.ts                             | Separate host-only facade registration; no domain HTTP route                           |
| tests/native/client-lifecycle/*.swift                             | Focused native fixture and adversarial tests                                           |
| tests/native/run-client-lifecycle.sh                              | Explicit-output native fixture runner, no installed CLI                                |
| tests/native-client-lifecycle-contract.test.ts                    | Wire parity/secret/limits/host-only facade tests                                       |
| tests/ui/native-client-connections.test.tsx                       | Button and truthful status tests                                                       |
| tests/fixtures/native-client-lifecycle/*                          | Nonsecret TOML/JSON/provider receipts and metadata only                                |

Additional required files: server/contracts/client-grants.ts, server/features/client-grants.ts, server/routes/client-grants.ts and a source-writer-coordinated next numbered migration; native CredentialBootstrap.swift/NativeClientGrantAPI.swift; server/native grant lifecycle tests in Tasks5–6. Existing configured-agent files remain untouched.

Keep large implementation units split by the listed responsibility; do not enlarge StickerApp.swift into a config engine. Tests inject fixed fixture roots via construction; production wire never takes those paths.

Dependencies: Task1 profiles/types → Task2 pure ownership/plans → Task3 writer gate → Task4 transaction manager → Task5 server managed grants → Task6 native bootstrap/launcher → Task7 UI/IPC/MCP → Task8 verification → Task9 integrated release evidence. Task3 implements the supported Codex writer and resolves narrow conformance before live activation; a failed action stays unavailable without blocking domain parity.

## Task1: Fixed profiles and strict wire contract

**Files:** Create LifecycleTypes.swift, ClientProfiles.swift, lifecycle-contract.ts, tests/native/client-lifecycle/ProfilesTests.swift and WireTests.swift, tests/native-client-lifecycle-contract.test.ts, tests/native/run-client-lifecycle.sh. Modify package.json only to add a focused test script if useful; do not change app behavior yet.

**Interfaces:**

- Swift ClientId raw values codex-local, claude-code-local, claude-desktop.
- ClientProfiles.detect(using: MetadataDiscovery) async -> [ClientSnapshot].
- Strict public envelopes version1 with detectClients/planChange/applyChange/getOperation/verifyConnection/planRollback/cancelPlan.
- TypeScript nativeLifecycleRequestSchema/nativeLifecycleResponseSchema mirror those names/fields/limits.
- MetadataDiscovery is fixture-injectable; no process execution in production metadata detection.

- [ ] Write RED tests named fixed_ids_reject_paths, ambiguous_install_has_no_selected_winner, claude_desktop_is_provider_managed, version_unknown_has_no_mutation_actions, wire_rejects_secret_or_unknown_fields and wire_maximum_64kib.
- [ ] Run bash tests/native/run-client-lifecycle.sh test-results/native-client-lifecycle/task1; expected failing assertions/missing new types, no installed CLI/account access.
- [ ] Implement exact DTOs/support enums from spec; candidate cap16, message64KiB. Metadata discovery uses fixed known roots/Launch Services, no recursive user scan or help/version. Initial snapshots have writer_unavailable for Codex mutation and no Claude lifecycle claim.
- [ ] Run native focused runner and node --import tsx --test tests/native-client-lifecycle-contract.test.ts; expected PASS with no live config access.
- [ ] Review raw result projection for local path/config/token leakage; retain task-specific RED/GREEN evidence. Do not mark any client connection verified.

## Task2: Private ownership and pure plans

**Files:** Create OwnedConnectionStore.swift, ConnectionPlanner.swift, tests/native/client-lifecycle/OwnershipTests.swift and PlanTests.swift; seed nonsecret fixture files under tests/fixtures/native-client-lifecycle.

**Consumes:** Task1 DTOs and fixed profiles.

**Produces:**

- OwnedConnectionStore.load(connectionId: ConnectionId) throws -> OwnershipManifest?.
- ConnectionPlanner.plan(snapshot: PrivateConfigSnapshot, ownership: OwnershipManifest?, intent: ChangeIntent, now: Date) throws -> PrivateConnectionPlan.
- PrivateConnectionPlan.publicPlan: ConnectionPlan; private exactOwnedPatch/inverseOwnedPatch.
- Pure canonical digest implementation shared by planner/validator; never includes raw secret.

- [ ] RED tests absent_entry_connect_reserves_new_ownership, unmanaged_same_name_never_owned, user_modified_leaf_conflicts, foreign_installation_conflicts, preserve_unowned_fields_and_comments, reject_ambiguous_duplicate_keys, config_limit_2mib, plan_expiry_5min, plan_cap_four_per_client and plan_digest_binds_every_managed_change.
- [ ] Run native focused runner task2; expected FAIL before implementation.
- [ ] Implement fixed private storage root guards: current user,0700 directory/0600 records, regular single-link files/no symlink. Planner consumes the provider's parsed owned projection, emits only a fixed owned-subtree edit and leaves TOML/JSON parsing/preservation to the official provider; opaque fixed-target bytes are private backup only. Reject provider parse/ambiguous-format errors. No separate native TOML editor or shared config write method.
- [ ] Add fixture test that existing16-tool filter and per-tool approvals remain unchanged unless exact visible approved desired change says otherwise; no unmanaged adoption action.
- [ ] Run Task1–2 tests; expected PASS. Review public plans contain only client/rights/change summaries and opaque versions, not paths/config/secrets.

## Task3: Supported Codex expectedVersion writer and narrow conformance

**Files:** Create VersionedWriter.swift, CodexAppServerWriter.swift, tests/native/client-lifecycle/WriterGateTests.swift, FakeVersionedStore.swift and CodexWriterConformanceTests.swift; add nonsecret fixture transcripts derived from supplied public schema/older synthetic evidence. Never copy raw evidence/config values into public artifacts.

**Consumes:** PrivateConfigSnapshot and exact owned patch from Task2.

**Produces:**

- VersionedWriter.readOwnedTarget(profileId:connectionId:) async throws -> PrivateConfigSnapshot.
- applyOwnedPatch(expectedVersion:patch:operationId:) async -> ProviderWriteResult.
- readOperation(operationId:) async -> ProviderOperationState.
- restoreOwnedPatch(expectedCurrentVersion:inversePatch:operationId:) async -> ProviderWriteResult.
- WriterRegistry.writer(for: VerifiedClientIdentity) -> CertifiedWriter? selects only a tested supported Codex runtime/profile; returns nil for failed/unknown versions and all uncertified Claude profiles.
- CodexAppServerWriter uses config/read(includeLayers:true) user layer followed by fixed config/batchWrite(edits,expectedVersion,filePath,reloadUserConfig:false). operationId is local metadata, never an invented provider field.

- [ ] RED contract tests hash_then_rename_is_not_writer, expected_version_from_fresh_user_layer_not_write_response, conflict_error_never_retried, validation_error_no_partial_success, ok_overridden_never_connected, unknown_version_unavailable and caller_cannot_supply_rpc_path_or_edits.
- [ ] Run focused native runner task3; expected FAIL.
- [ ] Implement CodexAppServerWriter around supplied public0.165 schema/fixture contracts, privately selecting the fixed user target. Project only mcp_servers.sticker, preserve filters/foreign fields; do not use generic config-read output as UI data. configVersionConflict returns conflict; configValidationError returns invalid. No CLI remove/add/raw-file/PR93 fallback.
- [ ] Add synthetic conformance cases for the exact future supported version: missing-config create, preserving update, ordinary external edit between read/write, two provider writers with same expectedVersion, invalid multi-edit atomic failure, exact owned-leaf deletion, fresh-read inverse rollback and foreign-edit rollback conflict. Delete/null semantics must be proven, not guessed. Failure disables the affected action.
- [ ] Reuse older synthetic/public records now without executing anything. Before any new app-server fixture execution, prove child config/cache/alias roots are isolated and reviewed through the parent's approved fixture harness; current stopped help/PR93 probes remain barred. No operating config/account/credential is touched. This future synthetic conformance is the next implementation gate, not a new live-authority request.
- [ ] Run focused injected transport tests; expected PASS. A fake CAS store validates manager logic only. Enable real-profile capability only after actual supported-version fixture conformance is recorded and independently reviewed; otherwise keep writer_unavailable.

Concurrency acceptance covers ordinary user/client edits detected by the supported version protocol, not a malicious writer bypassing all client storage semantics. The remaining uncertainty is current-version expectedVersion/edit/delete/rollback behavior under those ordinary cases. Do not create a permanent impossible certification condition or label detection-only completion.

## Task4: Journaled manager, replay and inverse CAS rollback

**Files:** Create NativeConnectionManager.swift; extend OwnedConnectionStore.swift private journal/backup functions; tests/native/client-lifecycle/TransactionTests.swift, RecoveryTests.swift and ConcurrentWriterTests.swift.

**Consumes:** Tasks1–3; injected clock, credential-bootstrap/owner-authority ports and VerificationProvider fixtures. Concrete grant implementation follows in Tasks5–6.

**Produces:**

- NativeConnectionManager.handle(_ request: LifecycleRequest, context: TrustedRequestContext) async -> LifecycleResponse.
- NativeDecisionStore recording exact requester/plan/digest/expiry from native UI only.
- OperationSnapshot phases from spec; planRollback creates a new exact inverse action.
- resumeCompensation(operationId:trustedContext:) resumes only the exact admitted inverse cleanup; independent configCompensation/newGrantCleanup/secretCleanup receipts persist across retry/restart.
- No public backup path, generic repair primitive or arbitrary restore method.

- [ ] RED tests forged_approval_field_rejected, expiry_before_apply_no_write, ownership_revision_conflict, same_operation_joins_once, reused_operation_different_digest_conflicts, provider_unknown_not_retried and cancel_before_confirmation_has_no_write.
- [ ] RED concurrent tests foreign_update_before_apply_preserved, foreign_update_during_apply_preserved, foreign_update_after_apply_blocks_rollback and whole_backup_never_overwrites_latest_file. Use real competing fake-store tasks, not sleeps asserting implementation strings.
- [ ] RED crash matrix after backup/PREPARED/provider receipt/manifest/verification; recover receipt+matching state once; unsupported/unknown outcome remains uncertain without an invented provider operation-query RPC or blind replay.
- [ ] RED post-apply tests known_apply_then_plan_expiry_compensates_config, known_apply_then_owner_loss_compensates_without_login, known_apply_then_cancel_compensates, known_apply_then_activation_refusal_compensates and lost_activation_reply_queried_before_cleanup. Assert config restored before terminal secret disposal, or exact cleanup_pending/conflict/uncertain receipts.
- [ ] RED retry/restart tests crash_between_config_grant_secret_cleanup_receipts_converges, same_operation_resumes_cleanup_not_activation, expiry_allows_only_bounded_inverse_cleanup, intervening_edit_preserved_with_recovery_retained and next_explicit_connect_after_confirmed_cleanup_needs_no_fields.
- [ ] Implement one writer per fixed target; private fsync/atomic manifest/journal only. Backup newest3+unresolved, total32MiB; config2MiB, journal256KiB. Before every provider write/rollback obtain a fresh user-layer version and validate owned state; write-response version is receipt only. No direct shared-file fallback.
- [ ] Run native focused runner task4; expected all tests PASS. Verify default unavailable writer makes connect/update/remove return writer_unavailable with zero store mutations.
- [ ] Implement one unified post-apply compensation routine for all listed failures. Original admitted native intent permits only the exact inverse cleanup after plan expiry; current server authority is still required for grant revocation. Keep operation-owned Keychain/reference and ownership records until config and new-grant terminal receipts permit disposal. Unknown apply/activation is resolved first; no foreign overwrite, stale activation or automatic login.
- [ ] Record private fixture cleanup and secret-free terminal summaries cap100; unresolved backup pins must not be evicted.

## Task5: Managed scoped grant registry and actual AuthManager enforcement

**Files:** Create server/contracts/client-grants.ts, server/features/client-grants.ts, server/routes/client-grants.ts; modify server/auth.ts, server/app.ts, server/domain.ts, server/features/templates.ts and live actor-directory seams. Add the next free numbered client-grants migration with server/migrations/index.ts/schema-manifest/backup validation and scripts/restore.sh restoration hook; source writer allocates the sequential slot before implementation. Tests: tests/client-grants.test.ts, tests/client-grants-http.test.ts, tests/client-grants-auth.test.ts and backup/restore regression.

**Consumes:** Native public plan/digest definitions, existing owner/session/origin and StoreContext transactions. No host-write primitive.

**Produces:**

- ClientGrantService.provision(owner, strictPrivateInput), activate(owner,id,input), revoke(owner,id,input), operation(owner,operationId), verifySelf(managedProof).
- ManagedAgentRegistry.resolveHash(hash,now) -> active/provisional/expired/revoked safe internal identity; directory() includes active only.
- AuthManager merges static and managed authentication per request; existing authenticate contract remains compatible, with internal managed state for provisional route restriction.
- Fixed private routes from spec; all public results project safe metadata, never tokenHash/raw token.

- [ ] RED tests static_agents_unchanged, managed_static_id_or_hash_collision_denied, global_live_capacity_100, same_operation_same_payload_one_provisional, reused_operation_changed_scope_conflicts and grant_single_existing_project_no_global_or_stk67_expansion.
- [ ] RED actual HTTP/AuthManager tests provisional_allows_only_session_and_self_verify, provisional_denies_all_domain_reads_and_writes_before_handler, expired_provisional_denied, activation_requires_current_owner_unexpired_plan_digest_revision, agent_bearer_cannot_provision_or_activate, revoked_token_next_request_denied and no_positive_auth_cache.
- [ ] RED secret/restart tests native_only_hash_request_not_echoed, no_raw_token_in_db_response_log_audit_backup, restart_preserves_active_hash_registry, restored_backup_invalidates_managed_grants and live_directory_omits_provisional_revoked_expired.
- [ ] Run node --import tsx --test tests/client-grants.test.ts tests/client-grants-http.test.ts tests/client-grants-auth.test.ts; expected RED before implementation. All stores/principals/tokens disposable fixture values; no operating credentials.
- [ ] Implement persisted provisional/active/revoked service with5min provisional TTL, shared CAS/idempotency/audit, distinct client-UUID IDs and static collision checks. Attach registry before listening; no AGENT_CONFIG_PATH edit or service restart required for provision/revoke. Auth middleware restricts provisional paths independently of canWrite=false.
- [ ] Change actor-directory consumers to a live safe provider where needed, preserving existing array callers/tests. Implement restore invalidation before restored server admission; update migration/backup contracts without copying raw token anywhere.
- [ ] Run focused grant/auth/HTTP/template/MCP-settings and migration/backup regressions; expected GREEN. Provisional proof is not permission to call ordinary capabilities/bootstrap; active scope remains domain-authoritative.

## Task6: Native private bootstrap, credential reuse and fixed launcher

**Files:** Create ExistingCredentialProvider.swift, CredentialBootstrap.swift, NativeClientGrantAPI.swift and StickerConnectionLauncher.swift; tests/native/client-lifecycle/CredentialTests.swift, BootstrapTests.swift and LauncherTests.swift; add tests/native-client-grant-journey.test.ts using the synthetic server from Task5. Modify scripts/install-access.sh source list only after fixtures pass; do not run actual installer.

**Consumes:** Task5 private grant contracts, manager plan/native intent, fixed Installation identity and supported writer. OwnerAuthorityProvider supplies only current Sticker owner authority from trusted native context, never caller role flags.

**Produces:**

- CredentialBootstrap.ensureForApprovedConnect(plan, nativeDecision) -> reused active reference | provisional owned grant/reference | typed failure.
- activateAfterKnownConfig(plan, grantReceipt, verifiedOwnedConfigReceipt); unknown config outcome cannot activate. All post-apply failures call Task4 resumeCompensation; cleanupNewGrant is an internal subordinate receipt step, never standalone completed rollback.
- ExistingCredentialProvider.resolveApprovedCredential(installationId,connectionId) remains the reuse path, not the only first-use path.
- NativeClientGrantAPI calls only fixed same-origin private routes with private hash payloads; no UI/MCP token/hash argument/result.
- launchOwnedConnection(installationId:connectionId:transport:) resolves owned Keychain secret privately; no public command/path/env input.

- [ ] RED tests render_or_plan_never_generates_secret, runtime_connect_native_decision_required, short_grant_binds_current_project_and_canwrite, native_random_raw_token_never_sent_server, keychain_denial_no_active_grant, server_hash_cannot_recover_old_token and agent_error_never_falls_back_owner.
- [ ] RED state-machine tests provisional_proof_before_domain_access, no_activation_after_config_timeout_or_stale_owner_plan, activate_only_after_known_config_readback, lost_provision_response_reuses_pending_secret_and_operation, lost_activation_response_queries_outcome, orphan_provisional_expires and no_duplicate_pending_grant.
- [ ] RED new-connect tests post_apply_expiry_or_owner_loss_keeps_secret_until_config_and_grant_cleanup_confirmed, config_conflict_retains_private_recovery_without_foreign_overwrite, unknown_activation_not_assumed_expired, prior_update_shared_secret_untouched and explicit_cleanup_retry_resumes_same_operation_after_restart. Use Task4 compensation across every path; no credential-only terminal success.
- [ ] RED lifecycle tests ordinary_update_reuses_matched_active_credential_without_rotation, failed_update_preserves_prior_working_grant, failed_new_connect_revokes_only_new_owned_grant, remove_revokes_only_exclusive_managed_grant, cleanup_pending_not_complete and rollback_never_resurrects_revoked_grant.
- [ ] Run focused native runner task6 plus node --import tsx --test tests/native-client-grant-journey.test.ts; expected RED. Inject RNG/secure-store/owner authority/transport and synthetic server; no real Keychain or permanent grant.
- [ ] Implement OS CSPRNG/private pending Keychain adapter and in-memory fixture equivalent; provision only SHA256 hash after explicit native Connect consent, verify provisional identity+initialize/tools, apply config, activate with fresh owner/grant/plan, then safe active-domain read. Never expose raw token/hash/config/cookie in public state.
- [ ] Fixed launcher supplies raw token only to trusted adapter environment. No shell, Docker socket/context change, service auto-start or account login. Missing owner authority uses brief native authentication only when runtime user chooses; no auth-strategy wizard or developer activation.
- [ ] Run native/server synthetic full new-client Connect→Update reuse→Remove/revoke, cancel/expiry/conflict/restart-cleanup and secret canaries; expected GREEN. Code/tests implement the required gated bootstrap; actual Keychain/server production grant occurs only at runtime Connect, never as a development test.

## Task7: Native confirmation bridge, host MCP facade and simple screen

**Files:** Create LifecycleBridge.swift, LifecycleIPC.swift, NativeClientConnections.tsx, useNativeLifecycle.ts, server/mcp/native-client-lifecycle.ts; modify packaging/macos/StickerApp.swift, client/features/mcp-settings/McpSettings.tsx and focused styles. Add tests/native/client-lifecycle/BridgeTests.swift and IPCTests.swift, tests/ui/native-client-connections.test.tsx; extend contract tests.

**Consumes:** NativeConnectionManager.handle, Tasks5–6 gated bootstrap and Task1 DTOs. No host-control HTTP route; only Task5's narrow server grant routes.

**Produces:**

- WK bridge fixed channel stickerClientLifecycle with origin/main-frame/navigation generation checks.
- Native confirmation bound by NativeDecisionStore, never caller approved=true.
- registerNativeClientLifecycleTools(server, companionClient) host-only registration with seven names from spec.
- UI renders three fixed client rows and no technical text-input field.

- [ ] RED tests remote_origin_subframe_stale_navigation_rejected, arbitrary_path_shell_rpc_payload_rejected, forged_peer_no_native_decision, native_decline_no_write, docker_domain_server_has_no_host_tools and companion_unavailable_keeps_domain_work_usable.
- [ ] RED UI tests one_primary_action_for_ready_plan, zero_path_json_token_fields, unmanaged_conflict_has_no_delete, writer_unavailable_is_not_connected, new_client_connect_bootstraps_without_token_wizard, claude_desktop_provider_managed and update_preview_retains_custom_filters.
- [ ] Implement WK native adapter and authenticated same-user local IPC framing. Same UID/origin alone never grants mutation; native digest-bound intent is required. No public HTTP listener/home mount/root service. Stub absent companion is a real supported result.
- [ ] Implement safe UI row/inline plan behavior and exact brief remove copy from spec. Preserve legacy browser copy section only under explicit operator/unsupported documentation, not the ordinary connection path.
- [ ] Register host-only MCP facade using same strict manager DTOs; default domain createStickerMcp remains unchanged and does not gain host tools.
- [ ] Run native runner task7; node --import tsx --test tests/native-client-lifecycle-contract.test.ts tests/ui/native-client-connections.test.tsx; expected PASS with same fixture outcomes through UI and MCP adapters. No real native app launch.

## Task8: Protocol verification and actual client truth

**Files:** Create ConnectionVerifier.swift; tests/native/client-lifecycle/VerificationTests.swift; add tests/native-client-lifecycle-protocol.test.ts using existing official SDK and injected native transport.

**Consumes:** Fixed launcher, manager operation phase and DTO projections.

**Produces:**

- verifyOwnedConnection(clientId:ownershipRevision:) async -> VerificationSnapshot.
- ActualClientInspector returns unknown/refresh_required/verified/policy_blocked; no guessed reload requirement.
- Truthful safe protocol evidence with expected/available catalogue digest/count and missing tool names.

- [ ] RED tests initialize_without_tools_is_not_verified, tools_without_safe_read_is_not_verified, direct_probe_success_client_stale_not_connected, wrong_actor_scope_or_filter_blocks_ready, policy_hidden_not_absent and timeout_never_auto_restarts_client.
- [ ] Run focused native and SDK tests; expected FAIL.
- [ ] Implement fixed initialize/tools/list and provisional self-proof before activation; capabilities/project safe read only after activation,15s timeout, one probe per client. No model turn, issue mutation, GitHub call, unrelated MCP-server execution or account login.
- [ ] Actual client inspector initially returns unknown/refresh_required unless an exact supported non-disruptive provider API is independently certified. Raw list/get stdout/config never enters UI or MCP.
- [ ] Native and real SDK fixture process tests pass; record direct protocol evidence separately from actual-client evidence. Missing actual proof must keep connection UI from saying connected.

## Task9: Integrated fixture journey, review and release decision

**Files:** Extend tests/native/client-lifecycle/EndToEndTests.swift and UI/contract tests; update docs/MCP.md and README only with actual shipped state; write test-results/native-client-lifecycle/release-evidence.md.

**Consumes:** Tasks1–8; source coordination and exact candidate from parent.

- [ ] Run fresh fixture journey through UI and host MCP: detect→plan with scoped summary→native decision→native pending secret/hash-only provisional→identity/tools proof→versioned config apply→fresh owner activation→safe domain read→commit. Also known config apply followed separately by expiry/owner loss/cancel/activation refusal, inverse-CAS compensation and next normal Connect; intervening edits and lost activation replies retain truthful recovery. Cover update reuse→remove/exclusive revoke, retry/restart between cleanup receipts, unsupported writer/Claude and companion absent.
- [ ] Run focused native runner, affected node tests, npm run typecheck, npm run lint, npm run build and npm run format:check; full npm test and production/native regressions once integrated. New Swift files must be included in access app compilation fixture; no actual install or client restart.
- [ ] Measure eligible ordinary path: one product action once visible plan ready, zero technical inputs. Record separate native/provider grant clicks and every blocked/unshipped capability; do not count fake-CAS mutation as real client support.
- [ ] Self-review spec coverage and independent review via the parent's established review owner; no subagent dispatch in this documents-only task. Critical areas: native authority, secret references, strict writer certification, foreign-update preservation and truthful verification.
- [ ] Do not call detection/plan/owned-probe a completed lifecycle release. Record any interim incomplete delivery explicitly; complete Codex first-use Connect/Update/Remove only after versioned writer conformance, required scoped provision/activate/revoke bootstrap and selected-client verification. Domain parity may release independently.
- [ ] Real client/Keychain/server-grant changes occur only when the runtime user chooses the exact scoped product action and required native/owner authentication succeeds; implementation approval never performs production activation during development. No stopped probe, unsafe write primitive or generic fallback may be used to pass this gate.

## Coverage and handoff

Spec coverage: profiles/contracts Task1; ownership/pure preservation Task2; supported versioned conformance Task3; transaction/rollback Task4; managed hash registry/provisional enforcement Task5; native private bootstrap/reuse/revoke Task6; shared native intent/UI/MCP Task7; protocol versus actual client truth Task8; integrated acceptance Task9.

The plan is ready for the parent to review and schedule. It authorizes no source or operating action by itself. The next concrete gate is supported Codex current-version expectedVersion/conflict/delete/rollback conformance using already identified official contracts; this is not a permanent architectural blocker. New-client bootstrap is a required implemented stage; missing an old reference triggers that approved runtime path, not a manual-preprovisioning requirement. Missing current owner authority or failed secure storage is a truthful runtime blocker. Claude Desktop automation remains unsupported. Keep those facts visible rather than deliver unsafe apparent success.
