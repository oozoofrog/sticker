import Foundation

func codexWriterConformanceTests(fixtures:URL) async throws {
    try await numericProjectionTests(rawFixture:fixtures.deletingLastPathComponent().appendingPathComponent("unsafe-number-response.json"))
    let contract=try JSONSerialization.jsonObject(with:Data(contentsOf:fixtures)) as! [String:Any]
    let user=contract["userLayer"] as! [String:Any]
    let read=try JSONSerialization.data(withJSONObject:["result":["layers":[user],"config":[:]]])
    let outcomes=contract["writeOutcomes"] as! [[String:Any]]
    for outcome in outcomes {
        let recorded=RecordedContractTransport(read:read,write:try JSONSerialization.data(withJSONObject:outcome["response"]!))
        let replayWriter=try fixtureWriter(recorded)
        let result=await replayWriter.applyOwnedPatch(expectedVersion:user["version"] as! String,patch:ExactOwnedPatch(entry:fixtureEntry()),operationId:"recorded-case")
        switch outcome["expected"] as? String {
        case "applied":Check.that(result.isApplied,"reduced recorded success parsed")
        case "conflict":Check.that(result == .conflict,"recorded conflict code parsed")
        case "invalid":Check.that(result == .invalid,"recorded validation code parsed")
        default:throw LifecycleFailure.invalidInput
        }
        let used=await recorded.expectedVersion
        Check.that(used==user["version"] as? String,"recorded write uses user version, not receipt")
    }

    let store=FakeVersionedStore()
    let writer=try fixtureWriter(store)
    let original=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let patch=ExactOwnedPatch(entry:fixtureEntry())
    let created=await writer.applyOwnedPatch(expectedVersion:original.providerVersion,patch:patch,operationId:"create-one")
    Check.that(created.isApplied,"missing-config create succeeds through synthetic CAS")
    let parameters=await store.lastWrite
    Check.that(parameters?.edits.count==1 && parameters?.edits.first?.keyPath=="mcp_servers.sticker","fixed owned leaf is the only edit")
    Check.that(parameters?.reloadUserConfig==false,"write cannot hot reload clients")
    Check.that(parameters?.expectedVersion==original.providerVersion,"read user-layer version used")
    let replay=await writer.applyOwnedPatch(expectedVersion:original.providerVersion,patch:patch,operationId:"create-one")
    Check.that(replay==created,"same local operation replays recorded receipt without write")
    let reused=await writer.applyOwnedPatch(expectedVersion:"different",patch:patch,operationId:"create-one")
    Check.that(reused == .operationConflict,"operation ID cannot authorize different patch or version")
    var entry=fixtureEntry();entry.launcherVersion="2.0.0"
    let updated=await writer.applyOwnedPatch(expectedVersion:"receipt-1",patch:ExactOwnedPatch(entry:entry),operationId:"bad-receipt")
    Check.that(updated == .conflict,"write receipt version is not next user-layer version")
    let fresh=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    Check.that(fresh.ownedEntry==fixtureEntry(),"strict owned leaf projection roundtrips every field")
    let success=await writer.applyOwnedPatch(expectedVersion:fresh.providerVersion,patch:ExactOwnedPatch(entry:entry),operationId:"update-one")
    Check.that(success.isApplied,"fresh layer version updates")
    let foreign=await store.foreignValue
    Check.that(foreign=="foreign-original","unrelated provider config preserved")
    let after=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let restored=await writer.restoreOwnedPatch(expectedCurrentVersion:after.providerVersion,inversePatch:patch,operationId:"rollback-one")
    Check.that(restored.isApplied,"exact inverse update uses fresh CAS")
    let rolled=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    Check.that(rolled.ownedEntry==fixtureEntry(),"inverse restores only owned leaf")
    await store.externalEdit()
    let staleRollback=await writer.restoreOwnedPatch(expectedCurrentVersion:rolled.providerVersion,inversePatch:ExactOwnedPatch(entry:entry),operationId:"rollback-stale")
    Check.that(staleRollback == .conflict,"intervening foreign edit blocks inverse")
    let preserved=await store.foreignValue
    Check.that(preserved=="foreign-new","rollback never overwrites intervening foreign edit")

    let raceStore=FakeVersionedStore()
    let a=try fixtureWriter(raceStore), b=try fixtureWriter(raceStore)
    let version=try await a.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one").providerVersion
    let competingEntry=entry
    async let first=a.applyOwnedPatch(expectedVersion:version,patch:patch,operationId:"race-a")
    async let second=b.applyOwnedPatch(expectedVersion:version,patch:ExactOwnedPatch(entry:competingEntry),operationId:"race-b")
    let results=await [first,second]
    Check.that(results.filter(\.isApplied).count==1 && results.filter { $0 == .conflict }.count==1,"competing writers accept at most one same-version update")

    let repeatedStore=FakeVersionedStore()
    let repeated=try fixtureWriter(repeatedStore)
    let repeatedVersion=try await repeated.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one").providerVersion
    async let repeatedA=repeated.applyOwnedPatch(expectedVersion:repeatedVersion,patch:patch,operationId:"same-inflight")
    async let repeatedB=repeated.applyOwnedPatch(expectedVersion:repeatedVersion,patch:patch,operationId:"same-inflight")
    _ = await [repeatedA,repeatedB]
    let repeatedCount=await repeatedStore.writeCount
    Check.that(repeatedCount==1,"reentrant same operation never dispatches duplicate write")

    let atomicStore=FakeVersionedStore()
    let atomicWriter=try fixtureWriter(atomicStore)
    let atomicBefore=try await atomicWriter.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    let valid=try FixtureLeafCodec().encode(fixtureEntry())
    let invalid:[String:PrivateConfigValue]=["enabled_tools":.number(37)]
    _ = try await atomicStore.batchWrite(CodexBatchRequest(expectedVersion:atomicBefore.providerVersion,filePath:"/fixture/codex/config.toml",edits:[CodexOwnedEdit(value:valid),CodexOwnedEdit(value:invalid)]))
    let atomicAfter=try await atomicWriter.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    Check.that(atomicAfter.providerVersion==atomicBefore.providerVersion && atomicAfter.ownedEntry==nil,"synthetic invalid second edit leaves whole batch unchanged")

    let duringStore=FakeVersionedStore(mode:.externalDuringWrite)
    let during=try fixtureWriter(duringStore)
    let duringVersion=try await during.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one").providerVersion
    let duringResult=await during.applyOwnedPatch(expectedVersion:duringVersion,patch:patch,operationId:"during-write")
    let duringForeign=await duringStore.foreignValue
    Check.that(duringResult == .conflict && duringForeign=="foreign-new","provider CAS preserves edit between fresh read and write")

    let emptyStore=FakeVersionedStore(emptyConfig:true)
    let empty=try fixtureWriter(emptyStore)
    let emptyRead=try await empty.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    Check.that(String(decoding:emptyRead.rawBytes,as:UTF8.self)=="{}","missing-config fixture supplies empty user layer")
    let emptyWrite=await empty.applyOwnedPatch(expectedVersion:emptyRead.providerVersion,patch:patch,operationId:"empty-create")
    Check.that(emptyWrite.isApplied,"empty user config creates owned leaf with its read version")

    for mode in [FakeVersionedStore.Mode.conflict,.invalid,.overridden,.unknownBefore,.unknownAfter,.wrongTarget,.malformed] {
        let failingStore=FakeVersionedStore(mode:mode)
        let failing=try fixtureWriter(failingStore)
        let v=try await failing.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one").providerVersion
        let result=await failing.applyOwnedPatch(expectedVersion:v,patch:patch,operationId:"failure-one")
        switch mode {
        case .conflict:Check.that(result == .conflict,"provider conflict sanitized")
        case .invalid:Check.that(result == .invalid,"validation failure is not partial success")
        case .overridden:Check.that(result.isOverridden,"saved policy override cannot imply connection")
        default:Check.that(result == .uncertain,"unknown/malformed reply is uncertain")
        }
        if mode == .conflict || mode == .invalid {
            let unchanged=try await failing.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
            Check.that(unchanged.providerVersion==v && unchanged.ownedEntry==nil,"known conflict/validation leaves synthetic config unchanged")
        }
        _ = await failing.applyOwnedPatch(expectedVersion:v,patch:patch,operationId:"failure-one")
        let writes=await failingStore.writeCount
        Check.that(writes==1,"failure/unknown never blindly retries")
        let recorded=await failing.readOperation(operationId:"failure-one")
        Check.that(recorded == .recorded(result),"local receipt lookup does not invent RPC")
    }
    for shape in [FakeVersionedStore.ReadShape.duplicateUser,.foreignTarget,.profileLayer,.foreignLeaf,.extraLeafField,.duplicateJSON] {
        let unsafe=try fixtureWriter(FakeVersionedStore(readShape:shape))
        do { _ = try await unsafe.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one");Check.that(false,"unsafe projection must reject") }
        catch { Check.that(true,"unsafe projection rejects without leaking provider data") }
    }
}
