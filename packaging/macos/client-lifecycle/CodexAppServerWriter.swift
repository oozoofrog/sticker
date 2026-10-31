import Foundation
import CoreFoundation

// Fixed typed methods: neither public callers nor transports supply arbitrary RPCs/edits.
struct CodexReadRequest: Equatable { let includeLayers=true }
struct CodexOwnedEdit {
    let value:[String:PrivateConfigValue]
    let keyPath="mcp_servers.sticker"
    let mergeStrategy="replace"
}
struct CodexBatchRequest {
    let expectedVersion:String
    let filePath:String
    let edits:[CodexOwnedEdit]
    let reloadUserConfig=false
}
// Future concrete transport must initialize the verified session and correlate
// each bounded JSON-RPC reply to its request. No executable transport is supplied.
protocol CodexConfigTransport: Sendable {
    func read(_ request:CodexReadRequest) async throws -> Data
    func batchWrite(_ request:CodexBatchRequest) async throws -> Data
}
// Only trusted native composition may provide this future certified launcher codec.
// The current increment supplies NO production launcher or transport implementation.
protocol CodexOwnedLeafCodec: Sendable {
    func encode(_ entry:OwnedLaunchEntry) throws -> [String:PrivateConfigValue]
    func decode(_ value:[String:PrivateConfigValue]) throws -> OwnedLaunchEntry
}
struct CodexUserTarget {
    let configFile:String
    let installationId:String
    let connectionId:String
    init(configFile:String,installationId:String,connectionId:String) throws {
        try WireShape.identifier(installationId);try WireShape.identifier(connectionId)
        guard configFile.hasPrefix("/"),configFile.utf8.count<=4096,
              !configFile.contains("\0"),!configFile.contains("\n"),
              URL(fileURLWithPath:configFile).standardizedFileURL.path==configFile,
              URL(fileURLWithPath:configFile).lastPathComponent=="config.toml" else { throw LifecycleFailure.invalidInput }
        self.configFile=configFile;self.installationId=installationId;self.connectionId=connectionId
    }
}
actor CodexAppServerWriter: VersionedWriter {
    private let transport:any CodexConfigTransport
    private let codec:any CodexOwnedLeafCodec
    private let target:CodexUserTarget
    private struct Operation { let digest:String;var result:ProviderWriteResult }
    private var operations:[String:Operation]=[:]
    init(transport:any CodexConfigTransport,codec:any CodexOwnedLeafCodec,target:CodexUserTarget) {
        self.transport=transport;self.codec=codec;self.target=target
    }
    func readOwnedTarget(profileId:ClientId,connectionId:String) async throws -> PrivateConfigSnapshot {
        guard profileId == .codexLocal,connectionId==target.connectionId else { throw LifecycleFailure.unsupportedProfile }
        do { return try project(await transport.read(CodexReadRequest())) }
        catch let error as LifecycleFailure { throw error }
        catch { throw LifecycleFailure.configAmbiguous }
    }
    func applyOwnedPatch(expectedVersion:String,patch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult {
        await write(expectedVersion:expectedVersion,patch:patch,operationId:operationId,inverse:false)
    }
    func restoreOwnedPatch(expectedCurrentVersion:String,inversePatch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult {
        await write(expectedVersion:expectedCurrentVersion,patch:inversePatch,operationId:operationId,inverse:true)
    }
    func readOperation(operationId:String) async -> ProviderOperationState {
        // No provider operation-query RPC exists in the supplied schema. This is a
        // bounded in-memory receipt only; later durable journal recovery owns restart.
        operations[operationId].map { .recorded($0.result) } ?? .unknown
    }
    private func write(expectedVersion:String,patch:ExactOwnedPatch,operationId:String,inverse:Bool) async -> ProviderWriteResult {
        let digest:String
        let value:[String:PrivateConfigValue]
        do {
            try WireShape.identifier(operationId);try WireShape.opaqueVersion(expectedVersion)
            // Null/delete semantics are NOT established. Never replace the parent map.
            guard let entry=patch.entry else { return .unavailable }
            try checkIdentity(entry)
            value=try codec.encode(entry)
            guard try codec.decode(value)==entry else { return .invalid }
            digest=try CanonicalFingerprint.digest(["version":expectedVersion,"entry":entry.canonicalObject(),"inverse":inverse])
        } catch { return .invalid }
        if let prior=operations[operationId] { return prior.digest==digest ? prior.result:.operationConflict }
        guard operations.count<100 else { return .unavailable }
        // Reserve before suspension; unknown outcome/reentrant calls cannot trigger replay.
        operations[operationId]=Operation(digest:digest,result:.uncertain)
        let result:ProviderWriteResult
        do {
            let fresh=try await readOwnedTarget(profileId:.codexLocal,connectionId:target.connectionId)
            if fresh.providerVersion != expectedVersion { result = .conflict }
            else {
                let request=CodexBatchRequest(expectedVersion:fresh.providerVersion,filePath:target.configFile,edits:[CodexOwnedEdit(value:value)])
                // From this point a thrown/lost/malformed reply may follow a real write.
                do { result=try parseWrite(await transport.batchWrite(request)) }
                catch { result = .uncertain }
            }
        } catch { result = .unavailable }
        operations[operationId]=Operation(digest:digest,result:result)
        return result
    }
    private func checkIdentity(_ entry:OwnedLaunchEntry) throws {
        guard entry.installationId==target.installationId,entry.connectionId==target.connectionId else { throw LifecycleFailure.ownedConflict }
        _ = try entry.canonicalObject()
    }
    private func project(_ data:Data) throws -> PrivateConfigSnapshot {
        let result=try response(data)
        guard let layers=result["layers"] as? [[String:Any]],layers.count<=32 else { throw LifecycleFailure.configAmbiguous }
        let users=layers.filter { ($0["name"] as? [String:Any])?["type"] as? String == "user" }
        guard users.count==1,let layer=users.first,let name=layer["name"] as? [String:Any],
              name["file"] as? String==target.configFile,
              name["profile"]==nil || name["profile"] is NSNull,
              let version=layer["version"] as? String,let config=layer["config"] as? [String:Any] else { throw LifecycleFailure.configAmbiguous }
        try WireShape.opaqueVersion(version)
        var entry:OwnedLaunchEntry?
        if let servers=config["mcp_servers"] {
            guard let map=servers as? [String:Any] else { throw LifecycleFailure.configAmbiguous }
            if let raw=map["sticker"] {
                guard let object=raw as? [String:Any] else { throw LifecycleFailure.ownedConflict }
                let value=try object.mapValues { try Self.value($0) }
                let decoded=try codec.decode(value)
                try checkIdentity(decoded)
                // Every leaf field must survive the codec. Silent loss is not ownership.
                guard try codec.encode(decoded)==value else { throw LifecycleFailure.ownedConflict }
                entry=decoded
            }
        }
        // This is a private JSON projection, NOT original TOML bytes or a file backup.
        // Future recovery must use inverse owned patches, never restore these bytes.
        let bytes=try JSONSerialization.data(withJSONObject:config,options:[.sortedKeys])
        guard bytes.count<=2097152 else { throw LifecycleFailure.configTooLarge }
        return PrivateConfigSnapshot(clientId:.codexLocal,installationId:target.installationId,connectionId:target.connectionId,
                                     targetKind:.codexUser,providerVersion:version,rawBytes:bytes,ownedEntry:entry,parseStatus:.valid)
    }
    private func parseWrite(_ data:Data) throws -> ProviderWriteResult {
        let object=try json(data)
        if let error=object["error"] as? [String:Any] {
            guard object["result"]==nil,let code=error["code"] as? Int,code == -32600,
                  let detail=error["data"] as? [String:Any],let kind=detail["config_write_error_code"] as? String else { return .uncertain }
            if kind=="configVersionConflict" { return .conflict }
            if kind=="configValidationError" { return .invalid }
            return .uncertain
        }
        let result=try response(data)
        guard let status=result["status"] as? String,["ok","okOverridden"].contains(status),
              result["filePath"] as? String==target.configFile,let version=result["version"] as? String else { return .uncertain }
        try WireShape.opaqueVersion(version)
        return .applied(ProviderWriteReceipt(version:version,overridden:status=="okOverridden"))
    }
    private func response(_ data:Data) throws -> [String:Any] {
        let object=try json(data)
        guard object["error"]==nil,let result=object["result"] as? [String:Any] else { throw LifecycleFailure.configAmbiguous }
        return result
    }
    private func json(_ data:Data) throws -> [String:Any] {
        guard data.count<=2097152 else { throw LifecycleFailure.configTooLarge }
        try StrictJSONKeys.validate(data)
        try ProviderNumberPrecision.validate(data)
        guard let object=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw LifecycleFailure.configAmbiguous }
        return object
    }
    private static func value(_ value:Any,depth:Int=0) throws -> PrivateConfigValue {
        guard depth<=16 else { throw LifecycleFailure.configAmbiguous }
        if value is NSNull { return .null }
        if let number=value as? NSNumber {
            if CFGetTypeID(number)==CFBooleanGetTypeID() { return .boolean(number.boolValue) }
            guard number.doubleValue.isFinite else { throw LifecycleFailure.configAmbiguous };return .number(number.doubleValue)
        }
        if let string=value as? String { return .string(string) }
        if let array=value as? [Any] { return .array(try array.map { try Self.value($0,depth:depth+1) }) }
        if let object=value as? [String:Any] { return .object(try object.mapValues { try Self.value($0,depth:depth+1) }) }
        throw LifecycleFailure.configAmbiguous
    }
}

// PrivateConfigValue stores Double. Check original JSON lexemes BEFORE Foundation
// or the codec can round them. Compare decimal values after the exact same
// Foundation -> Double -> Foundation JSON contract, not Double equality.
// Future concrete transports must certify their exact encoding separately.
// This conservative bound applies to the whole private response; unsupported
// precision fails closed rather than silently changing even an unmanaged field.
private enum ProviderNumberPrecision {
    static func validate(_ data:Data) throws {
        let bytes=Array(data)
        var index=0
        while index<bytes.count {
            if bytes[index]==34 {
                index+=1
                while index<bytes.count {
                    if bytes[index]==92 { index+=2 }
                    else if bytes[index]==34 { index+=1;break }
                    else { index+=1 }
                }
            } else if bytes[index]==45 || (48...57).contains(bytes[index]) {
                let start=index
                while index<bytes.count && ([43,45,46,69,101].contains(bytes[index]) || (48...57).contains(bytes[index])) { index+=1 }
                let token=String(decoding:bytes[start..<index],as:UTF8.self)
                guard token.utf8.count<=256,
                      let number=try JSONSerialization.jsonObject(with:Data(token.utf8),options:[.fragmentsAllowed]) as? NSNumber,
                      number.doubleValue.isFinite else { throw LifecycleFailure.configAmbiguous }
                let outgoing=try JSONSerialization.data(withJSONObject:number.doubleValue,options:[.fragmentsAllowed])
                guard try normalized(token)==normalized(String(decoding:outgoing,as:UTF8.self)) else { throw LifecycleFailure.configAmbiguous }
            } else { index+=1 }
        }
    }
    private static func normalized(_ token:String) throws -> String {
        guard token.range(of:#"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"#,options:.regularExpression) != nil else { throw LifecycleFailure.configAmbiguous }
        let negative=token.hasPrefix("-")
        let unsigned=negative ? String(token.dropFirst()):token
        let parts=unsigned.lowercased().split(separator:"e",omittingEmptySubsequences:false)
        var exponent=0
        if parts.count==2 {
            guard let value=Int(parts[1]),(-10000...10000).contains(value) else { throw LifecycleFailure.configAmbiguous }
            exponent=value
        }
        let mantissa=parts[0].split(separator:".",omittingEmptySubsequences:false)
        if mantissa.count==2 { exponent-=mantissa[1].count }
        var digits=Array(mantissa.joined().utf8.drop(while: { $0==48 }))
        if digits.isEmpty { return negative ? "-0":"0" }
        while digits.last==48 { digits.removeLast();exponent+=1 }
        return (negative ? "-":"")+String(decoding:digits,as:UTF8.self)+"e"+String(exponent)
    }
}
