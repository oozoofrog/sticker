import Foundation

func writerGateTests() async throws {
    let registry=WriterRegistry()
    for client in [ClientId.codexLocal,.claudeCodeLocal,.claudeDesktop] {
        for version in ["0.165.0-alpha.1.2","0.166.0-alpha.5.1","unknown"] {
            let identity=VerifiedClientIdentity(clientId:client,installationId:"installation-one",version:version)
            Check.that(registry.writer(for:identity)==nil,"uncertified version has no writer")
        }
    }
    let store=FakeVersionedStore()
    let writer=try fixtureWriter(store)
    let absent=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one")
    Check.that(absent.ownedEntry==nil,"missing-config user layer projects absent leaf")
    let removed=await writer.applyOwnedPatch(expectedVersion:absent.providerVersion,patch:ExactOwnedPatch(entry:nil),operationId:"remove-one")
    Check.that(removed == .unavailable,"unproven deletion is unavailable")
    let noWrites=await store.writeCount
    Check.that(noWrites==0,"unsupported deletion sends no write RPC")
    let unknown=await writer.readOperation(operationId:"not-seen")
    Check.that(unknown == .unknown,"no invented provider operation query")
}

func numericProjectionTests(rawFixture:URL) async throws {
    let raw=try String(contentsOf:rawFixture,encoding:.utf8)
    Check.that(raw.contains("9007199254740993"),"unsafe integer fixture retains exact raw lexeme")
    let cases:[(String,Bool)]=[
        ("9007199254740993",false),("-9007199254740993",false),
        ("0.12345678901234567890123456789",false),
        ("0.1000000000000000055511151231257827021181583404541015625",false),
        ("1e-400",false),("1e400",false),
        ("9007199254740991",true),("9007199254740992",true),("9007199254740994",true),
        // Foundation serializes Double(0.1) as 0.10000000000000001 here.
        ("0.1",false),("0.5",true),("0.125",true),("1.25e2",true),("1.2500",true),("0",true),
    ]
    for (token,supported) in cases {
        // String substitution happens before parsing, never via an already-rounded Double.
        let response=Data(raw.replacingOccurrences(of:"9007199254740993",with:token).utf8)
        let transport=RecordedContractTransport(read:response,write:Data(#"{"result":{"status":"ok","version":"receipt-1","filePath":"/fixture/codex/config.toml"}}"#.utf8))
        let writer=try fixtureWriter(transport)
        var snapshot:PrivateConfigSnapshot?
        do { snapshot=try await writer.readOwnedTarget(profileId:.codexLocal,connectionId:"connection-one") }
        catch { Check.that(!supported,"supported numeric boundary must not reject: \(token)") }
        if let snapshot=snapshot {
            var entry=snapshot.ownedEntry!;entry.launcherVersion="2.0.0"
            let result=await writer.applyOwnedPatch(expectedVersion:snapshot.providerVersion,patch:ExactOwnedPatch(entry:entry),operationId:"numeric-case")
            Check.that(supported,"unsafe raw numeric projection must reject before apply")
            Check.that(result.isApplied,"supported numeric projection remains writable")
            let sent=await transport.lastWrite?.edits.first?.value
            let decoded=try sent.map { try FixtureLeafCodec().decode($0) }
            Check.that(decoded?.unmanagedFields==snapshot.ownedEntry?.unmanagedFields,"supported numeric value survives outgoing owned leaf")
        } else {
            let result=await writer.applyOwnedPatch(expectedVersion:"layer-0",patch:ExactOwnedPatch(entry:fixtureEntry()),operationId:"numeric-case")
            let sent=await transport.lastWrite
            Check.that(result == .unavailable && sent==nil,"unsafe numeric response fails closed with zero write requests")
        }
    }
}
