import Foundation
import CoreFoundation

enum ClientId: String, Codable, CaseIterable { case codexLocal = "codex-local", claudeCodeLocal = "claude-code-local", claudeDesktop = "claude-desktop" }
enum ConnectionAction: String, Codable { case connect, update, remove }
enum Availability: String, Codable {
    case ready, notDetected = "not_detected", ambiguousInstallation = "ambiguous_installation"
    case unsupportedProfile = "unsupported_profile", providerManaged = "provider_managed", policyBlocked = "policy_blocked"
    case credentialUnavailable = "credential_unavailable", permissionRequired = "permission_required"
    case writerUnavailable = "writer_unavailable", ownedConflict = "owned_conflict", companionUnavailable = "companion_unavailable"
}
enum RegistrationState: String, Codable { case unknown, absent, owned, modifiedOwned = "modified_owned", unmanagedConflict = "unmanaged_conflict" }
enum CredentialState: String, Codable { case available, grantRequired = "grant_required", provisional, expired, unverified }
enum ProtocolCheck: String, Codable { case notChecked = "not_checked", initialized, toolsVerified = "tools_verified", failed }
enum ClientLoad: String, Codable { case unknown, refreshRequired = "refresh_required", verified, policyBlocked = "policy_blocked" }
enum MetadataReason: String, Codable {
    case notInCheckedLocations = "not_in_checked_locations", multipleInstallations = "multiple_installations"
    case invalidMetadata = "invalid_metadata", candidateLimit = "candidate_limit", writerNotCertified = "writer_not_certified"
    case providerManaged = "provider_managed", metadataUnavailable = "metadata_unavailable"
}
enum LifecycleFailure: String, Error, Codable {
    case invalidInput = "invalid_input", messageTooLarge = "message_too_large", ownedConflict = "owned_conflict"
    case writerUnavailable = "writer_unavailable", operationConflict = "operation_conflict", permissionRequired = "permission_required"
    case planExpired = "plan_expired", planCapacity = "plan_capacity", unsafeStorage = "unsafe_storage", invalidStorage = "invalid_storage"
    case cancellationUnconfirmed = "cancellation_unconfirmed"
    case projectRequired = "project_required", unsupportedProfile = "unsupported_profile", configTooLarge = "config_too_large", configAmbiguous = "config_ambiguous"
}
enum OperationPhase: String, Codable {
    case planned, awaitingNativeConfirmation = "awaiting_native_confirmation", provisioning, grantProvisional = "grant_provisional"
    case prepared, providerApplied = "provider_applied", activating, cleanupPending = "cleanup_pending"
    case verifying, committed, rolledBack = "rolled_back", canceled, conflict, uncertain
}
enum ConfigCompensation: String, Codable { case notNeeded = "not_needed", pending, restored, conflict, uncertain }
enum NewGrantCleanup: String, Codable { case notCreated = "not_created", pending, revoked, confirmedExpired = "confirmed_expired", uncertain }
enum SecretCleanup: String, Codable { case notOwned = "not_owned", retained, deleted }
struct CleanupReceipts: Codable, Equatable {
    let configCompensation: ConfigCompensation
    let newGrantCleanup: NewGrantCleanup
    let secretCleanup: SecretCleanup
}
struct ClientSnapshot: Codable, Equatable {
    let clientId: ClientId
    let displayName: String
    let safeVersion: String?
    let availability: Availability
    let registration: RegistrationState
    let ownershipRevision: Int
    let allowedActions: [ConnectionAction]
    let credentialState: CredentialState
    let protocolCheck: ProtocolCheck
    let clientLoad: ClientLoad
    let checkedAt: String
    let reasonCodes: [MetadataReason]
}
struct GrantSummary: Codable, Equatable { let projectIds: [String]; let canWrite: Bool }
struct ManagedChange: Codable, Equatable {
    enum Field: String, Codable { case launcher, toolVisibility = "tool_visibility", registration }
    enum Change: String, Codable { case add, update, remove }
    let field: Field
    let change: Change
}
struct RetainedFilterSummary: Codable, Equatable {
    let hasCustomFilters: Bool
    let enabledToolsCount: Int
    let disabledToolsCount: Int
    let approvalsPreserved: Bool
}
struct ConnectionPlan: Codable, Equatable {
    let kind: String
    let planId: String
    let action: ConnectionAction
    let clientId: ClientId
    let targetSummary: String
    let rights: GrantSummary
    let changes: [ManagedChange]
    let retainedFilters: RetainedFilterSummary
    let expectedOwnershipRevision: Int
    let expectedProviderVersion: String
    let digest: String
    let expiresAt: String
    let requiredIntent: String
    let verificationExpectation: String
}
struct OperationSnapshot: Codable, Equatable {
    let kind: String
    let operationId: String
    let clientId: ClientId
    let action: ConnectionAction
    let phase: OperationPhase
    let cleanup: CleanupReceipts
    let checkedAt: String
    let reason: LifecycleFailure?
}
enum LifecycleMethod: String, Codable {
    case detectClients, planChange, applyChange, getOperation, verifyConnection, planRollback, cancelPlan
}
struct NativeLifecycleRequest: Codable, Equatable {
    let version: Int
    let requestId: String
    let method: LifecycleMethod
    let refreshMetadata: Bool?
    let clientId: ClientId?
    let action: ConnectionAction?
    let expectedOwnershipRevision: Int?
    let planId: String?
    let digest: String?
    let operationId: String?
    let appliedOperationId: String?
}

// Validation precedes Codable decoding: synthesized Codable alone accepts unknown keys.
enum LifecycleWire {
    static func decodeRequest(_ data: Data) throws -> NativeLifecycleRequest {
        let o = try WireShape.root(data)
        try WireShape.literal(o["version"], 1)
        try WireShape.identifier(o["requestId"])
        guard let raw = o["method"] as? String, let method = LifecycleMethod(rawValue: raw) else { throw LifecycleFailure.invalidInput }
        let common = ["version", "requestId", "method"]
        let fields: [String]
        switch method {
        case .detectClients: fields = ["refreshMetadata"]; try WireShape.boolean(o["refreshMetadata"])
        case .planChange:
            fields = ["clientId", "action", "expectedOwnershipRevision"]
            try WireShape.enumeration(o["clientId"], ClientId.self); try WireShape.enumeration(o["action"], ConnectionAction.self)
            try WireShape.integer(o["expectedOwnershipRevision"])
        case .applyChange:
            fields = ["planId", "digest", "operationId"]
            try WireShape.identifier(o["planId"]); try WireShape.hash(o["digest"]); try WireShape.identifier(o["operationId"])
        case .getOperation: fields = ["operationId"]; try WireShape.identifier(o["operationId"])
        case .verifyConnection:
            fields = ["clientId", "expectedOwnershipRevision"]
            try WireShape.enumeration(o["clientId"], ClientId.self); try WireShape.integer(o["expectedOwnershipRevision"])
        case .planRollback:
            fields = ["appliedOperationId", "expectedOwnershipRevision"]
            try WireShape.identifier(o["appliedOperationId"]); try WireShape.integer(o["expectedOwnershipRevision"])
        case .cancelPlan: fields = ["planId"]; try WireShape.identifier(o["planId"])
        }
        try WireShape.keys(o, common + fields)
        return try JSONDecoder().decode(NativeLifecycleRequest.self, from: data)
    }
    static func validateResponse(_ data: Data) throws {
        let o = try WireShape.root(data)
        try WireShape.literal(o["version"], 1); try WireShape.identifier(o["requestId"])
        if let error = o["error"] {
            try WireShape.keys(o, ["version","requestId","error"])
            let e = try WireShape.object(error); try WireShape.keys(e, ["code"])
            try WireShape.enumeration(e["code"], LifecycleFailure.self)
            return
        }
        try WireShape.keys(o, ["version","requestId","method","result"])
        guard let method = (o["method"] as? String).flatMap(LifecycleMethod.init(rawValue:)) else { throw LifecycleFailure.invalidInput }
        switch method {
        case .detectClients:
            let rows = try WireShape.array(o["result"], maximum: 3)
            var ids = Set<String>()
            for row in rows {
                let value = try WireShape.object(row); try validateSnapshot(value)
                guard let id = value["clientId"] as? String, ids.insert(id).inserted else { throw LifecycleFailure.invalidInput }
            }
        case .planChange, .planRollback:
            let value = try WireShape.object(o["result"])
            if value["kind"] as? String == "unavailable" {
                try WireShape.keys(value, ["kind","reason"]); try WireShape.enumeration(value["reason"], Availability.self)
            } else { try validatePlan(value) }
        case .applyChange, .getOperation: try validateOperation(WireShape.object(o["result"]))
        case .verifyConnection: try validateVerification(WireShape.object(o["result"]))
        case .cancelPlan:
            let value = try WireShape.object(o["result"]); try WireShape.keys(value, ["canceled"])
            guard (value["canceled"] as? NSNumber)?.boolValue == true else { throw LifecycleFailure.invalidInput }
            try WireShape.boolean(value["canceled"])
        }
    }
    static func validateSnapshot(_ o: [String:Any]) throws {
        try WireShape.keys(o, ["clientId","displayName","availability","registration","ownershipRevision","allowedActions","credentialState","protocolCheck","clientLoad","checkedAt","reasonCodes"], optional:["safeVersion"])
        try WireShape.enumeration(o["clientId"], ClientId.self); try WireShape.text(o["displayName"])
        if let version = o["safeVersion"] { try WireShape.version(version) }
        try WireShape.enumeration(o["availability"], Availability.self); try WireShape.enumeration(o["registration"], RegistrationState.self)
        try WireShape.integer(o["ownershipRevision"])
        let actions = try WireShape.array(o["allowedActions"], maximum:3)
        var distinct = Set<String>()
        for a in actions {
            try WireShape.enumeration(a, ConnectionAction.self)
            guard let raw = a as? String, distinct.insert(raw).inserted else { throw LifecycleFailure.invalidInput }
        }
        try WireShape.enumeration(o["credentialState"], CredentialState.self)
        try WireShape.enumeration(o["protocolCheck"], ProtocolCheck.self); try WireShape.enumeration(o["clientLoad"], ClientLoad.self)
        try WireShape.stamp(o["checkedAt"])
        for reason in try WireShape.array(o["reasonCodes"], maximum:8) { try WireShape.enumeration(reason, MetadataReason.self) }
    }
    static func validatePlan(_ o: [String:Any]) throws {
        try WireShape.keys(o, ["kind","planId","action","clientId","targetSummary","rights","changes","retainedFilters","expectedOwnershipRevision","expectedProviderVersion","digest","expiresAt","requiredIntent","verificationExpectation"])
        guard o["kind"] as? String == "plan", o["verificationExpectation"] as? String == "initialize_tools_and_safe_read",
              ["connect_scoped_project","update_owned_connection","remove_owned_connection"].contains(o["requiredIntent"] as? String ?? "") else { throw LifecycleFailure.invalidInput }
        try WireShape.identifier(o["planId"]); try WireShape.enumeration(o["action"], ConnectionAction.self)
        try WireShape.enumeration(o["clientId"], ClientId.self); try WireShape.text(o["targetSummary"])
        try validateRights(WireShape.object(o["rights"]))
        for change in try WireShape.array(o["changes"],maximum:3) {
            let c = try WireShape.object(change); try WireShape.keys(c, ["field","change"])
            try WireShape.enumeration(c["field"], ManagedChange.Field.self); try WireShape.enumeration(c["change"], ManagedChange.Change.self)
        }
        let filters = try WireShape.object(o["retainedFilters"])
        try WireShape.keys(filters, ["hasCustomFilters","enabledToolsCount","disabledToolsCount","approvalsPreserved"])
        try WireShape.boolean(filters["hasCustomFilters"]); try WireShape.integer(filters["enabledToolsCount"]); try WireShape.integer(filters["disabledToolsCount"])
        try WireShape.boolean(filters["approvalsPreserved"])
        guard (filters["approvalsPreserved"] as? NSNumber)?.boolValue == true else { throw LifecycleFailure.invalidInput }
        try WireShape.integer(o["expectedOwnershipRevision"]); try WireShape.identifier(o["expectedProviderVersion"])
        try WireShape.hash(o["digest"]); try WireShape.stamp(o["expiresAt"])
    }
    static func validateRights(_ o: [String:Any]) throws {
        try WireShape.keys(o, ["projectIds","canWrite"])
        let projects = try WireShape.array(o["projectIds"],maximum:1)
        guard projects.count == 1 else { throw LifecycleFailure.invalidInput }
        try WireShape.identifier(projects[0]); try WireShape.boolean(o["canWrite"])
    }
    static func validateOperation(_ o: [String:Any]) throws {
        try WireShape.keys(o, ["kind","operationId","clientId","action","phase","cleanup","checkedAt"], optional:["reason"])
        guard o["kind"] as? String == "operation" else { throw LifecycleFailure.invalidInput }
        try WireShape.identifier(o["operationId"]); try WireShape.enumeration(o["clientId"], ClientId.self)
        try WireShape.enumeration(o["action"], ConnectionAction.self); try WireShape.enumeration(o["phase"], OperationPhase.self)
        let cleanup = try WireShape.object(o["cleanup"])
        try WireShape.keys(cleanup, ["configCompensation","newGrantCleanup","secretCleanup"])
        try WireShape.enumeration(cleanup["configCompensation"],ConfigCompensation.self)
        try WireShape.enumeration(cleanup["newGrantCleanup"],NewGrantCleanup.self); try WireShape.enumeration(cleanup["secretCleanup"],SecretCleanup.self)
        try WireShape.stamp(o["checkedAt"])
        if let reason = o["reason"] { try WireShape.enumeration(reason,LifecycleFailure.self) }
    }
    static func validateVerification(_ o: [String:Any]) throws {
        try WireShape.keys(o,["kind","clientId","config","protocol","actualClient","expectedToolCount","availableToolCount","missingToolNames","checkedAt"],optional:["actor"])
        guard o["kind"] as? String == "verification", ["not_checked","saved","conflict","invalid"].contains(o["config"] as? String ?? "") else { throw LifecycleFailure.invalidInput }
        try WireShape.enumeration(o["clientId"],ClientId.self); try WireShape.enumeration(o["protocol"],ProtocolCheck.self)
        try WireShape.enumeration(o["actualClient"],ClientLoad.self); try WireShape.integer(o["expectedToolCount"]); try WireShape.integer(o["availableToolCount"])
        for name in try WireShape.array(o["missingToolNames"],maximum:512) { try WireShape.identifier(name) }
        try WireShape.stamp(o["checkedAt"])
        if let actor = o["actor"] {
            let a = try WireShape.object(actor); try WireShape.keys(a,["role","canWrite","projectIds"])
            guard a["role"] as? String == "agent" else { throw LifecycleFailure.invalidInput }
            try validateRights(["projectIds":a["projectIds"] as Any,"canWrite":a["canWrite"] as Any])
        }
    }
}
enum WireShape {
    static func root(_ data:Data) throws -> [String:Any] {
        guard data.count <= 65536 else { throw LifecycleFailure.messageTooLarge }
        try StrictJSONKeys.validate(data)
        return try object(JSONSerialization.jsonObject(with:data))
    }
    static func object(_ value:Any?) throws -> [String:Any] {
        guard let o = value as? [String:Any] else { throw LifecycleFailure.invalidInput }; return o
    }
    static func keys(_ o:[String:Any],_ required:[String], optional:[String] = []) throws {
        let keys = Set(o.keys)
        guard Set(required).isSubset(of:keys), keys.isSubset(of:Set(required+optional)) else { throw LifecycleFailure.invalidInput }
    }
    static func array(_ value:Any?, maximum:Int) throws -> [Any] {
        guard let a = value as? [Any], a.count <= maximum else { throw LifecycleFailure.invalidInput }; return a
    }
    static func string(_ value:Any?, pattern:String, maximum:Int) throws {
        guard let s = value as? String, s.utf16.count <= maximum,
              s.range(of:pattern,options:.regularExpression) == s.startIndex..<s.endIndex else { throw LifecycleFailure.invalidInput }
    }
    static func identifier(_ value:Any?) throws { try string(value,pattern:"^[A-Za-z0-9_-]{1,128}$",maximum:128) }
    static func opaqueVersion(_ value:Any?) throws { try string(value,pattern:"^[^\\x00-\\x1f\\x7f]{1,1024}$",maximum:1024) }
    static func hash(_ value:Any?) throws { try string(value,pattern:"^[a-f0-9]{64}$",maximum:64) }
    static func version(_ value:Any?) throws { try string(value,pattern:"^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$",maximum:80) }
    static func text(_ value:Any?) throws { try string(value,pattern:"^[^\\x00-\\x1f\\x7f]{1,300}$",maximum:300) }
    static func boolean(_ value:Any?) throws {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw LifecycleFailure.invalidInput }
    }
    static func integer(_ value:Any?) throws {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue >= 0, n.doubleValue <= 9007199254740991,
              n.doubleValue.rounded() == n.doubleValue else { throw LifecycleFailure.invalidInput }
    }
    static func literal(_ value:Any?,_ number:Int) throws { try integer(value); guard (value as? NSNumber)?.intValue == number else { throw LifecycleFailure.invalidInput } }
    static func enumeration<T:RawRepresentable>(_ value:Any?,_ type:T.Type) throws where T.RawValue == String {
        guard let raw = value as? String, T(rawValue:raw) != nil else { throw LifecycleFailure.invalidInput }
    }
    static func stamp(_ value:Any?) throws {
        guard let text=value as? String, LifecycleTime.isValidStamp(text) else { throw LifecycleFailure.invalidInput }
    }
}
enum LifecycleTime {
    // Same wire grammar as TypeScript: Gregorian 0001–9999, UTC Z, seconds 00–59,
    // optional 1–9 fractional digits. Formatter normalization is not validation.
    static func isValidStamp(_ text:String) -> Bool {
        let pattern="^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$"
        guard text.utf8.count<=30, text.range(of:pattern,options:.regularExpression)==text.startIndex..<text.endIndex else { return false }
        let bytes=Array(text.utf8)
        func number(_ start:Int,_ end:Int) -> Int {
            bytes[start..<end].reduce(0) { $0*10+Int($1-48) }
        }
        let year=number(0,4), month=number(5,7), day=number(8,10)
        guard year>=1, (1...12).contains(month), number(11,13)<=23,
              number(14,16)<=59, number(17,19)<=59 else { return false }
        let leap=year%4==0 && (year%100 != 0 || year%400==0)
        let days=[31,leap ? 29:28,31,30,31,30,31,31,30,31,30,31]
        return day>=1 && day<=days[month-1]
    }
    static func date(_ s:String) -> Date? {
        guard isValidStamp(s) else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
        if let date = f.date(from:s) { return date }
        f.formatOptions = [.withInternetDateTime]; return f.date(from:s)
    }
    static func stamp(_ d:Date) -> String { ISO8601DateFormatter().string(from:d) }
}


// JSONSerialization and JSONDecoder can choose different duplicate-key values.
// Reject ambiguity before either parser sees a public message or private manifest.
struct StrictJSONKeys {
    private let bytes: [UInt8]
    private var cursor = 0
    static func validate(_ data: Data) throws {
        var parser = StrictJSONKeys(bytes: Array(data))
        do {
            try parser.value(depth: 0); parser.whitespace()
            guard parser.cursor == parser.bytes.count else { throw LifecycleFailure.invalidInput }
        } catch { throw LifecycleFailure.invalidInput }
    }
    private mutating func whitespace() {
        while cursor < bytes.count && [9,10,13,32].contains(bytes[cursor]) { cursor += 1 }
    }
    private mutating func take(_ byte: UInt8) throws {
        guard cursor < bytes.count && bytes[cursor] == byte else { throw LifecycleFailure.invalidInput }
        cursor += 1
    }
    private mutating func string() throws -> Data {
        let start = cursor; try take(34)
        while cursor < bytes.count {
            if bytes[cursor] == 34 { cursor += 1; return Data(bytes[start..<cursor]) }
            if bytes[cursor] == 92 {
                guard cursor + 1 < bytes.count else { throw LifecycleFailure.invalidInput }
                cursor += 2
            } else { cursor += 1 }
        }
        throw LifecycleFailure.invalidInput
    }
    private mutating func value(depth: Int) throws {
        guard depth <= 64 else { throw LifecycleFailure.invalidInput }
        whitespace(); guard cursor < bytes.count else { throw LifecycleFailure.invalidInput }
        switch bytes[cursor] {
        case 123:
            cursor += 1; whitespace()
            if cursor < bytes.count && bytes[cursor] == 125 { cursor += 1; return }
            var names = Set<String>()
            while true {
                let key = try JSONDecoder().decode(String.self,from:string())
                guard names.insert(key).inserted else { throw LifecycleFailure.invalidInput }
                whitespace(); try take(58); try value(depth:depth+1); whitespace()
                guard cursor < bytes.count else { throw LifecycleFailure.invalidInput }
                if bytes[cursor] == 125 { cursor += 1; return }
                try take(44); whitespace()
            }
        case 91:
            cursor += 1; whitespace()
            if cursor < bytes.count && bytes[cursor] == 93 { cursor += 1; return }
            while true {
                try value(depth:depth+1); whitespace()
                guard cursor < bytes.count else { throw LifecycleFailure.invalidInput }
                if bytes[cursor] == 93 { cursor += 1; return }
                try take(44); whitespace()
            }
        case 34: _ = try string()
        default:
            let start = cursor
            while cursor < bytes.count && ![9,10,13,32,44,93,125].contains(bytes[cursor]) { cursor += 1 }
            guard cursor > start else { throw LifecycleFailure.invalidInput }
        }
    }
}
