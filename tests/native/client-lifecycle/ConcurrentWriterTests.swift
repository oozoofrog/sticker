import Foundation

func concurrentWriterTests() async throws {
    try await heldLeasePreviewTests()
    try await heldReservationCancellationTests()
    try await cancellationFenceTests()
    let before=try await TransactionHarness.make()
    let plan=try await before.plan();try await before.approve(plan);await before.writer.externalEdit()
    do { _ = try await before.apply(plan);Check.that(false,"stale preview cannot apply") } catch { Check.that(error as? LifecycleFailure == .ownedConflict,"foreign preapply edit conflicts") }
    let mutations=await before.store.mutationCount
    Check.that(mutations==0,"foreign preapply edit has no credential/store mutation")
    let after=try await TransactionHarness.make()
    await after.hooks.set(.manifest) { _ in await after.writer.externalEdit();await after.credentials.setActivation(.refused) }
    let p=try await after.plan();try await after.approve(p)
    let conflict=try await after.apply(p)
    let state=try await after.writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let disposed=await after.credentials.disposals
    Check.that(conflict.phase == .cleanupPending && conflict.cleanup.configCompensation == .conflict,"foreign postapply edit blocks compensation")
    Check.that(state.rawBytes==Data("foreign-new".utf8) && disposed==0,"foreign edit and recovery credential retained")

    let rollback=try await after.manager.planRollback(appliedOperationId:"operation-one",expectedOwnershipRevision:1,context:after.context)
    try await after.approve(rollback)
    let recovered=try await after.manager.applyChange(planId:rollback.planId,digest:rollback.digest,operationId:"fresh-rollback",context:after.context)
    let preservedForeign=try await after.writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let closed=try await after.manager.getOperation(operationId:"operation-one",context:after.context)
    Check.that(recovered.phase == .committed && closed.phase == .rolledBack && preservedForeign.ownedEntry==nil && preservedForeign.rawBytes==Data("foreign-new".utf8),"new explicit inverse preview cleans old operation while preserving foreign edit")
    await after.credentials.setActivation(.active)
    let next=try await after.plan();try await after.approve(next)
    let reconnected=try await after.manager.applyChange(planId:next.planId,digest:next.digest,operationId:"connect-next",context:after.context)
    Check.that(reconnected.phase == .committed,"next explicit Connect after cleanup requires no custom fields")

    let changed=try await TransactionHarness.make()
    await changed.hooks.set(.manifest) { _ in await changed.writer.externalEdit() }
    let cp=try await changed.plan();try await changed.approve(cp)
    let stopped=try await changed.apply(cp)
    let changedActivations=await changed.credentials.activations
    Check.that(stopped.phase == .cleanupPending && changedActivations==0,"intervening config edit forbids grant activation")

    let unknown=try await TransactionHarness.make();await unknown.writer.setUnknown(true)
    let u=try await unknown.plan();try await unknown.approve(u)
    let uncertain=try await unknown.apply(u);let again=try await unknown.apply(u)
    let unknownWrites=await unknown.writer.writes,activated=await unknown.credentials.activations
    Check.that(uncertain.phase == .uncertain && again.phase == .uncertain && unknownWrites==1 && activated==0,"unknown provider outcome is never inferred from matching bytes or replayed")
}

actor TransactionTestWriter: VersionedWriter {
    private var entry:OwnedLaunchEntry?
    private var revision=0
    private var bytes=Data("foreign-original".utf8)
    private var unknown=false
    private var receipts:[String:ProviderWriteResult]=[:]
    private(set) var writes=0,restores=0
    func setUnknown(_ value:Bool) { unknown=value }
    func seed(_ value:OwnedLaunchEntry) { entry=value }
    func externalEdit() { revision+=1;bytes=Data("foreign-new".utf8) }
    func readOwnedTarget(profileId:ClientId,connectionId:String) async throws -> PrivateConfigSnapshot { fixtureSnapshot(entry:entry,version:"layer-\(revision)",bytes:bytes) }
    func applyOwnedPatch(expectedVersion:String,patch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult {
        if let prior=receipts[operationId] { return prior }
        guard expectedVersion=="layer-\(revision)" else { return .conflict }
        writes+=1;entry=patch.entry;revision+=1
        let result:ProviderWriteResult=unknown ? .uncertain:.applied(ProviderWriteReceipt(version:"receipt-\(revision)",overridden:false))
        receipts[operationId]=result;return result
    }
    func readOperation(operationId:String) async -> ProviderOperationState { receipts[operationId].map { .recorded($0) } ?? .unknown }
    func restoreOwnedPatch(expectedCurrentVersion:String,inversePatch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult {
        if let prior=receipts[operationId] { return prior }
        guard expectedCurrentVersion=="layer-\(revision)" else { return .conflict }
        restores+=1;entry=inversePatch.entry;revision+=1
        let result=ProviderWriteResult.applied(ProviderWriteReceipt(version:"receipt-\(revision)",overridden:false))
        receipts[operationId]=result;return result
    }
}

actor HeldLifecycleLease: LifecycleWriterProvider {
    let writer:TransactionTestWriter
    private var armed=false,entered=false
    private var released:CheckedContinuation<Void,Never>?
    private var listeners:[CheckedContinuation<Void,Never>]=[]
    init(_ writer:TransactionTestWriter) { self.writer=writer }
    func arm() { armed=true;entered=false }
    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { listeners.append($0) }
    }
    func release() { released?.resume();released=nil }
    func lease(for identity:VerifiedClientIdentity) async -> TransactionWriterLease? {
        if armed {
            armed=false
            await withCheckedContinuation { continuation in
                released=continuation;entered=true
                for listener in listeners { listener.resume() };listeners=[]
            }
        }
        return TransactionWriterLease(writer:writer,supportsDelete:true)
    }
}
func heldLeasePreviewTests() async throws {
    for prune in [false,true] {
        let h=try await TransactionHarness.make(),gate=HeldLifecycleLease(h.writer)
        let manager=NativeConnectionManager(store:h.store,writers:gate,clock:h.clock,owner:h.owner,credentials:h.credentials,verifier:h.verification,decisions:h.decisions,hooks:h.hooks,discovery:TransactionEmptyDiscovery(),launcherVersion:"2.0.0")
        let plan=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context)
        try await h.approve(plan);await gate.arm()
        let pending=Task { try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:"held-preview",context:h.context) }
        await gate.waitUntilEntered()
        if prune { await h.clock.advance(301);_ = try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context) }
        else { try await manager.cancelPlan(planId:plan.planId,context:h.context) }
        await gate.release()
        do { _ = try await pending.value;Check.that(false,"removed preview must not admit") }
        catch { Check.that(error as? LifecycleFailure == .operationConflict,"cancel/prune across lease returns typed failure rather than trap") }
        let mutations=await h.store.mutationCount,writes=await h.writer.writes,grants=await h.credentials.provisions
        Check.that(mutations==0 && writes==0 && grants==0,"cancel/prune held lease has zero journal/grant/provider effects")
    }
}

actor HeldReservationPersistence: PrivateLifecyclePersistence {
    enum Mode { case storedUnknown,storedWritten,notWrittenUnknown,writeAfterFence,writeAfterFenceUnknown }
    let mode:Mode
    private var version=0,data:Data?,first=true,entered=false
    private var cancellationFences:[String:CancellationFence]=[:]
    private(set) var imageCommittedAfterFence=false
    private var released:CheckedContinuation<Void,Never>?
    private var listeners:[CheckedContinuation<Void,Never>]=[]
    init(_ mode:Mode) { self.mode=mode }
    func read() -> PersistedLifecycleState { PersistedLifecycleState(version:version,data:data,cancellationFences:Array(cancellationFences.values)) }
    func recordCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        if let old=cancellationFences[binding.planId] { return old.binding==binding ? old.state:.conflict }
        cancellationFences[binding.planId]=CancellationFence(binding:binding,state:.confirmed);return .confirmed
    }
    func waitUntilEntered() async { if entered { return };await withCheckedContinuation { listeners.append($0) } }
    func release() { released?.resume();released=nil }
    func compareAndSwap(expectedVersion:Int,data:Data) async throws -> PrivateStateWrite {
        guard version==expectedVersion else { return .conflict }
        if first {
            first=false
            if mode == .storedUnknown || mode == .storedWritten { version+=1;self.data=data }
            await withCheckedContinuation { continuation in
                released=continuation;entered=true;for listener in listeners { listener.resume() };listeners=[]
            }
            if mode == .writeAfterFence || mode == .writeAfterFenceUnknown {
                guard version==expectedVersion else { return .conflict }
                imageCommittedAfterFence = !cancellationFences.isEmpty
                version+=1;self.data=data
            }
            return mode == .storedWritten || mode == .writeAfterFence ? .written(version):.uncertain
        }
        version+=1;self.data=data;return .written(version)
    }
}
func heldReservationCancellationTests() async throws {
    for mode in [HeldReservationPersistence.Mode.storedUnknown,.storedWritten,.notWrittenUnknown,.writeAfterFence,.writeAfterFenceUnknown] {
        let h=try await TransactionHarness.make(),persistence=HeldReservationPersistence(mode)
        let store=try await OwnedLifecycleJournal.open(persistence),manager=NativeConnectionManager(store:store,writers:TransactionTestWriters(writer:h.writer,available:true),clock:h.clock,owner:h.owner,credentials:h.credentials,verifier:h.verification,decisions:h.decisions,hooks:h.hooks,discovery:TransactionEmptyDiscovery(),launcherVersion:"2.0.0")
        let plan=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context);try await h.approve(plan)
        let pending=Task { try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:"cancel-reserve",context:h.context) }
        await persistence.waitUntilEntered()
        let request=try JSONSerialization.data(withJSONObject:["version":1,"requestId":"cancel","method":"cancelPlan","planId":plan.planId])
        let reply=await manager.handle(request,context:h.context)
        try LifecycleWire.validateResponse(reply)
        Check.that(String(decoding:reply,as:UTF8.self).contains("\"canceled\":true"),"only confirmed independent fence acknowledges cancellation")
        await persistence.release()
        _ = try? await pending.value
        let reopened=try await OwnedLifecycleJournal.open(persistence),restarted=gapManager(reopened,h)
        let result=try? await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:"cancel-reserve",context:h.context)
        let writes=await h.writer.writes,grants=await h.credentials.provisions,activations=await h.credentials.activations
        Check.that(writes==0 && grants==0 && activations==0 && result?.phase != .committed,"acknowledged cancel survives unknown initial image write and reopen")
        if mode == .writeAfterFence || mode == .writeAfterFenceUnknown {
            let raced=await persistence.imageCommittedAfterFence,ledger=await persistence.read().cancellationFences
            Check.that(raced && ledger.count==1 && ledger[0].state == .confirmed,"late image CAS cannot erase earlier plan fence")
        }
    }
}

actor FixturePause {
    private var entered=false
    private var continuation:CheckedContinuation<Void,Never>?
    private var listeners:[CheckedContinuation<Void,Never>]=[]
    func hold() async {
        await withCheckedContinuation { continuation in
            self.continuation=continuation;entered=true
            for listener in listeners { listener.resume() };listeners=[]
        }
    }
    func waitUntilEntered() async { if entered { return };await withCheckedContinuation { listeners.append($0) } }
    func release() { continuation?.resume();continuation=nil }
}
actor FenceFixturePersistence: PrivateLifecyclePersistence {
    enum WriteMode { case normal,held,unknown,lostReply }
    private var version=0,data:Data?
    private var ledger:[String:CancellationFence]=[:]
    private var mode:WriteMode
    private var readFailure=false
    private let writeGate=FixturePause(),readGate=FixturePause()
    private var holdReads=false
    private var fenceCompleted=false
    private var completionListeners:[CheckedContinuation<Void,Never>]=[]
    private(set) var fenceWrites=0
    init(_ mode:WriteMode = .normal) { self.mode=mode }
    func setMode(_ mode:WriteMode) { self.mode=mode }
    func failReads(_ value:Bool) { readFailure=value }
    func setHeldReads() { holdReads=true }
    func waitForFence() async { await writeGate.waitUntilEntered() }
    func releaseFence() async {
        await writeGate.release()
        if fenceCompleted { return }
        await withCheckedContinuation { completionListeners.append($0) }
    }
    func releaseReads() async { await readGate.release();holdReads=false }
    func read() throws -> PersistedLifecycleState {
        if readFailure { throw LifecycleFailure.invalidStorage }
        return PersistedLifecycleState(version:version,data:data,cancellationFences:Array(ledger.values))
    }
    func compareAndSwap(expectedVersion:Int,data:Data) -> PrivateStateWrite {
        guard version==expectedVersion else { return .conflict };version+=1;self.data=data;return .written(version)
    }
    func recordCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        if let old=ledger[binding.planId] {
            guard old.binding==binding else { return .conflict }
            if old.state == .confirmed { return .confirmed }
        }
        guard ledger.count<200 || ledger[binding.planId] != nil else { return .uncertain }
        fenceWrites+=1
        if mode == .held { await writeGate.hold() }
        let state:CancellationFenceState=mode == .unknown ? .uncertain:.confirmed
        ledger[binding.planId]=CancellationFence(binding:binding,state:state)
        fenceCompleted=true;for listener in completionListeners { listener.resume() };completionListeners=[]
        return mode == .lostReply ? .uncertain:state
    }
    func readCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        if holdReads { await readGate.hold() }
        if readFailure { return .uncertain }
        guard let fence=ledger[binding.planId] else { return .absent }
        return fence.binding==binding ? fence.state:.conflict
    }
}
func cancelWire(_ plan:ConnectionPlan,_ manager:NativeConnectionManager,_ context:TrustedRequestContext) async throws -> String {
    let data=try JSONSerialization.data(withJSONObject:["version":1,"requestId":"cancel","method":"cancelPlan","planId":plan.planId])
    let response=await manager.handle(data,context:context);try LifecycleWire.validateResponse(response)
    return String(decoding:response,as:UTF8.self)
}
func cancellationFenceTests() async throws {
    // A stalled independent fence never stalls the UI forever or returns success.
    let h=try await TransactionHarness.make(),port=FenceFixturePersistence(.held),pause=FixturePause()
    let store=try await OwnedLifecycleJournal.open(port,fenceBudgetNanoseconds:20000000),manager=gapManager(store,h)
    await h.hooks.set(.backup) { _ in await pause.hold() }
    let plan=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context);try await h.approve(plan)
    let applying=Task { try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:"held-fence",context:h.context) }
    await pause.waitUntilEntered()
    async let first=cancelWire(plan,manager,h.context)
    await port.waitForFence()
    async let second=cancelWire(plan,manager,h.context)
    let replies=try await [first,second]
    let attempts=await port.fenceWrites
    Check.that(replies.allSatisfy { $0.contains("cancellation_unconfirmed") && !$0.contains("\"canceled\":true") } && attempts==1,"held concurrent cancels coalesce and return bounded explicit unconfirmed")
    let pending=try await manager.getOperation(operationId:"held-fence",context:h.context)
    Check.that(pending.phase == .uncertain && pending.reason == .cancellationUnconfirmed,"unconfirmed cancel is not terminal cleanup success")
    await pause.release();_ = try await applying.value
    await port.releaseFence()
    let confirmed=try await cancelWire(plan,manager,h.context)
    Check.that(confirmed.contains("\"canceled\":true"),"late confirmed fence can acknowledge an idempotent retry")
    let noGrants=await h.credentials.provisions,noWrites=await h.writer.writes
    Check.that(noGrants==0 && noWrites==0,"pending cancellation stops new post-backup work")

    // Unknown fence intents survive reopen; a lost confirmation reply is read back.
    for mode in [FenceFixturePersistence.WriteMode.unknown,.lostReply] {
        let h=try await TransactionHarness.make(),port=FenceFixturePersistence(mode),pause=FixturePause()
        let store=try await OwnedLifecycleJournal.open(port,fenceBudgetNanoseconds:20000000),manager=gapManager(store,h)
        await h.hooks.set(.backup) { _ in await pause.hold() }
        let p=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context);try await h.approve(p)
        let work=Task { try await manager.applyChange(planId:p.planId,digest:p.digest,operationId:"unknown-fence",context:h.context) }
        await pause.waitUntilEntered();let reply=try await cancelWire(p,manager,h.context)
        Check.that(reply.contains("cancellation_unconfirmed"),"unknown fence write never claims accepted cancellation")
        let reopened=try await OwnedLifecycleJournal.open(port,fenceBudgetNanoseconds:20000000),restarted=gapManager(reopened,h)
        let projected=try await restarted.getOperation(operationId:"unknown-fence",context:h.context)
        Check.that(projected.phase != .committed,"reopen merges independent unknown/confirmed cancellation intent")
        if mode == .lostReply {
            let retry=try await cancelWire(p,restarted,h.context),count=await port.fenceWrites
            Check.that(retry.contains("\"canceled\":true") && count==1,"confirmed lost reply recovers from ledger without duplicate fence write")
        }
        await pause.release();_ = try await work.value
        let grants=await h.credentials.provisions,writes=await h.writer.writes
        Check.that(grants==0 && writes==0,"unknown cancellation never silently starts new native work")
    }
    // Confirmation accepts cancellation; it does not assert inverse/grant cleanup.
    let active=try await TransactionHarness.make(),activePort=FenceFixturePersistence(),activePause=FixturePause()
    let activeStore=try await OwnedLifecycleJournal.open(activePort),activeManager=gapManager(activeStore,active)
    await active.hooks.set(.manifest) { _ in await activePause.hold() }
    let ap=try await activeManager.planChange(action:.connect,expectedOwnershipRevision:0,context:active.context);try await active.approve(ap)
    let activeWork=Task { try await activeManager.applyChange(planId:ap.planId,digest:ap.digest,operationId:"cancel-applied",context:active.context) }
    await activePause.waitUntilEntered();let accepted=try await cancelWire(ap,activeManager,active.context)
    let cleanup=try await activeManager.getOperation(operationId:"cancel-applied",context:active.context)
    Check.that(accepted.contains("\"canceled\":true") && cleanup.phase == .cleanupPending && cleanup.cleanup.configCompensation == .pending,"accepted fence keeps config/grant/secret cleanup distinct")
    await activePause.release();let terminal=try await activeWork.value
    Check.that(terminal.phase == .rolledBack,"confirmed canceled apply completes bounded inverse cleanup")
    // A ledger-read failure/timeout cannot become an absence proof before dispatch.
    for held in [false,true] {
        let h=try await TransactionHarness.make(),port=FenceFixturePersistence()
        let store=try await OwnedLifecycleJournal.open(port,fenceBudgetNanoseconds:20000000),manager=gapManager(store,h)
        let p=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context);try await h.approve(p)
        if held { await port.setHeldReads() } else { await port.failReads(true) }
        let result=try await manager.applyChange(planId:p.planId,digest:p.digest,operationId:"read-failure",context:h.context)
        let grants=await h.credentials.provisions,writes=await h.writer.writes
        Check.that(result.phase != .committed && grants==0 && writes==0,"unknown/held fresh fence read blocks new effects")
        if held { await port.releaseReads() }
    }
    let observed=try await TransactionHarness.make(),observedPort=FenceFixturePersistence(),observedPause=FixturePause()
    let observedStore=try await OwnedLifecycleJournal.open(observedPort),observedManager=gapManager(observedStore,observed)
    await observed.hooks.set(.backup) { _ in await observedPause.hold() }
    let op=try await observedManager.planChange(action:.connect,expectedOwnershipRevision:0,context:observed.context);try await observed.approve(op)
    let observedWork=Task { try await observedManager.applyChange(planId:op.planId,digest:op.digest,operationId:"external-fence",context:observed.context) }
    await observedPause.waitUntilEntered()
    let binding=await observedStore.record("external-fence")!.cancellationBinding
    _ = await observedPort.recordCancellationFence(binding)
    await observedPause.release();let stopped=try await observedWork.value
    let observedGrants=await observed.credentials.provisions,observedWrites=await observed.writer.writes
    Check.that(stopped.phase == .rolledBack && observedGrants==0 && observedWrites==0,"fresh ledger read sees cancellation committed after journal open")

    let finished=try await TransactionHarness.make()
    let fp=try await finished.plan();try await finished.approve(fp);_ = try await finished.apply(fp)
    let tooLate=try await cancelWire(fp,finished.manager,finished.context)
    let completed=try await finished.manager.getOperation(operationId:"operation-one",context:finished.context)
    Check.that(tooLate.contains("operation_conflict") && !tooLate.contains("\"canceled\":true") && completed.phase == .committed,"finished committed work is never relabeled canceled")

    // Bounded retention refuses capacity, never evicts an acknowledged fence.
    let capacityPort=FenceFixturePersistence(),capacity=try await OwnedLifecycleJournal.open(capacityPort)
    var firstBinding:CancellationPlanBinding?
    for i in 0..<200 {
        let binding=CancellationPlanBinding(planId:"plan-\(i)",digest:String(repeating:"a",count:64),requesterId:"requester-one",installationId:"installation-one",connectionId:"connection-one",clientId:.codexLocal,action:.connect)
        if i==0 { firstBinding=binding };try await capacity.cancelAdmission(binding)
    }
    let overflow=CancellationPlanBinding(planId:"overflow",digest:String(repeating:"a",count:64),requesterId:"requester-one",installationId:"installation-one",connectionId:"connection-one",clientId:.codexLocal,action:.connect)
    do { try await capacity.cancelAdmission(overflow);Check.that(false,"fence capacity must fail closed") }
    catch { Check.that(error as? LifecycleFailure == .cancellationUnconfirmed,"capacity refusal is explicit unconfirmed") }
    let capState=try await OwnedLifecycleJournal.open(capacityPort),kept=await capState.cancellationState(firstBinding!)
    Check.that(kept == .confirmed,"reopen retains acknowledged fence at capacity")
    let other=CancellationPlanBinding(planId:firstBinding!.planId,digest:String(repeating:"b",count:64),requesterId:"requester-one",installationId:"installation-one",connectionId:"connection-one",clientId:.codexLocal,action:.connect)
    do { try await capacity.cancelAdmission(other);Check.that(false,"plan fence cannot be rebound") }
    catch { Check.that(error as? LifecycleFailure == .operationConflict,"fence binds exact plan digest/context") }
}
