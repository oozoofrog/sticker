import Foundation

// Trusted native composition only; never decoded from a UI/MCP payload.
struct TrustedRequestContext {
    let requesterId:String
    let identity:VerifiedClientIdentity
    let connectionId:String
    let currentProjectId:String?
    let verifiedPeer:Bool
}
enum NativeIntentSource { case nativeUserGesture }
actor NativeDecisionStore {
    private struct Decision { let digest:String,requester:String,installation:String;let expiry:Date }
    private var decisions:[String:Decision]=[:]
    func record(_ plan:ConnectionPlan,requesterId:String,installationId:String,now:Date,source:NativeIntentSource) throws {
        try WireShape.identifier(requesterId);try WireShape.identifier(installationId)
        guard let expiry=LifecycleTime.date(plan.expiresAt),expiry>now else { throw LifecycleFailure.planExpired }
        decisions=decisions.filter { $0.value.expiry>now }
        guard decisions.count<32 else { throw LifecycleFailure.planCapacity }
        decisions[plan.planId]=Decision(digest:plan.digest,requester:requesterId,installation:installationId,expiry:expiry)
    }
    func consume(_ plan:ConnectionPlan,context:TrustedRequestContext,now:Date) throws {
        guard let decision=decisions[plan.planId],decision.digest==plan.digest,decision.requester==context.requesterId,
              decision.installation==context.identity.installationId,decision.expiry>now else { throw LifecycleFailure.permissionRequired }
        decisions.removeValue(forKey:plan.planId)
    }
    func cancel(_ planId:String) { decisions.removeValue(forKey:planId) }
}
protocol LifecycleClock: Sendable { func now() async -> Date }
protocol LifecycleOwnerAuthority: Actor { func isCurrent(_ context:TrustedRequestContext,digest:String) async -> Bool }
struct TransactionWriterLease {
    let writer:any VersionedWriter
    let supportsDelete:Bool
}
protocol LifecycleWriterProvider: Sendable { func lease(for identity:VerifiedClientIdentity) async -> TransactionWriterLease? }
struct UnavailableLifecycleWriterProvider: LifecycleWriterProvider {
    func lease(for identity:VerifiedClientIdentity) async -> TransactionWriterLease? {
        // Registry is currently nil for every real runtime. Never bypass it.
        guard let certified=WriterRegistry().writer(for:identity) else { return nil }
        return TransactionWriterLease(writer:certified.writer,supportsDelete:false)
    }
}
struct LifecycleCredential: Codable, Equatable {
    let referenceId:String
    let connectionId:String
    let rights:GrantSummary
    let ownership:GrantOwnership
    let grantId:String?
    let grantRevision:Int?
    let createdByOperation:String?
    let expiresAt:Date?
    func validate() throws {
        try WireShape.identifier(referenceId);try WireShape.identifier(connectionId)
        if let id=grantId { try WireShape.identifier(id) }
        if let id=createdByOperation { try WireShape.identifier(id) }
        try LifecycleWire.validateRights(["projectIds":rights.projectIds,"canWrite":rights.canWrite])
        if ownership != .preexistingShared { guard grantId != nil,grantRevision != nil else { throw LifecycleFailure.invalidStorage } }
    }
}
// Refused is definitive: no operation-owned grant/secret remains. Partial or
// uncertain provisioning must remain recoverable by operationId, never refused.
enum CredentialProvision { case ready(LifecycleCredential), refused, unknown }
enum CredentialActivation { case active, provisional, refused, unknown }
enum CredentialTerminal { case revoked, expired, pending, unknown }
protocol LifecycleCredentialBootstrap: Actor {
    func provision(operationId:String,connectionId:String,rights:GrantSummary) async -> CredentialProvision
    func recoverProvision(operationId:String) async -> CredentialProvision
    func activate(_ credential:LifecycleCredential,operationId:String) async -> CredentialActivation
    func queryActivation(_ credential:LifecycleCredential,operationId:String) async -> CredentialActivation
    func revoke(_ credential:LifecycleCredential,operationId:String) async -> CredentialTerminal
    func queryTerminal(_ credential:LifecycleCredential,operationId:String) async -> CredentialTerminal
    func disposeOwnedSecret(_ credential:LifecycleCredential,operationId:String) async -> Bool
}
struct LifecycleVerification: Codable, Equatable {
    let protocolCheck:ProtocolCheck
    let actualClient:ClientLoad
    let identityMatches:Bool
    let rights:GrantSummary
    let expectedToolCount:Int,availableToolCount:Int
    let missingToolNames:[String]
    func satisfies(_ expected:GrantSummary) -> Bool {
        expectedToolCount>=0 && expectedToolCount<=512 && availableToolCount>=0 && availableToolCount<=512 && identityMatches && rights==expected && protocolCheck == .toolsVerified && actualClient != .policyBlocked && missingToolNames.isEmpty && availableToolCount>=expectedToolCount
    }
    func object(client:ClientId,now:Date) -> [String:Any] {
        ["kind":"verification","clientId":client.rawValue,"config":"saved","protocol":protocolCheck.rawValue,
         "actualClient":actualClient.rawValue,"expectedToolCount":expectedToolCount,"availableToolCount":availableToolCount,
         "missingToolNames":missingToolNames,"checkedAt":LifecycleTime.stamp(now),
         "actor":["role":"agent","canWrite":rights.canWrite,"projectIds":rights.projectIds]]
    }
}
protocol LifecycleVerificationProvider: Actor {
    // Bounded self-proof/initialize/tools only; no provisional domain reads.
    func provisionalProof(_ credential:LifecycleCredential,rights:GrantSummary) async -> Bool
    func verify(_ credential:LifecycleCredential,rights:GrantSummary) async -> LifecycleVerification
}
enum TransactionCheckpoint: String { case backup, prepared, providerReturned, providerReceipt, manifest, activationReturned, verification, compensatedConfig, compensatedGrant, compensatedSecret, inverseReturned, revocationReturned, secretDisposed }
enum TransactionInterruption: Error { case simulatedCrash }
protocol LifecycleTransactionHooks: Actor { func reach(_ checkpoint:TransactionCheckpoint,operationId:String) async throws }
actor NoLifecycleTransactionHooks: LifecycleTransactionHooks { func reach(_ checkpoint:TransactionCheckpoint,operationId:String) async throws {} }

actor NativeConnectionManager {
    private let store:OwnedLifecycleJournal
    private let writers:any LifecycleWriterProvider
    private let clock:any LifecycleClock
    private let owner:any LifecycleOwnerAuthority
    private let credentials:any LifecycleCredentialBootstrap
    private let verifier:any LifecycleVerificationProvider
    private let decisions:NativeDecisionStore
    private let hooks:any LifecycleTransactionHooks
    private let discovery:any MetadataDiscovery
    private let launcherVersion:String
    private let planner=ConnectionPlanner()
    private struct CachedPlan { let plan:PrivateConnectionPlan;let requester:String,installation:String;var recoveryOf:String?=nil }
    private var plans:[String:CachedPlan]=[:]
    private struct RunningOperation {
        let planId:String,digest:String,requester:String,installation:String,connection:String
        let task:Task<OperationSnapshot,Error>
    }
    private var inFlight:[String:RunningOperation]=[:]
    private var reservingPlans=Set<String>()
    init(store:OwnedLifecycleJournal,writers:any LifecycleWriterProvider,clock:any LifecycleClock,owner:any LifecycleOwnerAuthority,
         credentials:any LifecycleCredentialBootstrap,verifier:any LifecycleVerificationProvider,decisions:NativeDecisionStore,
         hooks:any LifecycleTransactionHooks,discovery:any MetadataDiscovery,launcherVersion:String) {
        self.store=store;self.writers=writers;self.clock=clock;self.owner=owner;self.credentials=credentials;self.verifier=verifier
        self.decisions=decisions;self.hooks=hooks;self.discovery=discovery;self.launcherVersion=launcherVersion
    }
    func retainedPlanCount() -> Int { plans.count }
    private func prunePlans(now:Date) {
        for (id,cached) in plans where (LifecycleTime.date(cached.plan.publicPlan.expiresAt) ?? .distantPast)<=now {
            plans.removeValue(forKey:id);planner.cancel(planId:id)
        }
    }
    private func trusted(_ context:TrustedRequestContext) throws {
        guard context.verifiedPeer,context.identity.clientId == .codexLocal else { throw LifecycleFailure.permissionRequired }
        try WireShape.identifier(context.requesterId);try WireShape.identifier(context.identity.installationId);try WireShape.identifier(context.connectionId)
    }
    private func lease(_ context:TrustedRequestContext,action:ConnectionAction) async throws -> TransactionWriterLease {
        try trusted(context)
        guard let lease=await writers.lease(for:context.identity),action == .update || lease.supportsDelete else { throw LifecycleFailure.writerUnavailable }
        return lease
    }
    func planChange(action:ConnectionAction,expectedOwnershipRevision:Int,context:TrustedRequestContext) async throws -> ConnectionPlan {
        let lease=try await lease(context,action:action)
        let snapshot=try await lease.writer.readOwnedTarget(profileId:context.identity.clientId,connectionId:context.connectionId)
        let owned=try await store.ownership(connectionId:context.connectionId)
        let intent=ChangeIntent(action:action,clientId:context.identity.clientId,installationId:context.identity.installationId,connectionId:context.connectionId,
                                currentProjectId:context.currentProjectId,expectedOwnershipRevision:expectedOwnershipRevision,desiredLauncherVersion:launcherVersion,
                                credentialReferenceId:owned?.credentialReferenceId,visibility:.preserve)
        let now=await clock.now();prunePlans(now:now)
        let plan=try planner.plan(snapshot:snapshot,ownership:owned,intent:intent,now:now)
        plans[plan.publicPlan.planId]=CachedPlan(plan:plan,requester:context.requesterId,installation:context.identity.installationId)
        return plan.publicPlan
    }
    func applyChange(planId:String,digest:String,operationId:String,context:TrustedRequestContext) async throws -> OperationSnapshot {
        try trusted(context);try WireShape.identifier(operationId);try WireShape.hash(digest)
        if let running=inFlight[operationId] {
            guard running.planId==planId,running.digest==digest,running.requester==context.requesterId,
                  running.installation==context.identity.installationId,running.connection==context.connectionId else { throw LifecycleFailure.operationConflict }
            return try await running.task.value
        }
        // Reserve the local join BEFORE the first suspension/admission/consent read.
        let task=Task { try await self.admitAndExecute(planId:planId,digest:digest,operationId:operationId,context:context) }
        inFlight[operationId]=RunningOperation(planId:planId,digest:digest,requester:context.requesterId,installation:context.identity.installationId,connection:context.connectionId,task:task)
        defer { inFlight.removeValue(forKey:operationId) }
        return try await task.value
    }
    private func admitAndExecute(planId:String,digest:String,operationId:String,context:TrustedRequestContext) async throws -> OperationSnapshot {
        try trusted(context);try WireShape.identifier(operationId);try WireShape.hash(digest)
        let existing=await store.record(operationId)
        let action:ConnectionAction
        if let record=existing {
            guard matches(record,planId:planId,digest:digest,context:context) else { throw LifecycleFailure.operationConflict }
            action=record.plan.publicPlan.action
        } else {
            guard let cached=plans[planId],cached.requester==context.requesterId,cached.installation==context.identity.installationId else { throw LifecycleFailure.operationConflict }
            action=cached.plan.publicPlan.action
        }
        // All real profiles fail here before a store mutation/bootstrap side effect.
        let lease=try await lease(context,action:action)
        if let record=existing,record.finished { return record.snapshot(now:await clock.now()) }
        if existing==nil {
            guard let cached=plans[planId],cached.requester==context.requesterId,cached.installation==context.identity.installationId,cached.plan.publicPlan.digest==digest else { throw LifecycleFailure.operationConflict }
            let now=await clock.now();try planner.validate(cached.plan,digest:digest,now:now)
            guard await owner.isCurrent(context,digest:digest) else { throw LifecycleFailure.permissionRequired }
            let snapshot=try await lease.writer.readOwnedTarget(profileId:context.identity.clientId,connectionId:context.connectionId)
            let ownership=try await store.ownership(connectionId:context.connectionId)
            guard snapshot.providerVersion==cached.plan.privateProviderVersion,snapshot.ownedEntry==cached.plan.inverseOwnedPatch.entry,
                  (ownership?.ownershipRevision ?? 0)==cached.plan.publicPlan.expectedOwnershipRevision else { throw LifecycleFailure.ownedConflict }
            let admittedAt=await clock.now()
            try planner.validate(cached.plan,digest:digest,now:admittedAt)
            guard await owner.isCurrent(context,digest:digest) else { throw LifecycleFailure.permissionRequired }
            try await decisions.consume(cached.plan.publicPlan,context:context,now:admittedAt)
            // Consent/clock ports suspend too. A removed preview cannot admit.
            let reservationTime=await clock.now()
            guard plans[planId]?.plan==cached.plan else { throw LifecycleFailure.operationConflict }
            try planner.validate(cached.plan,digest:digest,now:reservationTime)
            var record=LifecycleJournalRecord(operationId:operationId,requesterId:context.requesterId,installationId:context.identity.installationId,
                                              connectionId:context.connectionId,plan:AdmittedConnectionPlan(cached.plan),originalOwnership:ownership,createdAt:now)
            record.recoveryOf=cached.recoveryOf
            if let origin=cached.recoveryOf,let running=inFlight[origin] { _ = running;throw LifecycleFailure.operationConflict }
            reservingPlans.insert(planId);defer { reservingPlans.remove(planId) }
            _ = try await store.reserve(record,backup:cached.plan.originalConfigBytes)
            // Cancel/prune may run while the private journal reservation awaits.
            // Preserve that fence before any bootstrap/provider effect.
            if plans[planId]?.plan != cached.plan {
                try await store.requestCancellation(operationId:operationId,requesterId:context.requesterId,installationId:context.identity.installationId)
            }
            plans.removeValue(forKey:planId);planner.cancel(planId:planId)
        }
        return try await execute(operationId:operationId,context:context,lease:lease)
    }
    private func matches(_ record:LifecycleJournalRecord,planId:String,digest:String,context:TrustedRequestContext) -> Bool {
        record.plan.publicPlan.planId==planId && record.plan.publicPlan.digest==digest && record.requesterId==context.requesterId &&
        record.installationId==context.identity.installationId && record.connectionId==context.connectionId && record.plan.publicPlan.clientId==context.identity.clientId
    }
    private func allowed(_ record:LifecycleJournalRecord,context:TrustedRequestContext) async -> Bool {
        guard await owner.isCurrent(context,digest:record.plan.publicPlan.digest) else { return false }
        let now=await clock.now()
        guard let expiry=LifecycleTime.date(record.plan.publicPlan.expiresAt),expiry>now else { return false }
        if let ttl=record.credential?.expiresAt,ttl<=now,record.activation != .active { return false }
        // Fresh durable-ledger read is the admission point for each new effect.
        // A later fence cannot undo already dispatched work; cleanup stays separate.
        guard await store.cancellationState(record.cancellationBinding) == .absent else { return false }
        guard let current=await store.record(record.operationId),!current.cancellationRequested else { return false }
        return true
    }
    private func execute(operationId:String,context:TrustedRequestContext,lease:TransactionWriterLease) async throws -> OperationSnapshot {
        guard var record=await store.record(operationId) else { throw LifecycleFailure.invalidStorage }
        do {
            if record.compensating { return try await compensate(record,context:context,lease:lease) }
            if record.applyState == .unknown {
                switch await lease.writer.readOperation(operationId:operationId+"-apply") {
                case .recorded(.applied(let receipt)):
                    record.applyState = .applied;record.receiptVersion=receipt.version;record.overridden=receipt.overridden;record=try await store.save(record)
                case .recorded(.conflict),.recorded(.invalid),.recorded(.unavailable):
                    record.applyState = .notApplied;record=try await store.save(record)
                    return try await compensate(record,context:context,lease:lease)
                default:return try await uncertain(record)
                }
            }
            if record.recoveryOf != nil { return try await performRecovery(record,context:context,lease:lease) }
            if record.applyState == .notAttempted {
                guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
                try await hooks.reach(.backup,operationId:operationId)
                guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
                if record.credential==nil {
                    if let owned=record.originalOwnership,let reference=owned.credentialReferenceId {
                        record.credential=LifecycleCredential(referenceId:reference,connectionId:record.connectionId,rights:owned.grant,ownership:owned.grantOwnership,
                                                              grantId:owned.managedGrantId,grantRevision:owned.managedGrantRevision,createdByOperation:nil,expiresAt:nil)
                    } else {
                        let outcome:CredentialProvision
                        if record.provisioningStarted { outcome=await credentials.recoverProvision(operationId:operationId) }
                        else {
                            record.provisioningStarted=true;record.phase = .provisioning;record=try await store.save(record)
                            guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
                            outcome=await credentials.provision(operationId:operationId,connectionId:record.connectionId,rights:record.plan.publicPlan.rights)
                        }
                        switch outcome {
                        case .ready(let credential):
                            try credential.validate()
                            guard credential.createdByOperation==operationId,credential.connectionId==record.connectionId,credential.rights==record.plan.publicPlan.rights,
                                  credential.ownership != .preexistingShared else { return try await uncertain(record) }
                            record.credential=credential
                            record.cleanup=CleanupReceipts(configCompensation:.notNeeded,newGrantCleanup:.pending,secretCleanup:.retained)
                        case .refused:return try await compensate(record,context:context,lease:lease)
                        case .unknown:return try await uncertain(record)
                        }
                    }
                    record.phase = .grantProvisional;record=try await store.save(record)
                }
                guard let credential=record.credential else { return try await uncertain(record) }
                guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
                let proof=record.plan.publicPlan.action == .remove ? true:await verifier.provisionalProof(credential,rights:record.plan.publicPlan.rights)
                guard proof,await allowed(record,context:context) else {
                    return try await compensate(record,context:context,lease:lease)
                }
                record.phase = .prepared;record=try await store.save(record)
                try await hooks.reach(.prepared,operationId:operationId)
                let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
                guard fresh.providerVersion==record.plan.providerVersion,fresh.ownedEntry==record.plan.inverse?.entry,await allowed(record,context:context) else {
                    record.reason = .ownedConflict;return try await compensate(record,context:context,lease:lease)
                }
                record.applyState = .unknown;record=try await store.save(record)
                guard await allowed(record,context:context) else {
                    record.applyState = .notApplied;record=try await store.save(record)
                    return try await compensate(record,context:context,lease:lease)
                }
                let result=await lease.writer.applyOwnedPatch(expectedVersion:fresh.providerVersion,patch:ExactOwnedPatch(entry:record.plan.desired?.entry),operationId:operationId+"-apply")
                try await hooks.reach(.providerReturned,operationId:operationId)
                switch result {
                case .applied(let receipt):record.applyState = .applied;record.receiptVersion=receipt.version;record.overridden=receipt.overridden
                case .uncertain:return try await uncertain(record)
                default:record.applyState = .notApplied;record.reason = .ownedConflict
                }
                record.phase = .providerApplied;record=try await store.save(record)
                try await hooks.reach(.providerReceipt,operationId:operationId)
            }
            guard record.applyState == .applied else { return try await compensate(record,context:context,lease:lease) }
            if record.appliedVersion==nil {
                let readback=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
                guard readback.ownedEntry==record.plan.desired?.entry else { return try await uncertain(record) }
                record.appliedVersion=readback.providerVersion
                record.cleanup=CleanupReceipts(configCompensation:.pending,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
                record=try await store.save(record)
            }
            try await installOwnership(record,committed:false)
            try await hooks.reach(.manifest,operationId:operationId)
            if record.plan.publicPlan.action == .remove { return try await finishRemoval(record,context:context,lease:lease) }
            guard try await appliedStillMatches(record,lease:lease),await allowed(record,context:context),!record.overridden else { return try await compensate(record,context:context,lease:lease) }
            guard let credential=record.credential else { return try await uncertain(record) }
            if credential.createdByOperation==operationId && record.activation != .active {
                let activation:CredentialActivation
                if record.activation == .unknown { activation=await credentials.queryActivation(credential,operationId:operationId) }
                else {
                    record.activation = .unknown;record.phase = .activating;record=try await store.save(record)
                    guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
                    activation=await credentials.activate(credential,operationId:operationId)
                    try await hooks.reach(.activationReturned,operationId:operationId)
                }
                switch activation {
                case .active:record.activation = .active
                case .unknown:return try await uncertain(record)
                case .provisional,.refused:record.activation = .refused;record=try await store.save(record);return try await compensate(record,context:context,lease:lease)
                }
                record=try await store.save(record)
            }
            guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
            record.phase = .verifying;record=try await store.save(record)
            let proof=await verifier.verify(credential,rights:record.plan.publicPlan.rights)
            guard proof.satisfies(record.plan.publicPlan.rights) else { return try await compensate(record,context:context,lease:lease) }
            record.verification=proof;record=try await store.save(record)
            try await hooks.reach(.verification,operationId:operationId)
            guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
            guard try await appliedStillMatches(record,lease:lease) else { return try await compensate(record,context:context,lease:lease) }
            try await installOwnership(record,committed:true)
            record.phase = .committed;record.finished=true
            record.cleanup=CleanupReceipts(configCompensation:.notNeeded,newGrantCleanup:.notCreated,secretCleanup:.notOwned)
            record=try await store.save(record)
            return record.snapshot(now:await clock.now())
        } catch {
            // A store failure/crash never guesses whether an awaited side effect ran.
            // Recover from durable receipts on the next admitted operation; no replay.
            guard let saved=await store.record(operationId) else { throw LifecycleFailure.invalidStorage }
            return OperationSnapshot(kind:"operation",operationId:operationId,clientId:saved.plan.publicPlan.clientId,action:saved.plan.publicPlan.action,
                                     phase:.uncertain,cleanup:saved.cleanup,checkedAt:LifecycleTime.stamp(await clock.now()),reason:.invalidStorage)
        }
    }
    private func uncertain(_ record:LifecycleJournalRecord) async throws -> OperationSnapshot {
        var next=record;next.phase = .uncertain;next=try await store.save(next);return next.snapshot(now:await clock.now())
    }
    private func proposedOwnership(_ record:LifecycleJournalRecord,committed:Bool) throws -> OwnershipManifest? {
        guard let entry=record.plan.desired?.entry,let credential=record.credential,let version=record.appliedVersion else { return nil }
        return OwnershipManifest(schemaVersion:1,installationId:record.installationId,connectionId:record.connectionId,clientId:record.plan.publicPlan.clientId,targetKind:.codexUser,
                                 serverKey:"sticker",managedEntryDigest:try EntryFingerprint.digest(entry),ownershipRevision:(record.originalOwnership?.ownershipRevision ?? 0)+1,
                                 creationOperationId:record.originalOwnership?.creationOperationId ?? record.operationId,launcherVersion:entry.launcherVersion,credentialReferenceId:credential.referenceId,grant:credential.rights,
                                 grantOwnership:credential.createdByOperation==record.operationId ? (committed ? .exclusiveManaged:.pendingManaged):credential.ownership,
                                 managedGrantId:credential.grantId,managedGrantRevision:credential.grantRevision,lastProviderVersion:version,
                                 transactionState:committed ? .committed:.providerApplied,cleanup:CleanupReceipts(configCompensation:committed ? .notNeeded:.pending,newGrantCleanup:!committed && credential.createdByOperation==record.operationId ? .pending:.notCreated,secretCleanup:!committed && credential.createdByOperation==record.operationId ? .retained:.notOwned))
    }
    private func installOwnership(_ record:LifecycleJournalRecord,committed:Bool) async throws {
        let proposed=try proposedOwnership(record,committed:committed)
        let current=try await store.ownership(connectionId:record.connectionId)
        if current==proposed { return }
        let prepared=try proposedOwnership(record,committed:false)
        let terminal=try proposedOwnership(record,committed:true)
        if !committed && current==terminal { return }
        guard current==record.originalOwnership || current==prepared || current==terminal else { throw LifecycleFailure.ownedConflict }
        try await store.replaceOwnership(connectionId:record.connectionId,expected:current,with:proposed)
    }
    private func compensate(_ original:LifecycleJournalRecord,context:TrustedRequestContext,lease:TransactionWriterLease) async throws -> OperationSnapshot {
        var record=original
        record.compensating=true;record.phase = .cleanupPending;record=try await store.save(record)
        // A provisioning response can be lost before its safe IDs are journaled.
        if record.provisioningStarted && record.credential==nil {
            switch await credentials.recoverProvision(operationId:record.operationId) {
            case .ready(let credential):
                guard credential.createdByOperation==record.operationId,credential.connectionId==record.connectionId,credential.rights==record.plan.publicPlan.rights else { return try await uncertain(record) }
                record.credential=credential;record.cleanup=CleanupReceipts(configCompensation:record.cleanup.configCompensation,newGrantCleanup:.pending,secretCleanup:.retained);record=try await store.save(record)
            case .unknown:return try await uncertain(record)
            case .refused:break
            }
        }
        if record.applyState == .unknown { return try await uncertain(record) }
        if record.activation == .unknown,let credential=record.credential {
            switch await credentials.queryActivation(credential,operationId:record.operationId) {
            case .unknown:return try await uncertain(record)
            case .active:record.activation = .active
            case .refused,.provisional:record.activation = .refused
            }
            record=try await store.save(record)
        }
        if record.applyState == .applied && record.cleanup.configCompensation != .restored {
            let inverseId=record.operationId+"-inverse"
            var alreadyRestored=false
            switch await lease.writer.readOperation(operationId:inverseId) {
            case .recorded(.applied):alreadyRestored=true
            case .recorded(.uncertain),.unknown:
                if record.cleanup.configCompensation == .uncertain { return try await uncertain(record) }
            default:break
            }
            let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
            if alreadyRestored {
                guard fresh.ownedEntry==record.plan.inverse?.entry else { return try await uncertain(record) }
                record.cleanup=CleanupReceipts(configCompensation:.restored,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
            } else if fresh.providerVersion==record.appliedVersion && fresh.ownedEntry==record.plan.desired?.entry {
                record.cleanup=CleanupReceipts(configCompensation:.uncertain,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
                record=try await store.save(record)
                let inverseResult=await lease.writer.restoreOwnedPatch(expectedCurrentVersion:fresh.providerVersion,inversePatch:ExactOwnedPatch(entry:record.plan.inverse?.entry),operationId:inverseId)
                try await hooks.reach(.inverseReturned,operationId:record.operationId)
                switch inverseResult {
                case .applied:
                    let restored=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
                    guard restored.ownedEntry==record.plan.inverse?.entry else { return try await uncertain(record) }
                    record.cleanup=CleanupReceipts(configCompensation:.restored,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
                case .conflict:record.cleanup=CleanupReceipts(configCompensation:.conflict,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
                default:return try await uncertain(record)
                }
            } else { record.cleanup=CleanupReceipts(configCompensation:.conflict,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup);record.reason = .ownedConflict }
            record=try await store.save(record)
        }
        // Config and private ownership persist independently. Replay this step
        // even when the restored config receipt was loaded after a lost reply.
        var ownershipReconciled=true
        if record.applyState == .applied && record.cleanup.configCompensation == .restored {
            let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
            if fresh.ownedEntry != record.plan.inverse?.entry {
                ownershipReconciled=false;record.reason = .ownedConflict
                record.cleanup=CleanupReceipts(configCompensation:.conflict,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:record.cleanup.secretCleanup)
                record=try await store.save(record)
            } else {
                let current=try await store.ownership(connectionId:record.connectionId)
                if current != record.originalOwnership {
                    let prepared=try proposedOwnership(record,committed:false),committed=try proposedOwnership(record,committed:true)
                    if current==prepared || current==committed {
                        try await store.replaceOwnership(connectionId:record.connectionId,expected:current,with:record.originalOwnership)
                    } else {
                        ownershipReconciled=false;record.reason = .ownedConflict;record=try await store.save(record)
                    }
                }
            }
            if ownershipReconciled { try await hooks.reach(.compensatedConfig,operationId:record.operationId) }
        }
        let configClear=record.applyState != .applied || record.cleanup.configCompensation == .restored
        record=try await cleanCredential(record,context:context,configClear:configClear && ownershipReconciled)
        let grantClear=[NewGrantCleanup.notCreated,.revoked,.confirmedExpired].contains(record.cleanup.newGrantCleanup)
        let secretClear=[SecretCleanup.notOwned,.deleted].contains(record.cleanup.secretCleanup)
        if configClear && ownershipReconciled && grantClear && secretClear { record.phase = .rolledBack;record.finished=true }
        else { record.phase = .cleanupPending }
        record=try await store.save(record);return record.snapshot(now:await clock.now())
    }
    private func cleanCredential(_ original:LifecycleJournalRecord,context:TrustedRequestContext,configClear:Bool,removal:Bool=false) async throws -> LifecycleJournalRecord {
        var record=original
        guard let credential=record.credential,(credential.createdByOperation==record.operationId || (removal && credential.ownership == .exclusiveManaged)) else { return record }
        if ![NewGrantCleanup.revoked,.confirmedExpired].contains(record.cleanup.newGrantCleanup) {
            let terminal:CredentialTerminal
            if record.cleanup.newGrantCleanup == .uncertain { terminal=await credentials.queryTerminal(credential,operationId:record.operationId) }
            else if await owner.isCurrent(context,digest:record.plan.publicPlan.digest) {
                record.cleanup=CleanupReceipts(configCompensation:record.cleanup.configCompensation,newGrantCleanup:.uncertain,secretCleanup:.retained);record=try await store.save(record)
                terminal=await credentials.revoke(credential,operationId:record.operationId)
                try await hooks.reach(.revocationReturned,operationId:record.operationId)
            } else { return record }
            let grant:NewGrantCleanup
            switch terminal { case .revoked:grant = .revoked;case .expired:grant = .confirmedExpired;case .pending:grant = .pending;case .unknown:grant = .uncertain }
            record.cleanup=CleanupReceipts(configCompensation:record.cleanup.configCompensation,newGrantCleanup:grant,secretCleanup:.retained);record=try await store.save(record)
            try await hooks.reach(.compensatedGrant,operationId:record.operationId)
        }
        if configClear,[NewGrantCleanup.revoked,.confirmedExpired].contains(record.cleanup.newGrantCleanup),record.cleanup.secretCleanup != .deleted {
            if await credentials.disposeOwnedSecret(credential,operationId:record.operationId) {
                try await hooks.reach(.secretDisposed,operationId:record.operationId)
                record.cleanup=CleanupReceipts(configCompensation:record.cleanup.configCompensation,newGrantCleanup:record.cleanup.newGrantCleanup,secretCleanup:.deleted);record=try await store.save(record)
                try await hooks.reach(.compensatedSecret,operationId:record.operationId)
            }
        }
        return record
    }
    private func performRecovery(_ original:LifecycleJournalRecord,context:TrustedRequestContext,lease:TransactionWriterLease) async throws -> OperationSnapshot {
        var record=original
        guard let origin=record.recoveryOf,var old=await store.record(origin),old.compensating,
              old.requesterId==record.requesterId,old.installationId==record.installationId,old.connectionId==record.connectionId,
              record.plan.desired==old.plan.inverse,record.plan.inverse==old.plan.desired else { return try await uncertain(record) }
        if record.credential==nil { record.credential=old.credential;record=try await store.save(record) }
        if record.applyState == .notAttempted {
            guard await allowed(record,context:context) else { return try await compensate(record,context:context,lease:lease) }
            let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
            guard fresh.providerVersion==record.plan.providerVersion,fresh.ownedEntry==record.plan.inverse?.entry else { throw LifecycleFailure.ownedConflict }
            record.applyState = .unknown;record.phase = .prepared;record=try await store.save(record)
            guard await allowed(record,context:context) else {
                record.applyState = .notApplied;record.phase = .rolledBack;record.finished=true;record=try await store.save(record)
                return record.snapshot(now:await clock.now())
            }
            let result=await lease.writer.restoreOwnedPatch(expectedCurrentVersion:fresh.providerVersion,inversePatch:ExactOwnedPatch(entry:record.plan.desired?.entry),operationId:record.operationId+"-apply")
            try await hooks.reach(.providerReturned,operationId:record.operationId)
            switch result {
            case .applied(let receipt):record.applyState = .applied;record.receiptVersion=receipt.version
            case .uncertain:return try await uncertain(record)
            default:record.applyState = .notApplied;record.phase = .rolledBack;record.finished=true;record.reason = .ownedConflict;record=try await store.save(record);return record.snapshot(now:await clock.now())
            }
            record=try await store.save(record)
        }
        guard record.applyState == .applied else { return try await uncertain(record) }
        let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
        let clear=fresh.ownedEntry==record.plan.desired?.entry
        if clear {
            if record.appliedVersion==nil { record.appliedVersion=fresh.providerVersion;record=try await store.save(record) }
            try await installOwnership(record,committed:true)
            old.cleanup=CleanupReceipts(configCompensation:.restored,newGrantCleanup:old.cleanup.newGrantCleanup,secretCleanup:old.cleanup.secretCleanup)
        } else { old.cleanup=CleanupReceipts(configCompensation:.conflict,newGrantCleanup:old.cleanup.newGrantCleanup,secretCleanup:old.cleanup.secretCleanup) }
        old=try await store.save(old)
        old=try await cleanCredential(old,context:context,configClear:clear)
        let grantClear=[NewGrantCleanup.notCreated,.revoked,.confirmedExpired].contains(old.cleanup.newGrantCleanup)
        let secretClear=[SecretCleanup.notOwned,.deleted].contains(old.cleanup.secretCleanup)
        if clear && grantClear && secretClear { old.phase = .rolledBack;old.finished=true }
        else { old.phase = .cleanupPending }
        old=try await store.save(old)
        record.cleanup=old.cleanup;record.phase=old.finished ? .committed:.cleanupPending;record.finished=old.finished
        record=try await store.save(record);return record.snapshot(now:await clock.now())
    }
    private func appliedStillMatches(_ record:LifecycleJournalRecord,lease:TransactionWriterLease) async throws -> Bool {
        let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
        return fresh.providerVersion==record.appliedVersion && fresh.ownedEntry==record.plan.desired?.entry
    }
    private func finishRemoval(_ original:LifecycleJournalRecord,context:TrustedRequestContext,lease:TransactionWriterLease) async throws -> OperationSnapshot {
        var record=original
        if record.cleanup.configCompensation != .notNeeded {
            record.cleanup=CleanupReceipts(configCompensation:.notNeeded,newGrantCleanup:record.credential?.ownership == .exclusiveManaged ? .pending:.notCreated,
                                           secretCleanup:record.credential?.ownership == .exclusiveManaged ? .retained:.notOwned)
            record=try await store.save(record)
        }
        let fresh=try await lease.writer.readOwnedTarget(profileId:record.plan.publicPlan.clientId,connectionId:record.connectionId)
        let configClear=fresh.ownedEntry==nil
        record=try await cleanCredential(record,context:context,configClear:configClear,removal:true)
        if configClear,[.notCreated,.revoked,.confirmedExpired].contains(record.cleanup.newGrantCleanup),[.notOwned,.deleted].contains(record.cleanup.secretCleanup) { record.phase = .committed;record.finished=true }
        else { record.phase = .cleanupPending }
        record=try await store.save(record);return record.snapshot(now:await clock.now())
    }
    func resumeCompensation(operationId:String,context:TrustedRequestContext) async throws -> OperationSnapshot {
        guard let record=await store.record(operationId),record.compensating else { throw LifecycleFailure.operationConflict }
        return try await applyChange(planId:record.plan.publicPlan.planId,digest:record.plan.publicPlan.digest,operationId:operationId,context:context)
    }
    /// Success accepts a durable plan-admission fence, not completed rollback.
    /// getOperation remains the separate config/grant/secret cleanup authority.
    func cancelPlan(planId:String,context:TrustedRequestContext) async throws {
        try trusted(context)
        if let done=await store.completedOperation(planId:planId,requesterId:context.requesterId,installationId:context.identity.installationId),done.phase == .committed { throw LifecycleFailure.operationConflict }
        let binding:CancellationPlanBinding?
        if let record=await store.operation(planId:planId,requesterId:context.requesterId,installationId:context.identity.installationId) {
            guard record.connectionId==context.connectionId else { throw LifecycleFailure.permissionRequired };binding=record.cancellationBinding
        } else if let cached=plans[planId],cached.requester==context.requesterId,cached.installation==context.identity.installationId {
            binding=reservingPlans.contains(planId) ? CancellationPlanBinding(planId:planId,digest:cached.plan.publicPlan.digest,requesterId:context.requesterId,installationId:context.identity.installationId,connectionId:context.connectionId,clientId:context.identity.clientId,action:cached.plan.publicPlan.action):nil
        } else if let known=await store.cancellationBinding(planId:planId),known.matches(context) { binding=known }
        else { throw LifecycleFailure.permissionRequired }
        plans.removeValue(forKey:planId);planner.cancel(planId:planId);await decisions.cancel(planId)
        if let binding=binding {
            try await store.cancelAdmission(binding)
            if let done=await store.completedOperation(planId:planId,requesterId:context.requesterId,installationId:context.identity.installationId),done.phase == .committed { throw LifecycleFailure.operationConflict }
        }
    }
    func getOperation(operationId:String,context:TrustedRequestContext) async throws -> OperationSnapshot {
        try trusted(context)
        guard let record=await store.record(operationId),record.requesterId==context.requesterId,record.installationId==context.identity.installationId,record.connectionId==context.connectionId,record.plan.publicPlan.clientId==context.identity.clientId else { throw LifecycleFailure.permissionRequired }
        let fence=await store.cancellationState(record.cancellationBinding)
        if !record.finished && [.uncertain,.conflict].contains(fence) {
            return OperationSnapshot(kind:"operation",operationId:record.operationId,clientId:record.plan.publicPlan.clientId,action:record.plan.publicPlan.action,phase:.uncertain,cleanup:record.cleanup,checkedAt:LifecycleTime.stamp(await clock.now()),reason:.cancellationUnconfirmed)
        }
        return (await store.record(operationId) ?? record).snapshot(now:await clock.now())
    }
    func verifyConnection(expectedOwnershipRevision:Int,context:TrustedRequestContext) async throws -> LifecycleVerification {
        let lease=try await lease(context,action:.update)
        guard let owned=try await store.ownership(connectionId:context.connectionId),owned.ownershipRevision==expectedOwnershipRevision,let reference=owned.credentialReferenceId else { throw LifecycleFailure.ownedConflict }
        let current=try await lease.writer.readOwnedTarget(profileId:context.identity.clientId,connectionId:context.connectionId)
        guard let entry=current.ownedEntry,try EntryFingerprint.digest(entry)==owned.managedEntryDigest,entry.installationId==context.identity.installationId,entry.connectionId==context.connectionId else { throw LifecycleFailure.ownedConflict }
        let credential=LifecycleCredential(referenceId:reference,connectionId:context.connectionId,rights:owned.grant,ownership:owned.grantOwnership,grantId:owned.managedGrantId,grantRevision:owned.managedGrantRevision,createdByOperation:nil,expiresAt:nil)
        return await verifier.verify(credential,rights:owned.grant)
    }
    func planRollback(appliedOperationId:String,expectedOwnershipRevision:Int,context:TrustedRequestContext) async throws -> ConnectionPlan {
        let lease=try await lease(context,action:.update)
        guard let record=await store.record(appliedOperationId),((record.finished && record.phase == .committed && record.plan.publicPlan.action != .remove) || (record.compensating && record.applyState == .applied && record.cleanup.configCompensation == .conflict && record.activation != .unknown)),
              record.requesterId==context.requesterId,record.installationId==context.identity.installationId,record.connectionId==context.connectionId else { throw LifecycleFailure.ownedConflict }
        let snapshot=try await lease.writer.readOwnedTarget(profileId:context.identity.clientId,connectionId:context.connectionId)
        let owned=try await store.ownership(connectionId:context.connectionId)
        let inverse=record.plan.inverse?.entry
        if inverse==nil && !lease.supportsDelete { throw LifecycleFailure.writerUnavailable }
        let intent=ChangeIntent(action:inverse==nil ? .remove:.update,clientId:context.identity.clientId,installationId:context.identity.installationId,connectionId:context.connectionId,
                                currentProjectId:context.currentProjectId,expectedOwnershipRevision:expectedOwnershipRevision,desiredLauncherVersion:inverse?.launcherVersion ?? launcherVersion,
                                credentialReferenceId:owned?.credentialReferenceId,visibility:inverse.map { .replace(enabled:$0.enabledTools,disabled:$0.disabledTools) } ?? .preserve)
        let now=await clock.now();prunePlans(now:now)
        let plan=try planner.plan(snapshot:snapshot,ownership:owned,intent:intent,now:now)
        plans[plan.publicPlan.planId]=CachedPlan(plan:plan,requester:context.requesterId,installation:context.identity.installationId,recoveryOf:record.compensating ? record.operationId:nil);return plan.publicPlan
    }
    func handle(_ data:Data,context:TrustedRequestContext) async -> Data {
        var requestId="invalid"
        do {
            let request=try LifecycleWire.decodeRequest(data);requestId=request.requestId
            let result:Any
            switch request.method {
            case .detectClients:try trusted(context);result=try JSONSerialization.jsonObject(with:JSONEncoder().encode(await ClientProfiles.detect(using:discovery,now:await clock.now())))
            case .planChange:
                do { result=try JSONSerialization.jsonObject(with:JSONEncoder().encode(await planChange(action:request.action!,expectedOwnershipRevision:request.expectedOwnershipRevision!,context:context))) }
                catch LifecycleFailure.writerUnavailable { result=["kind":"unavailable","reason":"writer_unavailable"] }
            case .applyChange:result=try JSONSerialization.jsonObject(with:JSONEncoder().encode(await applyChange(planId:request.planId!,digest:request.digest!,operationId:request.operationId!,context:context)))
            case .getOperation:result=try JSONSerialization.jsonObject(with:JSONEncoder().encode(await getOperation(operationId:request.operationId!,context:context)))
            case .cancelPlan:try await cancelPlan(planId:request.planId!,context:context);result=["canceled":true]
            case .verifyConnection:result=try await verifyConnection(expectedOwnershipRevision:request.expectedOwnershipRevision!,context:context).object(client:context.identity.clientId,now:await clock.now())
            case .planRollback:result=try JSONSerialization.jsonObject(with:JSONEncoder().encode(await planRollback(appliedOperationId:request.appliedOperationId!,expectedOwnershipRevision:request.expectedOwnershipRevision!,context:context)))
            }
            let response=try JSONSerialization.data(withJSONObject:["version":1,"requestId":requestId,"method":request.method.rawValue,"result":result],options:[.sortedKeys])
            try LifecycleWire.validateResponse(response);return response
        } catch {
            let code=(error as? LifecycleFailure) ?? .invalidStorage
            return (try? JSONSerialization.data(withJSONObject:["version":1,"requestId":requestId,"error":["code":code.rawValue]],options:[.sortedKeys])) ?? Data()
        }
    }
}
