import Foundation
import CryptoKit

// Provider-projected private values, never public wire payloads or a generic write API.
indirect enum PrivateConfigValue: Equatable {
    case string(String), boolean(Bool), number(Double), array([PrivateConfigValue]), object([String:PrivateConfigValue]), null
    func json(depth:Int=0) throws -> Any {
        guard depth<=16 else { throw LifecycleFailure.configAmbiguous }
        switch self {
        case .string(let v):return v
        case .boolean(let v):return v
        case .number(let v):guard v.isFinite else { throw LifecycleFailure.configAmbiguous };return v
        case .array(let values):return try values.map { try $0.json(depth:depth+1) }
        case .object(let values):return try values.mapValues { try $0.json(depth:depth+1) }
        case .null:return NSNull()
        }
    }
}
struct OwnedLaunchEntry: Equatable {
    let installationId:String
    let connectionId:String
    var launcherVersion:String
    var enabledTools:[String]?
    var disabledTools:[String]
    var toolApprovals:[String:String]
    var unmanagedFields:[String:PrivateConfigValue]

    func canonicalObject() throws -> [String:Any] {
        try WireShape.identifier(installationId);try WireShape.identifier(connectionId);try WireShape.version(launcherVersion)
        guard (enabledTools?.count ?? 0)<=512, disabledTools.count<=512, toolApprovals.count<=512 else { throw LifecycleFailure.configTooLarge }
        for tool in (enabledTools ?? [])+disabledTools+Array(toolApprovals.keys) { try WireShape.identifier(tool) }
        guard toolApprovals.values.allSatisfy({ ["auto","prompt","writes","approve"].contains($0) }) else { throw LifecycleFailure.configAmbiguous }
        var result:[String:Any]=["kind":"sticker_native","installationId":installationId,"connectionId":connectionId,
                               "launcherVersion":launcherVersion,"disabledTools":disabledTools,"toolApprovals":toolApprovals,
                               "unmanagedFields":try unmanagedFields.mapValues { try $0.json() }]
        if let tools=enabledTools { result["enabledTools"]=tools }
        return result
    }
}
enum CanonicalFingerprint {
    static func digest(_ object:[String:Any]) throws -> String {
        let data=try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys,.withoutEscapingSlashes])
        guard data.count<=2097152 else { throw LifecycleFailure.configTooLarge }
        return SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined()
    }
}
enum EntryFingerprint {
    static func digest(_ entry:OwnedLaunchEntry) throws -> String { try CanonicalFingerprint.digest(entry.canonicalObject()) }
}
enum ConfigParseStatus { case valid, ambiguous, invalid }
struct PrivateConfigSnapshot {
    let clientId:ClientId
    let installationId:String
    let connectionId:String
    let targetKind:ConfigTargetKind
    let providerVersion:String
    let rawBytes:Data
    let ownedEntry:OwnedLaunchEntry?
    let parseStatus:ConfigParseStatus
}
enum ToolVisibilityIntent { case preserve, replace(enabled:[String]?,disabled:[String]) }
struct ChangeIntent {
    let action:ConnectionAction
    let clientId:ClientId
    let installationId:String
    let connectionId:String
    let currentProjectId:String?
    let expectedOwnershipRevision:Int
    let desiredLauncherVersion:String
    let credentialReferenceId:String?
    let visibility:ToolVisibilityIntent
}
struct ExactOwnedPatch: Equatable {
    // The sole provider key is fixed in code; callers cannot supply another key.
    let entry:OwnedLaunchEntry?
    var keyPath:String { "mcp_servers.sticker" }
}
struct PrivateConnectionPlan: Equatable {
    let publicPlan:ConnectionPlan
    let exactOwnedPatch:ExactOwnedPatch
    let inverseOwnedPatch:ExactOwnedPatch
    let originalConfigBytes:Data
    let privateProviderVersion:String
    let credentialReferenceId:String?
}

final class ConnectionPlanner {
    private var plans:[String:PrivateConnectionPlan]=[:]
    func plan(snapshot:PrivateConfigSnapshot,ownership:OwnershipManifest?,intent:ChangeIntent,now:Date,planId:String=UUID().uuidString) throws -> PrivateConnectionPlan {
        guard now.timeIntervalSince1970.isFinite else { throw LifecycleFailure.invalidInput }
        plans=plans.filter { (_,plan) in (LifecycleTime.date(plan.publicPlan.expiresAt) ?? .distantPast)>now }
        guard plans.values.filter({ $0.publicPlan.clientId==intent.clientId }).count<4 else { throw LifecycleFailure.planCapacity }
        try WireShape.identifier(planId)
        guard plans[planId]==nil else { throw LifecycleFailure.operationConflict }
        guard snapshot.rawBytes.count<=2097152 else { throw LifecycleFailure.configTooLarge }
        guard snapshot.parseStatus == .valid else { throw LifecycleFailure.configAmbiguous }
        guard intent.clientId == .codexLocal, snapshot.clientId==intent.clientId, snapshot.targetKind == .codexUser else { throw LifecycleFailure.unsupportedProfile }
        for value in [intent.installationId,intent.connectionId] { try WireShape.identifier(value) }
        try WireShape.opaqueVersion(snapshot.providerVersion)
        try WireShape.integer(intent.expectedOwnershipRevision)
        try WireShape.version(intent.desiredLauncherVersion)
        if let reference=intent.credentialReferenceId { try WireShape.identifier(reference) }
        guard snapshot.installationId==intent.installationId, snapshot.connectionId==intent.connectionId else { throw LifecycleFailure.ownedConflict }
        let rights:GrantSummary
        let before=snapshot.ownedEntry
        if let ownership=ownership {
            let data=try JSONEncoder().encode(ownership)
            try OwnershipManifest.validate(JSONSerialization.jsonObject(with:data))
            guard ownership.installationId==intent.installationId, ownership.connectionId==intent.connectionId,
                  ownership.clientId==intent.clientId, ownership.targetKind==snapshot.targetKind,
                  ownership.ownershipRevision==intent.expectedOwnershipRevision,
                  ownership.credentialReferenceId==intent.credentialReferenceId,
                  let entry=before, entry.installationId==intent.installationId, entry.connectionId==intent.connectionId,
                  try EntryFingerprint.digest(entry)==ownership.managedEntryDigest,
                  intent.action != .connect else { throw LifecycleFailure.ownedConflict }
            rights=ownership.grant
        } else {
            guard intent.action == .connect, intent.expectedOwnershipRevision==0, before==nil else { throw LifecycleFailure.ownedConflict }
            guard let project=intent.currentProjectId else { throw LifecycleFailure.projectRequired }
            try WireShape.identifier(project);rights=GrantSummary(projectIds:[project],canWrite:true)
        }
        var changes:[ManagedChange]=[]
        let after:OwnedLaunchEntry?
        switch intent.action {
        case .remove:after=nil;changes=[ManagedChange(field:.registration,change:.remove)]
        case .connect,.update:
            var entry=before ?? OwnedLaunchEntry(installationId:intent.installationId,connectionId:intent.connectionId,
                                               launcherVersion:intent.desiredLauncherVersion,enabledTools:nil,disabledTools:[],
                                               toolApprovals:[:],unmanagedFields:[:])
            if before==nil { changes.append(ManagedChange(field:.registration,change:.add)) }
            if before?.launcherVersion != intent.desiredLauncherVersion {
                changes.append(ManagedChange(field:.launcher,change:before==nil ? .add:.update))
            }
            entry.launcherVersion=intent.desiredLauncherVersion
            if case let .replace(enabled,disabled)=intent.visibility {
                if entry.enabledTools != enabled || entry.disabledTools != disabled {
                    changes.append(ManagedChange(field:.toolVisibility,change:.update))
                }
                entry.enabledTools=enabled;entry.disabledTools=disabled
            }
            _ = try entry.canonicalObject()
            after=entry
        }
        let retained=before ?? after
        let filters=RetainedFilterSummary(hasCustomFilters:retained?.enabledTools != nil || !(retained?.disabledTools.isEmpty ?? true),
                                          enabledToolsCount:retained?.enabledTools?.count ?? 0,
                                          disabledToolsCount:retained?.disabledTools.count ?? 0,approvalsPreserved:true)
        let expires=LifecycleTime.stamp(now.addingTimeInterval(300))
        let versionHandle=try CanonicalFingerprint.digest(["version":snapshot.providerVersion,"client":snapshot.clientId.rawValue])
        let patchObject:Any
        if let entry=after { patchObject=try entry.canonicalObject() } else { patchObject=NSNull() }
        let digest=try CanonicalFingerprint.digest([
            "protocolVersion":1,"planId":planId,"action":intent.action.rawValue,"clientId":intent.clientId.rawValue,
            "installationId":intent.installationId,"connectionId":intent.connectionId,"target":snapshot.targetKind.rawValue,
            "desiredEntry":patchObject,"ownershipRevision":intent.expectedOwnershipRevision,"providerVersion":snapshot.providerVersion,
            "credentialReferenceId":intent.credentialReferenceId as Any? ?? NSNull(),
            "rights":["projectIds":rights.projectIds,"canWrite":rights.canWrite],"expiresAt":expires,
        ])
        let publicPlan=ConnectionPlan(kind:"plan",planId:planId,action:intent.action,clientId:intent.clientId,
                                      targetSummary:intent.clientId == .codexLocal ? "Codex · Sticker":"Sticker",
                                      rights:rights,changes:changes,retainedFilters:filters,
                                      expectedOwnershipRevision:intent.expectedOwnershipRevision,expectedProviderVersion:versionHandle,
                                      digest:digest,expiresAt:expires,requiredIntent:requiredIntent(intent.action),
                                      verificationExpectation:"initialize_tools_and_safe_read")
        try LifecycleWire.validatePlan(WireShape.object(JSONSerialization.jsonObject(with:JSONEncoder().encode(publicPlan))))
        let plan=PrivateConnectionPlan(publicPlan:publicPlan,exactOwnedPatch:ExactOwnedPatch(entry:after),
                                       inverseOwnedPatch:ExactOwnedPatch(entry:before),originalConfigBytes:snapshot.rawBytes,
                                       privateProviderVersion:snapshot.providerVersion,credentialReferenceId:intent.credentialReferenceId)
        plans[planId]=plan
        return plan
    }
    func validate(_ plan:PrivateConnectionPlan,digest:String,now:Date) throws {
        guard let expiry=LifecycleTime.date(plan.publicPlan.expiresAt),expiry>now else { throw LifecycleFailure.planExpired }
        guard let stored=plans[plan.publicPlan.planId],stored==plan,stored.publicPlan.digest==digest else { throw LifecycleFailure.operationConflict }
    }
    func cancel(planId:String) { plans.removeValue(forKey:planId) }
    private func requiredIntent(_ action:ConnectionAction) -> String {
        switch action { case .connect:return "connect_scoped_project";case .update:return "update_owned_connection";case .remove:return "remove_owned_connection" }
    }
}
