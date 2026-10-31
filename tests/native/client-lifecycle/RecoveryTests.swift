import Foundation

func recoveryTests() async throws {
    try await ownershipRecoveryGapTests()
    for point in [TransactionCheckpoint.backup,.prepared,.providerReturned,.providerReceipt,.manifest,.verification] {
        let h=try await TransactionHarness.make()
        await h.hooks.set(point) { _ in throw TransactionInterruption.simulatedCrash }
        let plan=try await h.plan();try await h.approve(plan)
        _ = try await h.apply(plan)
        if point == .providerReturned {
            let pending=try await h.manager.getOperation(operationId:"operation-one",context:h.context)
            Check.that(pending.phase == .uncertain,"read-only status projects durable unknown apply truthfully")
        }
        let restarted=try await h.restart()
        let recovered=try await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:h.context)
        let writes=await h.writer.writes
        Check.that(recovered.phase == .committed && writes==1,"crash checkpoint resumes without duplicate provider apply")
    }
    for failure in ["expiry","owner","cancel","refusal","verification"] {
        let h=try await TransactionHarness.make()
        switch failure {
        case "expiry":await h.hooks.set(.manifest) { _ in await h.clock.advance(300) }
        case "owner":await h.hooks.set(.manifest) { _ in await h.owner.set(false) }
        case "cancel":await h.hooks.set(.manifest) { operation in try await h.store.requestCancellation(operationId:operation,requesterId:h.context.requesterId,installationId:h.context.identity.installationId) }
        case "refusal":await h.credentials.setActivation(.refused)
        default:await h.verification.setValid(false)
        }
        let plan=try await h.plan();try await h.approve(plan)
        let result=try await h.apply(plan)
        let config=try await h.writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
        Check.that(config.ownedEntry==nil && result.cleanup.configCompensation == .restored,"every known postapply failure compensates config")
        let disposed=await h.credentials.disposals
        if failure=="owner" {
            Check.that(result.phase == .cleanupPending && disposed==0,"owner loss retains secret while revocation lacks authority")
            await h.owner.set(true)
            let restarted=try await h.restart()
            let retried=try await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:h.context)
            Check.that(retried.phase == .rolledBack,"retry resumes only cleanup after expiry/owner loss")
        } else { Check.that(result.phase == .rolledBack && disposed==1,"terminal cleanup disposes new secret only after config+grant receipts") }
        let activations=await h.credentials.activations
        Check.that(activations<=1,"compensation never reactivates a grant")
    }
    for point in [TransactionCheckpoint.compensatedConfig,.compensatedGrant,.compensatedSecret] {
        let h=try await TransactionHarness.make();await h.credentials.setActivation(.refused)
        await h.hooks.set(point) { _ in throw TransactionInterruption.simulatedCrash }
        let plan=try await h.plan();try await h.approve(plan);_ = try await h.apply(plan)
        let restarted=try await h.restart()
        let result=try await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:h.context)
        let restores=await h.writer.restores,disposals=await h.credentials.disposals
        Check.that(result.phase == .rolledBack && restores==1 && disposals==1,"independent cleanup receipts converge across restart")
    }
    let lost=try await TransactionHarness.make()
    await lost.hooks.set(.activationReturned) { _ in throw TransactionInterruption.simulatedCrash }
    let lp=try await lost.plan();try await lost.approve(lp);_ = try await lost.apply(lp)
    await lost.credentials.setActivation(.unknown)
    let waiting=try await (lost.restart()).applyChange(planId:lp.planId,digest:lp.digest,operationId:"operation-one",context:lost.context)
    let waitingDisposals=await lost.credentials.disposals
    Check.that(waiting.phase == .uncertain && waitingDisposals==0,"lost activation must be queried before cleanup")
    await lost.credentials.setActivation(.provisional)
    let cleanup=try await (lost.restart()).applyChange(planId:lp.planId,digest:lp.digest,operationId:"operation-one",context:lost.context)
    let activations=await lost.credentials.activations
    Check.that(cleanup.phase == .rolledBack && activations==1,"known nonactivation compensates without retry activation")

    for point in [TransactionCheckpoint.inverseReturned,.revocationReturned,.secretDisposed] {
        let h=try await TransactionHarness.make();await h.credentials.setActivation(.refused)
        await h.hooks.set(point) { _ in throw TransactionInterruption.simulatedCrash }
        let p=try await h.plan();try await h.approve(p);_ = try await h.apply(p)
        let resumed=try await (h.restart()).applyChange(planId:p.planId,digest:p.digest,operationId:"operation-one",context:h.context)
        let restores=await h.writer.restores,disposals=await h.credentials.disposals
        Check.that(resumed.phase == .rolledBack && restores==1 && disposals==1,"lost cleanup reply resolves receipt before side effect replay")
    }

    let tampered=try await TransactionHarness.make()
    let tp=try await tampered.plan();try await tampered.approve(tp);_ = try await tampered.apply(tp)
    let persisted=await tampered.persistence.read()
    var raw=try JSONSerialization.jsonObject(with:persisted.data!) as! [String:Any]
    var records=raw["records"] as! [String:[String:Any]],record=records["operation-one"]!
    var savedPlan=record["plan"] as! [String:Any],desired=savedPlan["desired"] as! [String:Any]
    desired["launcherVersion"]="9.0.0";savedPlan["desired"]=desired;record["plan"]=savedPlan;records["operation-one"]=record;raw["records"]=records
    _ = try await tampered.persistence.compareAndSwap(expectedVersion:persisted.version,data:JSONSerialization.data(withJSONObject:raw))
    do { _ = try await OwnedLifecycleJournal.open(tampered.persistence);Check.that(false,"mutated private plan must not recover under original digest") }
    catch { Check.that(true,"journal validates admitted digest before recovery") }

    let sample=(await hRecordFixture()).0
    let retention=MemoryLifecyclePersistence()
    let limited=try await OwnedLifecycleJournal.open(retention,limits:LifecycleJournalLimits(backupBytes:64,retainedBackupsPerTarget:3,terminalSummaries:2))
    for i in 0..<5 {
        var record=LifecycleJournalRecord(operationId:"retention-\(i)",requesterId:sample.requesterId,installationId:sample.installationId,connectionId:sample.connectionId,
                                           plan:sample.plan,originalOwnership:nil,createdAt:sample.createdAt.addingTimeInterval(Double(i)))
        record=try await limited.reserve(record,backup:Data(repeating:1,count:8))
        record.phase = .rolledBack;record.finished=true;_ = try await limited.save(record)
    }
    let metrics=await limited.metrics()
    Check.that(metrics.records==2 && metrics.backups==3 && metrics.pinned==0 && metrics.bytes==24,"journal retains only newest three resolved backups and bounded terminal summaries")
    let stale=try await OwnedLifecycleJournal.open(retention)
    var pinned=LifecycleJournalRecord(operationId:"pinned-one",requesterId:sample.requesterId,installationId:sample.installationId,connectionId:sample.connectionId,
                                      plan:sample.plan,originalOwnership:nil,createdAt:sample.createdAt.addingTimeInterval(10))
    pinned=try await limited.reserve(pinned,backup:Data(repeating:1,count:8))
    let pinnedMetrics=await limited.metrics()
    Check.that(pinnedMetrics.backups==4 && pinnedMetrics.pinned==1,"unresolved backup is pinned beyond resolved retention limit")
    do { _ = try await stale.reserve(LifecycleJournalRecord(operationId:"stale-store",requesterId:sample.requesterId,installationId:sample.installationId,connectionId:sample.connectionId,plan:sample.plan,originalOwnership:nil,createdAt:sample.createdAt),backup:Data());Check.that(false,"stale journal store must not overwrite newer image") }
    catch { Check.that(true,"private persistence CAS rejects stale store") }
    let reopened=try await OwnedLifecycleJournal.open(retention)
    let preserved=await reopened.record("pinned-one")
    Check.that(preserved != nil,"private CAS preserves another manager's pending operation")

    let racingPort=MemoryLifecyclePersistence(yielding:true)
    let racing=try await OwnedLifecycleJournal.open(racingPort)
    let queued=try await racing.reserve(LifecycleJournalRecord(operationId:"private-race",requesterId:sample.requesterId,installationId:sample.installationId,connectionId:sample.connectionId,plan:sample.plan,originalOwnership:nil,createdAt:sample.createdAt),backup:Data())
    async let saved=racing.save(queued)
    async let canceled=racing.requestCancellation(operationId:"private-race",requesterId:sample.requesterId,installationId:sample.installationId)
    _ = try await (saved,canceled)
    let canceledRecord=await racing.record("private-race")
    Check.that(canceledRecord?.cancellationRequested==true,"same journal serializes its private CAS writes and preserves cancellation")

    let unknownSave=try await TransactionHarness.make()
    await unknownSave.hooks.set(.prepared) { _ in await unknownSave.persistence.makeNextWriteUncertain() }
    let usp=try await unknownSave.plan();try await unknownSave.approve(usp);_ = try await unknownSave.apply(usp)
    let unresolved=try await (unknownSave.restart()).applyChange(planId:usp.planId,digest:usp.digest,operationId:"operation-one",context:unknownSave.context)
    let noWrite=await unknownSave.writer.writes
    Check.that(unresolved.phase == .uncertain && noWrite==0,"uncertain durable admission is not blindly replayed after restart")

}

func hRecordFixture() async -> (LifecycleJournalRecord,TransactionHarness) {
    do {
        let h=try await TransactionHarness.make(),p=try await h.plan()
        try await h.approve(p);_ = try await h.apply(p)
        return (await h.store.record("operation-one")!,h)
    } catch { Check.that(false,"record fixture");fatalError("unreachable") }
}

// Persist real journal images at the config-restored/ownership boundary, then
// return an unknown result. No manager instrumentation or host filesystem.
actor OwnershipGapPersistence: PrivateLifecyclePersistence {
    enum Gap { case restoredReceipt, ownershipAfterWrite, ownershipBeforeWrite, restoredReceiptCrash, ownershipAfterWriteCrash }
    private var version=0,data:Data?
    private var gap:Gap?
    private var operationId=""
    private var original:OwnershipManifest?
    private(set) var fired=false
    func arm(_ gap:Gap,operationId:String,original:OwnershipManifest?) { self.gap=gap;self.operationId=operationId;self.original=original;fired=false }
    func read() -> PersistedLifecycleState { PersistedLifecycleState(version:version,data:data,cancellationFences:[]) }
    private func ownership(_ data:Data?) throws -> OwnershipManifest? {
        guard let data=data,let raw=try JSONSerialization.jsonObject(with:data) as? [String:Any],let map=raw["ownership"] as? [String:Any],let entry=map["connection-one"] else { return nil }
        return try JSONDecoder().decode(OwnershipManifest.self,from:JSONSerialization.data(withJSONObject:entry))
    }
    func compareAndSwap(expectedVersion:Int,data:Data) async throws -> PrivateStateWrite {
        guard version==expectedVersion else { return .conflict }
        let raw=try JSONSerialization.jsonObject(with:data) as! [String:Any]
        let records=raw["records"] as! [String:[String:Any]]
        let restored=(records[operationId]?["cleanup"] as? [String:Any])?["configCompensation"] as? String == "restored"
        let next=try ownership(data),prior=try ownership(self.data)
        let trigger:Bool
        switch gap {
        case .restoredReceipt,.restoredReceiptCrash:trigger=restored && next != original
        case .ownershipAfterWrite,.ownershipBeforeWrite,.ownershipAfterWriteCrash:trigger=restored && next==original && prior != original
        case nil:trigger=false
        }
        if !fired && trigger {
            fired=true
            if gap != .ownershipBeforeWrite { version+=1;self.data=data }
            if gap == .restoredReceiptCrash || gap == .ownershipAfterWriteCrash { throw TransactionInterruption.simulatedCrash }
            return .uncertain
        }
        version+=1;self.data=data;return .written(version)
    }
}
func gapManager(_ store:OwnedLifecycleJournal,_ h:TransactionHarness,launcher:String="2.0.0") -> NativeConnectionManager {
    NativeConnectionManager(store:store,writers:TransactionTestWriters(writer:h.writer,available:true),clock:h.clock,owner:h.owner,credentials:h.credentials,verifier:h.verification,
                            decisions:h.decisions,hooks:h.hooks,discovery:TransactionEmptyDiscovery(),launcherVersion:launcher)
}
func ownershipRecoveryGapTests() async throws {
    for update in [false,true] {
        for gap in [OwnershipGapPersistence.Gap.restoredReceipt,.ownershipAfterWrite,.ownershipBeforeWrite,.restoredReceiptCrash,.ownershipAfterWriteCrash] {
            let h=try await TransactionHarness.make(),persistence=OwnershipGapPersistence()
            let store=try await OwnedLifecycleJournal.open(persistence)
            let first=gapManager(store,h)
            var original:OwnershipManifest?
            if update {
                let connect=try await first.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context)
                try await h.approve(connect)
                _ = try await first.applyChange(planId:connect.planId,digest:connect.digest,operationId:"operation-one",context:h.context)
                original=try await store.ownership(connectionId:"connection-one")
                await h.verification.setValid(false)
            } else { await h.credentials.setActivation(.refused) }
            let operation=update ? "update-rollback":"operation-one"
            await persistence.arm(gap,operationId:operation,original:original)
            let manager=gapManager(store,h,launcher:update ? "3.0.0":"2.0.0")
            let plan=try await manager.planChange(action:update ? .update:.connect,expectedOwnershipRevision:update ? 1:0,context:h.context)
            try await h.approve(plan)
            _ = try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:operation,context:h.context)
            let reopened=try await OwnedLifecycleJournal.open(persistence),restarted=gapManager(reopened,h,launcher:update ? "3.0.0":"2.0.0")
            let result=try await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:operation,context:h.context)
            let owned=try await reopened.ownership(connectionId:"connection-one"),config=try await h.writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
            let inverseCount=await h.writer.restores,fired=await persistence.fired
            Check.that(fired && result.phase == .rolledBack && inverseCount==1,"ownership-gap restart converges with exactly one inverse")
            Check.that(owned==original,"restored config receipt cannot skip original ownership reconciliation")
            if update {
                let restoredDigest=try config.ownedEntry.map { try EntryFingerprint.digest($0) }
                Check.that(restoredDigest == original?.managedEntryDigest,"Update restores original entry digest and ownership revision")
                _ = try await restarted.planChange(action:.update,expectedOwnershipRevision:1,context:h.context)
            } else {
                Check.that(config.ownedEntry==nil,"Connect inverse retains absent config")
                await h.credentials.setActivation(.active)
                let next=try await restarted.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context)
                try await h.approve(next)
                let connected=try await restarted.applyChange(planId:next.planId,digest:next.digest,operationId:"next-connect",context:h.context)
                Check.that(connected.phase == .committed,"next normal Connect succeeds after ownership gap recovery")
            }
        }
    }
    let h=try await TransactionHarness.make(),persistence=OwnershipGapPersistence()
    let store=try await OwnedLifecycleJournal.open(persistence),manager=gapManager(store,h)
    await persistence.arm(.restoredReceipt,operationId:"operation-one",original:nil)
    await h.credentials.setActivation(.refused)
    let plan=try await manager.planChange(action:.connect,expectedOwnershipRevision:0,context:h.context)
    try await h.approve(plan)
    _ = try await manager.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:h.context)
    let state=await persistence.read()
    var image=try JSONSerialization.jsonObject(with:state.data!) as! [String:Any]
    var ownership=image["ownership"] as! [String:[String:Any]]
    ownership["connection-one"]!["installationId"]="foreign-installation";image["ownership"]=ownership
    _ = try await persistence.compareAndSwap(expectedVersion:state.version,data:JSONSerialization.data(withJSONObject:image))
    let reopened=try await OwnedLifecycleJournal.open(persistence),restarted=gapManager(reopened,h)
    let pending=try await restarted.applyChange(planId:plan.planId,digest:plan.digest,operationId:"operation-one",context:h.context)
    let preserved=try await reopened.ownership(connectionId:"connection-one"),record=await reopened.record("operation-one")
    let disposals=await h.credentials.disposals
    Check.that(pending.phase == .cleanupPending && pending.reason == .ownedConflict && record?.finished==false,"foreign ownership blocks terminal rollback after config restoration")
    Check.that(preserved?.installationId=="foreign-installation" && disposals==0 && pending.cleanup.secretCleanup == .retained,"foreign ownership and recovery secret are retained")
    Check.that(pending.cleanup.newGrantCleanup == .revoked,"grant revocation converges independently of ownership conflict")
}
