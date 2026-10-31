import Foundation

// Synthetic provider model, not evidence about any installed runtime. No filesystem/process.
actor FakeVersionedStore: CodexConfigTransport {
    enum Mode { case normal, conflict, invalid, overridden, externalDuringWrite, unknownBefore, unknownAfter, wrongTarget, malformed }
    enum ReadShape { case normal, duplicateUser, foreignTarget, profileLayer, foreignLeaf, extraLeafField, duplicateJSON }
    let mode:Mode
    let readShape:ReadShape
    let emptyConfig:Bool
    private var revision=0
    private var leaf:[String:PrivateConfigValue]?
    private(set) var foreignValue="foreign-original"
    private(set) var writeCount=0
    private(set) var lastWrite:CodexBatchRequest?
    init(mode:Mode = .normal,readShape:ReadShape = .normal,emptyConfig:Bool=false) { self.mode=mode;self.readShape=readShape;self.emptyConfig=emptyConfig }
    func externalEdit() { revision+=1;foreignValue="foreign-new" }
    func read(_ request:CodexReadRequest) async throws -> Data {
        if readShape == .duplicateJSON { return Data("{\"result\":{},\"result\":{}}".utf8) }
        var config:[String:Any]=["model":foreignValue,"mcp_servers":["other":["command":"foreign-command"]]]
        if emptyConfig && revision==0 { config=[:] }
        var current=leaf
        if readShape == .foreignLeaf { current=["command":.string("foreign-command")] }
        if readShape == .extraLeafField { current=try FixtureLeafCodec().encode(fixtureEntry());current?["dropped"] = .string("must-preserve") }
        if let entry=current { var servers=config["mcp_servers"] as! [String:Any];servers["sticker"]=try entry.mapValues { try $0.json() };config["mcp_servers"]=servers }
        var name:[String:Any]=["type":"user","file":readShape == .foreignTarget ? "/fixture/foreign/config.toml":"/fixture/codex/config.toml","profile":NSNull()]
        if readShape == .profileLayer { name["profile"]="other-profile" }
        let user:[String:Any]=["name":name,"version":"layer-\(revision)","config":config]
        var layers=[user]
        if readShape == .duplicateUser { layers.append(user) }
        // Effective values intentionally differ: only user layer is writable ownership.
        return try json(["result":["config":["model":"effective-policy-model"],"layers":layers,"origins":[:]]])
    }
    func batchWrite(_ request:CodexBatchRequest) async throws -> Data {
        writeCount+=1;lastWrite=request
        if mode == .externalDuringWrite { externalEdit() }
        guard request.expectedVersion=="layer-\(revision)",mode != .conflict else { return try failure("configVersionConflict") }
        // Validate the WHOLE synthetic batch before mutation.
        guard !request.edits.isEmpty,request.edits.allSatisfy({ (try? FixtureLeafCodec().decode($0.value)) != nil }),mode != .invalid else { return try failure("configValidationError") }
        if mode == .unknownBefore { throw LifecycleFailure.configAmbiguous }
        leaf=request.edits.last!.value;revision+=1
        if mode == .unknownAfter { throw LifecycleFailure.configAmbiguous }
        if mode == .malformed { return Data("{\"result\":{\"status\":\"unexpected\"}}".utf8) }
        return try json(["result":["status":mode == .overridden ? "okOverridden":"ok","version":"receipt-\(revision)","filePath":mode == .wrongTarget ? "/fixture/foreign/config.toml":"/fixture/codex/config.toml","overriddenMetadata":NSNull()]])
    }
    private func failure(_ kind:String) throws -> Data {
        try json(["error":["code":-32600,"message":"synthetic private failure","data":["config_write_error_code":kind]]])
    }
    private func json(_ object:[String:Any]) throws -> Data { try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys]) }
}
// Only a fixture wire format. This is deliberately NOT a production Codex launcher
// or a claim that fixture_approvals is a supported Codex field.
struct FixtureLeafCodec: CodexOwnedLeafCodec {
    func encode(_ entry:OwnedLaunchEntry) throws -> [String:PrivateConfigValue] {
        _ = try entry.canonicalObject()
        var object:[String:PrivateConfigValue]=[
            "command":.string("/fixture/StickerLauncher"),
            "args":.array([.string(entry.installationId),.string(entry.connectionId),.string(entry.launcherVersion)]),
            "disabled_tools":.array(entry.disabledTools.map { .string($0) }),
            "fixture_approvals":.object(entry.toolApprovals.mapValues { .string($0) }),
            "fixture_unmanaged":.object(entry.unmanagedFields),
        ]
        if let enabled=entry.enabledTools { object["enabled_tools"] = .array(enabled.map { .string($0) }) }
        return object
    }
    func decode(_ value:[String:PrivateConfigValue]) throws -> OwnedLaunchEntry {
        guard value["command"] == .string("/fixture/StickerLauncher"),
              case let .array(args)?=value["args"],args.count==3,
              case let .string(installation)=args[0],case let .string(connection)=args[1],case let .string(version)=args[2],
              case let .object(approvals)?=value["fixture_approvals"],case let .object(unmanaged)?=value["fixture_unmanaged"] else { throw LifecycleFailure.ownedConflict }
        func strings(_ value:PrivateConfigValue?) throws -> [String] {
            guard case let .array(items)?=value else { throw LifecycleFailure.configAmbiguous }
            return try items.map { item in guard case let .string(v)=item else { throw LifecycleFailure.configAmbiguous };return v }
        }
        let rights=try approvals.mapValues { item in guard case let .string(v)=item else { throw LifecycleFailure.configAmbiguous };return v }
        return OwnedLaunchEntry(installationId:installation,connectionId:connection,launcherVersion:version,
                                enabledTools:try value["enabled_tools"].map { try strings($0) },disabledTools:try strings(value["disabled_tools"]),
                                toolApprovals:rights,unmanagedFields:unmanaged)
    }
}
func fixtureWriter(_ transport:any CodexConfigTransport) throws -> CodexAppServerWriter {
    CodexAppServerWriter(transport:transport,codec:FixtureLeafCodec(),target:try CodexUserTarget(configFile:"/fixture/codex/config.toml",installationId:"installation-one",connectionId:"connection-one"))
}

actor RecordedContractTransport: CodexConfigTransport {
    let readResponse:Data
    let writeResponse:Data
    private(set) var expectedVersion:String?
    private(set) var lastWrite:CodexBatchRequest?
    init(read:Data,write:Data) { readResponse=read;writeResponse=write }
    func read(_ request:CodexReadRequest) async throws -> Data { readResponse }
    func batchWrite(_ request:CodexBatchRequest) async throws -> Data { expectedVersion=request.expectedVersion;lastWrite=request;return writeResponse }
}
