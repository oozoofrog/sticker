import Foundation

func transactionTests() async throws {
    for action in [ConnectionAction.connect,.update,.remove] {
        let h=try await TransactionHarness.make(available:false)
        do { _ = try await h.manager.planChange(action:action,expectedOwnershipRevision:0,context:h.context);Check.that(false,"uncertified writer must reject") }
        catch { Check.that(error as? LifecycleFailure == .writerUnavailable,"unavailable writer returns exact code") }
        let mutations=await h.store.mutationCount
        let grants=await h.credentials.provisions
        Check.that(mutations==0 && grants==0,"unavailable writer has zero store/grant mutations")
    }
    let h=try await TransactionHarness.make()
    let plan=try await h.plan()
    Check.that(plan.rights==GrantSummary(projectIds:["project-one"],canWrite:true),"Connect has fixed current-project rights")
    do { _ = try await h.apply(plan);Check.that(false,"native decision required") }
    catch { Check.that(error as? LifecycleFailure == .permissionRequired,"MCP request is not native approval") }
    let beforeApproval=await h.store.mutationCount
    Check.that(beforeApproval==0,"unapproved apply has zero journal mutations")
    try await h.approve(plan)
    async let a=h.apply(plan)
    async let b=h.apply(plan)
    let joined=try await [a,b]
    let writes=await h.writer.writes,provisions=await h.credentials.provisions
    Check.that(joined.allSatisfy { $0.phase == .committed } && writes==1 && provisions==1,"same operation joins one transaction")
    let retained=await h.manager.retainedPlanCount()
    Check.that(retained==0,"admitted plan releases private preview bytes")
    let repeated=try await h.apply(plan)
    Check.that(repeated.phase == .committed,"terminal operation replays receipt")
    do { _ = try await h.manager.applyChange(planId:plan.planId,digest:String(repeating:"f",count:64),operationId:"operation-one",context:h.context);Check.that(false,"reused operation must bind digest") }
    catch { Check.that(error as? LifecycleFailure == .operationConflict,"operation digest mismatch fails closed") }
    let manifest=try await h.store.ownership(connectionId:"connection-one")
    Check.that(manifest?.ownershipRevision==1 && manifest?.managedGrantId=="grant-one","commit writes exact managed ownership")
    let verification=try await h.manager.verifyConnection(expectedOwnershipRevision:1,context:h.context)
    Check.that(verification.actualClient == .refreshRequired,"direct verification does not claim selected client loaded config")

    let expired=try await TransactionHarness.make()
    let expires=try await expired.plan();try await expired.approve(expires);await expired.clock.advance(300)
    do { _ = try await expired.apply(expires);Check.that(false,"expired new apply must fail") }
    catch { Check.that(error as? LifecycleFailure == .planExpired,"expiry before apply detected") }
    let expiredMutations=await expired.store.mutationCount
    Check.that(expiredMutations==0,"expiry before admission has no journal mutation")

    let cache=try await TransactionHarness.make()
    for _ in 0..<4 { _ = try await cache.plan() }
    await cache.clock.advance(301);_ = try await cache.plan()
    let retainedExpired=await cache.manager.retainedPlanCount()
    Check.that(retainedExpired==1,"expired manager previews do not retain private backups")

    let canceled=try await TransactionHarness.make()
    let cancelPlan=try await canceled.plan()
    try await canceled.manager.cancelPlan(planId:cancelPlan.planId,context:canceled.context)
    do { _ = try await canceled.apply(cancelPlan);Check.that(false,"canceled plan cannot apply") } catch { Check.that(true,"cancel before confirmation has no write") }
    let canceledWrites=await canceled.writer.writes
    Check.that(canceledWrites==0,"cancel does not dispatch writer")

    let existing=try await TransactionHarness.make()
    let first=try await existing.plan();try await existing.approve(first);_ = try await existing.apply(first)
    let update=try await existing.manager.planChange(action:.update,expectedOwnershipRevision:1,context:existing.context)
    try await existing.approve(update)
    let updated=try await existing.manager.applyChange(planId:update.planId,digest:update.digest,operationId:"update-one",context:existing.context)
    let updatedOwnership=try await existing.store.ownership(connectionId:"connection-one")
    Check.that(updatedOwnership?.creationOperationId=="operation-one","Update preserves original ownership creation operation")
    let existingProvisions=await existing.credentials.provisions,existingActivations=await existing.credentials.activations
    Check.that(updated.phase == .committed && existingProvisions==1 && existingActivations==1,"ordinary update reuses managed credential without rotation")
    let removal=try await existing.manager.planChange(action:.remove,expectedOwnershipRevision:2,context:existing.context)
    try await existing.approve(removal)
    let removed=try await existing.manager.applyChange(planId:removal.planId,digest:removal.digest,operationId:"remove-one",context:existing.context)
    let absent=try await existing.writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let disposal=await existing.credentials.disposals
    Check.that(removed.phase == .committed && absent.ownedEntry==nil && disposal==1,"Remove clears exact config then owned grant and secret")

    let shared=try await TransactionHarness.make()
    await shared.writer.seed(fixtureEntry());await shared.verification.setProof(false)
    let base=manifestFixture()
    let sharedOwnership=OwnershipManifest(schemaVersion:base.schemaVersion,installationId:base.installationId,connectionId:base.connectionId,clientId:base.clientId,targetKind:base.targetKind,serverKey:base.serverKey,
                                         managedEntryDigest:base.managedEntryDigest,ownershipRevision:base.ownershipRevision,creationOperationId:base.creationOperationId,launcherVersion:base.launcherVersion,
                                         credentialReferenceId:base.credentialReferenceId,grant:base.grant,grantOwnership:.preexistingShared,managedGrantId:nil,managedGrantRevision:nil,lastProviderVersion:"layer-0",transactionState:.committed,cleanup:base.cleanup)
    try await shared.store.replaceOwnership(connectionId:"connection-one",expected:nil,with:sharedOwnership)
    let sharedPlan=try await shared.manager.planChange(action:.remove,expectedOwnershipRevision:2,context:shared.context)
    try await shared.approve(sharedPlan)
    let sharedRemoved=try await shared.manager.applyChange(planId:sharedPlan.planId,digest:sharedPlan.digest,operationId:"remove-shared",context:shared.context)
    let sharedProvisions=await shared.credentials.provisions,sharedDisposals=await shared.credentials.disposals
    Check.that(sharedRemoved.phase == .committed && sharedProvisions==0 && sharedDisposals==0,"Remove does not require working credential proof and preserves configured/shared credentials")
    let operationReply=await h.manager.handle(Data(#"{"version":1,"requestId":"safe","method":"getOperation","operationId":"operation-one"}"#.utf8),context:h.context)
    try LifecycleWire.validateResponse(operationReply)
    let safeText=String(decoding:operationReply,as:UTF8.self)
    Check.that(!safeText.contains("reference-one") && !safeText.contains("grant-one") && !safeText.contains("foreign-original") && !safeText.contains("layer-"),"manager wire exposes no private reference/config/provider receipt")

    let forged=Data(#"{"version":1,"requestId":"r","method":"applyChange","planId":"p","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operationId":"o","approved":true}"#.utf8)
    let reply=await h.manager.handle(forged,context:h.context)
    try LifecycleWire.validateResponse(reply)
    Check.that(String(decoding:reply,as:UTF8.self).contains("invalid_input"),"wire cannot forge native consent")
}

actor TransactionTestClock: LifecycleClock {
    private var value=Date(timeIntervalSince1970:1793448000)
    func now() -> Date { value }
    func advance(_ seconds:TimeInterval) { value=value.addingTimeInterval(seconds) }
}
actor TransactionTestOwner: LifecycleOwnerAuthority {
    private var current=true
    func set(_ value:Bool) { current=value }
    func isCurrent(_ context:TrustedRequestContext,digest:String) async -> Bool { current }
}
actor MemoryLifecyclePersistence: PrivateLifecyclePersistence {
    private var version=0
    private var data:Data?
    private let yielding:Bool
    private var uncertainNext=false
    private var cancellationFences:[String:CancellationFence]=[:]
    init(yielding:Bool=false) { self.yielding=yielding }
    func makeNextWriteUncertain() { uncertainNext=true }
    func recordCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        if let prior=cancellationFences[binding.planId] { return prior.binding==binding ? prior.state:.conflict }
        guard cancellationFences.count<200 else { return .uncertain }
        cancellationFences[binding.planId]=CancellationFence(binding:binding,state:.confirmed);return .confirmed
    }
    func read() -> PersistedLifecycleState { PersistedLifecycleState(version:version,data:data,cancellationFences:Array(cancellationFences.values)) }
    func compareAndSwap(expectedVersion:Int,data:Data) async -> PrivateStateWrite {
        if yielding { await Task.yield() }
        guard version==expectedVersion else { return .conflict }
        version+=1;self.data=data
        if uncertainNext { uncertainNext=false;return .uncertain }
        return .written(version)
    }
}
struct TransactionTestWriters: LifecycleWriterProvider {
    let writer:TransactionTestWriter
    let available:Bool
    func lease(for identity:VerifiedClientIdentity) async -> TransactionWriterLease? { available ? TransactionWriterLease(writer:writer,supportsDelete:true):nil }
}
actor TransactionTestCredentials: LifecycleCredentialBootstrap {
    private var prepared:[String:LifecycleCredential]=[:]
    private var activation:CredentialActivation = .active
    private var revoked=Set<String>(),disposed=Set<String>(),activated=Set<String>()
    private(set) var provisions=0,activations=0,disposals=0
    func setActivation(_ value:CredentialActivation) { activation=value }
    func provision(operationId:String,connectionId:String,rights:GrantSummary) async -> CredentialProvision {
        if let existing=prepared[operationId] { return .ready(existing) }
        provisions+=1
        let credential=LifecycleCredential(referenceId:operationId=="operation-one" ? "reference-one":"reference-"+operationId,connectionId:connectionId,rights:rights,ownership:.pendingManaged,grantId:operationId=="operation-one" ? "grant-one":"grant-"+operationId,grantRevision:1,
                                           createdByOperation:operationId,expiresAt:nil)
        prepared[operationId]=credential;return .ready(credential)
    }
    func recoverProvision(operationId:String) async -> CredentialProvision { prepared[operationId].map { .ready($0) } ?? .refused }
    func activate(_ credential:LifecycleCredential,operationId:String) async -> CredentialActivation {
        if activated.insert(operationId).inserted { activations+=1 }
        return activation
    }
    func queryActivation(_ credential:LifecycleCredential,operationId:String) async -> CredentialActivation { activated.contains(operationId) ? activation:.provisional }
    func revoke(_ credential:LifecycleCredential,operationId:String) async -> CredentialTerminal { revoked.insert(operationId);return .revoked }
    func queryTerminal(_ credential:LifecycleCredential,operationId:String) async -> CredentialTerminal { revoked.contains(operationId) ? .revoked:.pending }
    func disposeOwnedSecret(_ credential:LifecycleCredential,operationId:String) async -> Bool {
        if disposed.insert(operationId).inserted { disposals+=1 };return true
    }
}
actor TransactionTestVerification: LifecycleVerificationProvider {
    private var valid=true
    private var proof=true
    func setProof(_ value:Bool) { proof=value }
    func setValid(_ value:Bool) { valid=value }
    func provisionalProof(_ credential:LifecycleCredential,rights:GrantSummary) async -> Bool { proof }
    func verify(_ credential:LifecycleCredential,rights:GrantSummary) async -> LifecycleVerification {
        LifecycleVerification(protocolCheck:valid ? .toolsVerified:.failed,actualClient:.refreshRequired,identityMatches:valid,rights:rights,expectedToolCount:2,availableToolCount:valid ? 2:0,missingToolNames:[])
    }
}
actor TransactionTestHooks: LifecycleTransactionHooks {
    typealias Handler = @Sendable (String) async throws -> Void
    private var handlers:[TransactionCheckpoint:Handler]=[:]
    func set(_ point:TransactionCheckpoint,_ handler:@escaping Handler) { handlers[point]=handler }
    func reach(_ checkpoint:TransactionCheckpoint,operationId:String) async throws {
        if let handler=handlers.removeValue(forKey:checkpoint) { try await handler(operationId) }
    }
}
struct TransactionEmptyDiscovery: MetadataDiscovery { func candidates(for client:ClientId) async throws -> [ClientMetadata] { [] } }
struct TransactionHarness {
    let persistence:MemoryLifecyclePersistence
    let store:OwnedLifecycleJournal
    let clock:TransactionTestClock
    let owner:TransactionTestOwner
    let credentials:TransactionTestCredentials
    let verification:TransactionTestVerification
    let decisions:NativeDecisionStore
    let hooks:TransactionTestHooks
    let writer:TransactionTestWriter
    let context:TrustedRequestContext
    let manager:NativeConnectionManager
    static func make(available:Bool=true) async throws -> TransactionHarness {
        let persistence=MemoryLifecyclePersistence(),clock=TransactionTestClock(),owner=TransactionTestOwner(),credentials=TransactionTestCredentials()
        let verifier=TransactionTestVerification(),decisions=NativeDecisionStore(),hooks=TransactionTestHooks(),writer=TransactionTestWriter()
        let store=try await OwnedLifecycleJournal.open(persistence)
        let context=TrustedRequestContext(requesterId:"requester-one",identity:VerifiedClientIdentity(clientId:.codexLocal,installationId:"installation-one",version:available ? "synthetic-only":"0.166.0-alpha.5.1"),connectionId:"connection-one",currentProjectId:"project-one",verifiedPeer:true)
        let provider:any LifecycleWriterProvider = available ? TransactionTestWriters(writer:writer,available:true):UnavailableLifecycleWriterProvider()
        let manager=NativeConnectionManager(store:store,writers:provider,clock:clock,owner:owner,credentials:credentials,verifier:verifier,
                                            decisions:decisions,hooks:hooks,discovery:TransactionEmptyDiscovery(),launcherVersion:"2.0.0")
        return TransactionHarness(persistence:persistence,store:store,clock:clock,owner:owner,credentials:credentials,verification:verifier,decisions:decisions,hooks:hooks,writer:writer,context:context,manager:manager)
    }
    func plan() async throws -> ConnectionPlan { try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:context) }
    func approve(_ plan:ConnectionPlan) async throws { try await decisions.record(plan,requesterId:context.requesterId,installationId:context.identity.installationId,now:clock.now(),source:.nativeUserGesture) }
    func apply(_ plan:ConnectionPlan) async throws -> OperationSnapshot { try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:context) }
    func restart() async throws -> NativeConnectionManager {
        let reopened=try await OwnedLifecycleJournal.open(persistence)
        return NativeConnectionManager(store:reopened,writers:TransactionTestWriters(writer:writer,available:true),clock:clock,owner:owner,credentials:credentials,verifier:verification,
                                       decisions:decisions,hooks:hooks,discovery:TransactionEmptyDiscovery(),launcherVersion:"2.0.0")
    }
}
