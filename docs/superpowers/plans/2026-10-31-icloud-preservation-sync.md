# iCloud Preservation, Restore and Device Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless separately authorized. This is a future plan, not authorization to implement or perform cloud setup in the documentation task.

**Goal:** Preserve and restore Sticker content through the Mac's system iCloud account, then qualify separate same-account record synchronization.

**Architecture:** Native Foundation/CloudKit adapters own Apple access; a single server product-job service serves HTTP, UI and owner MCP. Immutable scrubbed DB/uploads archives ship first. Durable mutation/outbox, identity mapping, conditional allocation, conflict preservation and tombstones form a separately gated record engine.

**Tech Stack:** Existing Node 24, node:sqlite/crypto/fs, TypeScript, zod, React, Swift Foundation/CloudKit, node:test and installed Playwright; no new dependencies.

**Spec:** [2026-10-31-icloud-preservation-sync-design.md](../specs/2026-10-31-icloud-preservation-sync-design.md). Read both documents before execution. Current table names/signatures must be checked against the preceding GitHub/MCP release before editing.

## Global Constraints

- GitHub App + MCP product parity remains the first release; iCloud is separate.
- Documentation task changes no code/index/operating data/account/config/credentials/signing and makes no cloud calls.
- Ordinary use requires zero custom JSON, filesystem paths, tokens, server addresses, account nicknames or sync-strategy input.
- Only data-target, permission, external-transfer and destructive replacement consent may require user decisions.
- No new dependencies. Node 24; shell macOS 11.3; CKSyncEngine macOS 14.0+ only.
- Stage A/C tests use only synthetic providers, temporary DBs/uploads; real adapters disabled by default.
- Archives exclude credentials, cookies, all sessions, preferences, live outbound jobs and external connection authority.
- No user-email lookup, Contacts/discovery, account-file/Keychain scraping or guessed iCloud paths.
- Native signing/container/capability changes and live synthetic/real transfers require separately scoped approvals.
- No automatic cloud-dataset replacement, workspace merge, tombstone compaction or archive retention deletion in v1.
- No remote owner-authority receipt protocol or new persistent keys: protected imports remain inert until authenticated local owner review of exact content.

## Review Focus

- A late upload/download callback after account change must never mutate the new account/root: Tasks 1, 4, 6, 9 exercise claim/dispatch/ack boundaries.
- DB sanitization by DELETE can retain credentials in pages: Task 2 asserts fresh export and byte-level canaries, including free pages/WAL sidecars.
- A restore drain may finish an accepted write after preview, and a restart/rollback may lose later writes: Task 3 tests post-drain exact consent revalidation, uninterrupted admission fencing and every journal/pointer boundary.
- Allocation retry after unknown server success can silently duplicate or renumber content: Task 7 verifies readback by UUID, canonical claims and stable aliases.
- Remote actor/receipt claims can accidentally activate owner workflows or GitHub hooks: Tasks 7–9 keep protected proposals inert and test exact authenticated local approval, forged/replayed/revoked/epoch-cross evidence and all side effects.

## File and interface map

New server units, all under `server/icloud/`: `contracts.ts` (shared strict types), `jobs.ts` (idempotent job state), `account.ts` (binding epochs), `archive-policy.ts` (explicit export allowlists), `archive.ts` (snapshot/export/validation), `restore.ts` (journal and root switch), `mutations.ts` (transactional hooks), `records.ts` (envelope/inbox/outbox), `merge.ts` (three-way), `authority.ts` (protected proposal gate and local-owner approval), `identities.ts` (keys/version slots), `relations.ts` (graph proposals), `bootstrap.ts` (full inventory/tombstones), `bridge.ts` (claim/ack), `service.ts` (public domain facade). No generic SQL/HTTP/shell gateway.

New adapters: `server/routes/icloud.ts`, `server/mcp/icloud.ts`, `client/features/icloud/{ICloudSettings,BackupList,RestorePreview,ConflictRecovery}.tsx`, `packaging/macos/{CloudAccountProvider,CloudBridge,CloudArchiveTransport,CloudRecordTransport}.swift`. Native abstractions must permit fake providers without linking a live container.

Modify only relevant seams: `server/domain.ts`, `server/store-context.ts`, domain feature services for the supported record inventory, `server/backup-validation.ts`, `server/schema-manifest.ts`, `server/migrations/index.ts`, `server/app.ts`, `server/mcp.ts`, `server/mcp/catalogue.ts`, `server/maintenance.ts`, `server/runtime-shutdown.ts`, `scripts/start.sh`, `scripts/backup.sh`, `scripts/restore.sh`, `server/db.ts` active-root resolution, `client/App.tsx`, native application lifecycle. Choose the next free migration number at implementation (observed latest is 10; do not overwrite another contributor's migration).

Shared types in `contracts.ts`:

```ts
type Scope = {
  bindingId: string;
  datasetId: string;
  generation: string;
  accountEpoch: number;
  restoreEpoch: number;
  activeRootId: string;
};
type JobRef = {
  jobId: string;
  state: JobState;
  progress: JobProgress;
  errorCode: CloudErrorCode | null;
};
type AccountSnapshot = {
  capability: CapabilityState;
  cloudKit: AccountState;
  drive: DriveState;
  displayAccountId: string | null;
  checkedAt: string;
};
type RecordEnvelope = {
  contractVersion: 1;
  generation: string;
  kind: EntityKind;
  entityId: string;
  operationId: string;
  baseTag: string | null;
  base: Content | null;
  content: Content | null;
  digest: string;
  dependencies: string[];
  provenance: Provenance;
};
```

`JobState`, `CapabilityState`, `CloudErrorCode`, request unions and content discriminants are exhaustively defined from the spec, not `string`/`any` escape hatches. `Content` is the allowlisted union for supported entity kinds. `Actor`, database and domain error reuse current types. Wire `Provenance` is only the spec's `unverified_remote` historical metadata; no claimed role/receipt or wire enum grants authority. A locally authenticated approval context is private to one server transaction and cannot be supplied by an importer. Functions below are planned interfaces, not claims they exist.

## Stage A — synthetic archive foundation

### Task 1: Account fences and durable common jobs

**Files:** Create `contracts.ts`, `jobs.ts`, `account.ts`, `service.ts`, next-numbered `*-icloud.ts` migration, `tests/icloud-jobs.test.ts`, `tests/icloud-account.test.ts`; modify migration index/schema manifest.

**Interfaces:** `CloudAccountProvider.status(): Promise<AccountSnapshot>`; private native identity token remains provider-owned. `CloudService.submit(actor: Actor, request: CloudRequest, operationId: string): JobRef`; `getJob(actor, jobId): JobRef`; `observeAccount(next: PrivateIdentity): Scope`; `assertCurrent(scope: Scope): void`. `PrivateIdentity` is server/native internal and absent from public serialization.

- [ ] Add failing tests `job_replay_is_exact`, `same_id_new_payload_conflicts`, `scoped_agent_cannot_read_owner_account`, `available_is_not_synced`, `account_switch_fences_old_claim`, `uncertain_identity_stops_dispatch`. Assert two submits produce one row; changed payload gives 409; all five provider status values remain distinct; missing entitlements returns NOT_CONFIGURED.
- [ ] Run `node --import tsx --test tests/icloud-jobs.test.ts tests/icloud-account.test.ts`; expect assertion/import failure before implementation.
- [ ] Implement strict schemas, additive migration and job/account service with injected clock, provider, UUID source and fixture-only transport. Persist binding/dataset and both epochs; defaults cannot call Apple. Unknown migration content fails closed. Include `cloud_history_events` for immutable remote history and required tables from spec.
- [ ] Re-run focused tests; expect pass. Run `npm run typecheck`; expect zero type errors. Verify no raw identity appears in serialized errors/status fixtures.
- [ ] Review and commit only this task's files after authorized implementation. Do not stage unrelated work.

### Task 2: Consistent fresh content archive

**Files:** Create `archive-policy.ts`, `archive.ts`, `tests/icloud-archive.test.ts`, `tests/fixtures/icloud/archive-fixtures.ts`; modify `server/backup-validation.ts`, maintenance/shutdown only for tracked export lifecycle.

**Interfaces:** `captureContentSnapshot(ctx: SnapshotContext): Promise<VerifiedSnapshot>`; `exportContentDatabase(source: ClosedDataRoot, target: EmptyStage, policy: ExportPolicy): ExportInventory`; `verifySnapshot(stage: SnapshotStage): VerifiedSnapshot`. `VerifiedSnapshot` contains immutable snapshot ID, private stage handle, manifest hash, counts/bytes, never a product host path. Context injects lock, drain, stop/start, file operations, capacity and clock. Its internal lifecycle union is `standalone` or `already_fenced_no_resume` with a live `RestoreFence` handle; the latter may never reopen admission/restart service. It is not a UI/MCP argument.

- [ ] Add failing `fresh_export_removes_freelist_canaries`, `session_and_outbound_tables_empty`, `unclassified_column_refused`, `upload_commits_before_snapshot`, `drain_timeout_leaves_service_running`, `archive_limit_failures_preserve_source`. Seed canary secrets then DELETE them, retain test WAL; raw archive bytes must contain none. Include every exclusion table, nested uploads and a legitimate attachment containing secret-like prose that must remain.
- [ ] Run `node --import tsx --test tests/icloud-archive.test.ts`; expect failures before implementation.
- [ ] Implement fresh shipped-schema DB projection with exact table/column allowlists, empty excluded tables, inert conflict recovery resources, referenced-file inventory/checksums, 30-second drain and original-state restart. Reject unknown content, links/nonregular members and >1 GiB/50,000 files/1 MiB manifest; require two archive copies +64 MiB reserve. Never alter source rows or export live WAL.
- [ ] Add corruption/traversal/missing file/hash mismatch/newer schema/ENOSPC fixtures; run focused tests and existing `tests/backup-validation.test.ts`. Expect source hashes unchanged and validator success only for complete inventories.
- [ ] Review/commit scoped files. This task is an offline capability; no iCloud success text.

### Task 3: Whole-root restore with restart-safe fences

**Files:** Create `restore.ts`, `tests/icloud-restore.test.ts`; modify `scripts/start.sh`, `scripts/restore.sh`, `server/db.ts` root-resolution seam, `runtime-shutdown.ts`, `backup-validation.ts`. Do not change active installation layout during tests.

**Interfaces:** `previewRestore(actor: Actor, snapshotId: string): Promise<RestorePreview>`; `applyRestore(actor: Actor, previewId: string, operationId: string): Promise<JobRef>`; `recoverRestore(rootStore: RootStore): RecoveryResult`. Preview includes digest/mutation-sequence/scope/exclusions; `RootStore` implements same-filesystem journal+atomic pointer and fsync. `acquireRestoreFence(): Promise<RestoreFence>` closes all mutation admission and drains admitted work; `validatePreviewUnderFence(preview, fence): ValidatedRestoreBoundary` compares digest, exact mutation sequence, root, binding/generation and both epochs after drain. `RestoreFence` remains held through capture/staging/switch/startup validation, with an explicit reopen only after safe completion.

- [ ] Add failing `stale_preview_after_content_change`, `account_switch_rejects_preview`, `crash_before_pointer_keeps_old_root`, `crash_after_pointer_uses_new_root`, `restored_jobs_never_publish`, `multipart_commit_during_drain_invalidates_preview`, `safety_snapshot_never_reopens_admission`, `account_change_before_pointer_aborts`, `pre_switch_failure_preserves_last_accepted_write`, `post_switch_accepted_write_forbids_rollback`. Hold an admitted multipart/content write across apply, complete it during drain and assert old preview fails with no pointer/cloud publication and the write retained. Assert DB and uploads always share a root; restore increments epoch/generation and all sessions/bindings/outboxes are empty/disabled.
- [ ] Run `node --import tsx --test tests/icloud-restore.test.ts`; expect failure.
- [ ] Implement acquire/close-admission → drain → exact preview revalidation → stop/close → safety snapshot in `already_fenced_no_resume` mode → stage/verify → final account/epoch/root recheck → journal/pointer switch → startup validation, all under one uninterrupted fence. Only then mark journal completion/reopen admission. Pre-switch failures leave old root untouched and restore its prior running state after validation; uncertain recovery stays fenced. After switch finish the new root; rollback only before any admission reopening with durable proof of zero accepted new-root writes. Otherwise preserve the new root as authoritative and never discard accepted writes. Bind consent to exact preview, invalidate installation-bound state and report local-only restored state. Do not offer replace-cloud/merge controls.
- [ ] Fault-inject before/after every journal write/fsync/rename/switch/restart; run focused tests plus `tests/backup-validation.test.ts`. Every outcome must select a complete old/new root and preserve the safety snapshot and all accepted writes; source credential volume untouched. Inject a write after new-root admission reopens, then startup failure: automatic rollback must be refused and new-root content retained. Test missing/ambiguous admission evidence also refuses rollback.
- [ ] Review/commit scoped files. Root-indirection migration is exercised in temporary fixture roots only.

### Task 4: Native provider boundary and fake archive transport

**Files:** Create native provider/bridge/archive units, `server/icloud/bridge.ts`, `tests/icloud-bridge.test.ts`, `tests/native/icloud-providers.swift`, `tests/native/icloud-providers.test.mjs`.

**Interfaces:** Swift `CloudAccountProviding`, `ArchiveTransporting` protocols mirror status and `publish(snapshot:scope:)`, `download(snapshotID:scope:)`, `observe(snapshotID:)`; TS `claim(scope, attemptId): BridgeClaim`, `renew(claim): void`, `ack(claim, result): JobRef`. Swift names/types are defined in one shared native contract unit; strict wire decoding mirrors server schemas.

- [ ] Add failing tests `stale_ack_is_ignored`, `lease_expiry_requires_readback`, `placeholder_not_ready`, `partial_package_not_listed`, `quota_preserves_local_archive`, `drive_status_independent_of_cloudkit`, `bridge_unavailable_durable_job`. Assert 30-second leases/10-second renewal and bounded active jobs.
- [ ] Run `node --import tsx --test tests/icloud-bridge.test.ts` and `node --test tests/native/icloud-providers.test.mjs`; expect missing-adapter failures.
- [ ] Implement pure native provider abstraction and fixture transport first; native official API adapter source remains opt-in/disabled pending separately approved signing. Private loopback capability bootstrap is automatic launcher behavior, not product text input. Native durable journal owns stopped-server progress; no arbitrary bridge commands.
- [ ] Run same tests; expect pass using fake providers only. Native wrapper compiles with shell macOS11.3 target and availability checks; tests never instantiate an actual configured CKContainer or resolve a real ubiquity container.
- [ ] Review/commit scoped files. Do not modify entitlements, signing/team configuration, installer configuration or installed app as part of this task.

### Task 5: Shared UI/HTTP/MCP backup and restore flows

**Files:** Create `server/routes/icloud.ts`, `server/mcp/icloud.ts`, four client components; modify route/tool/catalogue/app mounting; create `tests/icloud-http.test.ts`, `tests/icloud-mcp.test.ts`, `tests/ui/icloud.test.tsx`, `tests/ui/icloud.spec.ts` with its isolated fixture server/config if needed.

**Interfaces:** Routes/tools call `CloudService` from Tasks 1–4. `sticker_icloud_account_refresh`, `sticker_icloud_backup_create/list`, `sticker_icloud_restore_preview/apply`, `sticker_icloud_job_get/cancel` use strict typed handles, standard owner authentication and identical job/error contracts.

- [ ] Add failing `owner_mcp_backup_restore_without_browser`, `ui_and_mcp_replay_one_job`, `agent_scope_no_owner_fallback`, `no_technical_setup_inputs`, `account_copy_does_not_claim_email_or_sync`. Assert DOM has no nickname/JSON/path/token/server/strategy field and active production fake state cannot display success.
- [ ] Run `node --import tsx --test tests/icloud-http.test.ts tests/icloud-mcp.test.ts tests/ui/icloud.test.tsx`; expect failure.
- [ ] Implement one settings account row, one preservation action, a snapshot list and concrete restore preview. Use exact Korean copy in spec. Unconfigured native bridge explains unavailable capability inline. OS action can be reported through MCP without browser-dependent app work.
- [ ] Run focused suites and isolated Playwright iCloud fixture. Record actual product clicks, system clicks, text inputs and manual config count; custom technical input count must be zero. One backup action after initial data-scope consent; restore has target selection and one replacement confirmation.
- [ ] Review/commit scoped files. Stage A is complete only as synthetic/local implementation. Do not claim Stage B live iCloud readiness.

## Stage B — separately approved native archive qualification

### Task 6: Signed native account and archive qualification gate

**Files:** Native account/bridge/archive adapters and fixture integration tests from Task4; future `tests/native/icloud-live-checklist.md`, verification report. Signing configuration paths are selected only after concrete approved identity/profile scope.

**Interfaces:** Same provider/transport protocols as Task4; no UI/API contract change. Framework adapter calls only official status/identity/container/coordinated-file/metadata APIs described in the source-backed feasibility report.

- [ ] Before any account/signing action, prepare exact bundle/container/capability/profile/distribution proposal and obtain separately required approval; read-only project planning is allowed. No real user data is used to test capability.
- [ ] Implement/compile official adapters in a disabled configuration; test provider error mapping, off-main-thread work and account observation with injected APIs. No live cloud call at this step.
- [ ] Only after scoped authorization, configure a development build and inspect resulting signature/entitlements. Obtain separate approval for named synthetic content transfer on authorized Mac(s); verify actual upload observation, download, hash equality and restore.
- [ ] Test real sign-out/account-change and bridge restart within explicitly authorized scope; log timings/state/uncertain outcomes without identifiers/credentials. Do not infer a guaranteed network account binding from a successful preflight.
- [ ] Release Stage B only if synthetic and live evidence pass; otherwise keep the adapter disabled with the specific capability error. No production schema deployment/real-content transfer without separate scope approval.

## Stage C — synthetic record engine, separately gated

### Task 7: Transactional record mutation and exact identity allocation

**Files:** Create `mutations.ts`, `records.ts`, `identities.ts`, `authority.ts`, `tests/icloud-outbox.test.ts`, `tests/icloud-identities.test.ts`, `tests/fixtures/icloud/record-harness.ts`; modify store/domain and supported content feature mutation seams only, migration/schema manifest as needed.

**Interfaces:** `enqueueLocalMutation(ctx: TransactionContext, change: ContentMutation, scope: Scope): void` (requires open transaction); `applyRemoteBatch(ctx, envelopes: RecordEnvelope[], scope): ApplyResult`; `allocateIdentity(proposal: IdentityProposal, transport: ConditionalRecordTransport): Promise<CanonicalIdentity>`; `resolveVersionSlot(ctx, versionUUID: string): number`; `classifyImportAuthority(change: ContentMutation, current: Content | null): "ordinary" | "protected_proposal"`. Classification reuses local owner-required predicates; unknown/compound authority defaults to protected. Import context is an allowlisted content capability with no fabricated owner actor. Fake `ConditionalRecordTransport.commit(expectedTags, records): Promise<CommitResult>` supplies atomic same-zone CAS and partial/unknown-result scenarios; native equivalent is later Task10.

- [ ] Add failing tests `outbox_failure_rolls_back_content`, `remote_apply_does_not_enqueue_github`, `ordinary_content_imports_without_owner_grant`, `protected_remote_action_is_inert_proposal`, `bootstrap_protected_content_requires_exact_owner_preview`, `two_APP_projects_get_stable_keys`, `forced_key_candidate_collision_probes`, `two_APP7_issues_keep_UUID_links`, `lost_allocator_reply_no_second_number`, `two_resource_v2_preserve_bytes_and_pins`, `two_template_versions_keep_provenance`, `ambiguous_alias_refuses_lookup`.
- [ ] Run `node --import tsx --test tests/icloud-outbox.test.ts tests/icloud-identities.test.ts`; expect failure before hooks/allocator.
- [ ] Implement envelope/outbox/inbox/system-field storage, mutation hooks for every included content table and complete delete cascades. Use exact project key candidate formula and canonical counter CAS from spec. Version UUIDs map to local integer slots; pinned wire references never use local integers. Hold dependencies/assets until ready. Remote apply bypasses external publish hooks, not permissions/invariants. Persist protected transitions/dependent effects as read-only proposals before any application; remote roles/audit rows/receipts are untrusted history. Initial staged-root activation binds local owner approval to exact content digest and protected-state summary, granting no future authority.
- [ ] Run two/three temporary SQLite replicas with duplicate/lost/out-of-order deliveries and injected counter candidate collisions. Assert accepted canonical keys match, no missing immutable version, stable issue UUID and no duplicate allocation after readback. Current local revision/history constraints still pass.
- [ ] Review/commit scoped files. No production sync toggle until Tasks8–10 and full inventory coverage pass.

### Task 8: Three-way conflicts, constrained relations and immutable history

**Files:** Create `merge.ts`, `relations.ts`; modify `authority.ts`; create `tests/icloud-merge.test.ts`, `tests/icloud-relations.test.ts`, `tests/icloud-history.test.ts`; use migration table for remote immutable history, `ConflictRecovery.tsx` and service conflict endpoint.

**Interfaces:** `mergeContent(base: Content, local: Content, remote: Content): MergeResult`; `validateGraphProposal(graph: ProjectGraph, proposal: GraphMutation): GraphResult`; `saveConflict(actor: Actor, conflictId: string, revision: number, content: Content, operationId: string): JobRef`; `approveProtectedProposal(actor: Actor, proposalId: string, proposalRevision: number, expectedLocalRevision: number, operationId: string): JobRef`. Approval checks the actual current owner, exact stored proposal digest/action, target revisions, binding/generation and both epochs in the same domain transaction; context is transaction-local, never wire-serializable. `saveConflict` must route protected changes through this same gate. MergeResult is accepted content or durable B/L/R conflict, never arbitrary strategy enum.

- [ ] Add failing `nonoverlap_merges`, `same_field_keeps_three_versions`, `delete_edit_preserves_alternate`, `concurrent_two_parents_hold_one_proposal`, `concurrent_cycle_not_installed`, `symmetric_related_coalesces`, `history_revision5_events_both_survive`, `incoming_owner_string_not_authority`, `source_owner_proposal_requires_local_approval`, `authenticated_local_approval_applies_once`, `agent_protected_proposal_stays_inert`, `forged_or_edited_owner_receipt_stays_inert`, `replayed_receipt_before_after_approval_has_no_effect`, `revoked_device_claim_stays_inert`, `cross_account_generation_restore_epoch_receipt_stays_inert`, `expired_owner_session_cannot_approve`, `changed_proposal_digest_requires_new_review`. All receipt-looking inputs remain unsupported untrusted evidence, including fixture claims of previously trusted/revoked devices; add no real key enrollment or verifier. Assert text/labels are whole fields, timestamps cannot break ties, conflicts survive restart and backup projection.
- [ ] Run `node --import tsx --test tests/icloud-merge.test.ts tests/icloud-relations.test.ts tests/icloud-history.test.ts`; expect failure.
- [ ] Implement exact B/L/R rules, canonical visible server projection with retained alternative recovery, conditional project graph head and dependency staging. Enforce same-project/self/one-parent/cycle constraints and 1,000-edge/256KiB caps. Store remote historical events with UUID/source revision, allocate local change revisions on application. Version-name collision retains proposal/dependents until safe retained-copy allocation. Implement read-only protected proposal display and explicit current-local-owner content approval through normal domain actions/confirmations. Maintain both alternatives, no receipt-based trust or owner fallback; no session/workflow/GitHub side effects. Protected visible fields remain at locally authorized state, not blindly at cloud server state. A genuine owner action from another device still awaits this local approval.
- [ ] Re-run suites in both delivery orders and all three replicas. Require active graph validity, identical accepted canonical graph, retained conflict contents, no unauthorized close/release/guidance and no external GitHub queue changes. Conflict editor offers content editing and meaningful protected-action review, not technical conflict/trust strategy choices. Valid positive fixture: source owner closes an issue; remote ingest stays pending; current receiving owner reviews exact diff and approves once; receiver closes through the normal domain rule with exactly one local audit record and no outbound workflow/GitHub job. Exact replay cannot repeat it; permission/epoch/revision changes invalidate approval.
- [ ] Review/commit scoped files. Unresolved conflicts must remain visible and stop `up to date` status.

### Task 9: Tombstone bootstrap, asset recovery and account/restore rejection

**Files:** Create `bootstrap.ts`, `tests/icloud-bootstrap.test.ts`, `tests/icloud-assets.test.ts`, `tests/icloud-epochs.test.ts`; extend synthetic harness.

**Interfaces:** `reconcileInventory(scope: Scope, inventory: RemoteInventory): ReconcileResult`; `stageAsset(scope, asset: AssetDescriptor): Promise<VerifiedAsset>`; `assertDispatchFence(scope, providerIdentity): void`. Inventory distinguishes explicit tombstones, missing records, missing zone and generation mismatch.

- [ ] Add failing `stale_add_cannot_resurrect`, `late_child_of_deleted_parent_is_conflict`, `expired_token_keeps_unsent`, `missing_zone_does_not_recreate`, `unknown_missing_is_not_delete`, `asset_hash_fail_not_visible`, `A_to_B_at_every_phase`, `old_restore_callback_rejected`, `quota_backoff_stops`, `restore_never_replays_outbox`, `claimed_receipt_epoch_cross_remains_history`. Assert every unverified protected receipt stays inert even when transport integrity and same-account checks pass.
- [ ] Run `node --import tsx --test tests/icloud-bootstrap.test.ts tests/icloud-assets.test.ts tests/icloud-epochs.test.ts`; expect failure.
- [ ] Implement tombstones with cascade fences/no GC, full inventory replay with provenance and per-binding checkpoint, frozen assets and bounded staging, per-item acknowledgements/readback, retry-after/backoff and quota pause. Enforce active-root and both epoch fences at claim/dispatch/ack/import; persist uncertain outcomes rather than guessing failure. A transport acknowledgement of stored protected history is not proof that its proposed protected state was applied; report `review_pending` and retain both versions.
- [ ] Run all `tests/icloud-*.test.ts` using the shell's file expansion and the relevant UI tests. Compare rows/files across replicas; expected outcome is converged content or explicit durable conflict with no missing branch, and no cross-binding local application. Time travel fixtures must not affect merge decisions.
- [ ] Review/commit scoped files. Keep synthetic record adapter isolated from deployed configuration.

## Stage D — separately approved device-sync qualification

### Task 10: Native record adapter and release evidence

**Files:** Create `packaging/macos/CloudRecordTransport.swift`; extend native provider tests and fixture integration, `server/mcp/icloud.ts` and UI device-sync controls; add verification results to a new scoped report.

**Interfaces:** Implement `ConditionalRecordTransport` and record fetch/send/asset protocols with CKSyncEngine state callbacks plus explicit conditional atomic same-zone allocator/graph writes. `CKRecord` system fields/tokens remain private. Foreground explicit sync supports status/progress; background while app quit remains unsupported.

- [ ] Add failing native mocked tests for saved engine-state restart, per-record failures, unknown allocator result, remote notification hint, unsupported macOS branch and provider account change. Compile/test with no live container.
- [ ] Implement macOS14 availability-gated official adapter, 100-operation internal batch maximum reduced if provider requires, persisted engine state and foreground catch-up. Expand capability catalogue/UI/MCP only for supported actions, matching shared service behavior. Preserve macOS11.3 shell fallback.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, `npm run test:production`, relevant native/iCloud browser suites and existing container verification only against disposable fixture project/volumes. Fix regressions; do not rerun unaffected broad suites without a reason.
- [ ] Obtain separately scoped native setup/live synthetic approval as in Task6; run two macOS14+ devices against development container. Exercise same-time edits/creation, collisions, lost-network retry, assets, sign-out, deleted zone, restore fencing and foreground catch-up. Record evidence; fake tests alone do not qualify production.
- [ ] Prepare exact production schema/signing and user-content transfer scope for separate approval. Publish only supported limits/account truth/sync timestamps and measured usability counts. If any gate fails, keep device sync disabled and ship/retain the qualified archive release independently.

## Completion evidence and bounded handoff

The implementation reports stage-by-stage evidence, changed file list, commands/results, synthetic versus live scope, remaining limitations and actual approvals received. Do not mark this whole plan complete when only StageA succeeds. No commit/deploy/cloud activation in the current documentation task. Automatic protected owner-state convergence is unshipped: each receiving device keeps those changes pending local owner review. No additional operator setup or persistent credential is needed for this safe default. Any later signed-device receipt protocol requires a separate design covering key generation/storage, independent enrollment trust root, proof of possession, scope-bound receipts, replay storage, authenticated revocation/freshness, rotation and epoch reset, plus explicit persistent-credential approval; no such setup is included here. The parent can register these stages as GitHub/Sticker follow-up work separately; this document does not claim those registrations happened.

Self-review coverage: account/product simplicity→1/4/5/6; archive exclusions/consistency→2; restore root/epochs→3; jobs/parity→1/5; schema identity/counters/version pins→7; conflicts/history/relations→8; outbox/tombstones/assets/retries/account changes→7/9; native/platform/signing/live proof→6/10. Every review-focus failure has an explicit fixture. External prerequisites are restricted to authorized developer identity/capabilities, properly signed app(s), intended existing system account and separately scoped live transfer; no custom end-user configuration is proposed.
