import Foundation
import Darwin

enum ConfigTargetKind: String, Codable { case codexUser = "codex_user", claudeCodeUser = "claude_code_user" }
enum GrantOwnership: String, Codable { case exclusiveManaged = "exclusive_managed", preexistingShared = "preexisting_shared", pendingManaged = "pending_managed" }
struct OwnershipManifest: Codable, Equatable {
    let schemaVersion: Int
    var installationId: String
    let connectionId: String
    let clientId: ClientId
    let targetKind: ConfigTargetKind
    let serverKey: String
    let managedEntryDigest: String
    let ownershipRevision: Int
    let creationOperationId: String
    let launcherVersion: String
    let credentialReferenceId: String?
    let grant: GrantSummary
    let grantOwnership: GrantOwnership
    let managedGrantId: String?
    let managedGrantRevision: Int?
    let lastProviderVersion: String
    let transactionState: OperationPhase
    let cleanup: CleanupReceipts

    static func validate(_ value: Any) throws {
        let o = try WireShape.object(value)
        try WireShape.keys(o,["schemaVersion","installationId","connectionId","clientId","targetKind","serverKey","managedEntryDigest","ownershipRevision","creationOperationId","launcherVersion","grant","grantOwnership","lastProviderVersion","transactionState","cleanup"],
                           optional:["credentialReferenceId","managedGrantId","managedGrantRevision"])
        try WireShape.literal(o["schemaVersion"],1)
        for name in ["installationId","connectionId","creationOperationId"] { try WireShape.identifier(o[name]) }
        try WireShape.opaqueVersion(o["lastProviderVersion"])
        try WireShape.enumeration(o["clientId"],ClientId.self);try WireShape.enumeration(o["targetKind"],ConfigTargetKind.self)
        guard o["serverKey"] as? String == "sticker" else { throw LifecycleFailure.invalidStorage }
        try WireShape.hash(o["managedEntryDigest"]);try WireShape.integer(o["ownershipRevision"])
        guard (o["ownershipRevision"] as? NSNumber)?.intValue ?? 0 > 0 else { throw LifecycleFailure.invalidStorage }
        try WireShape.version(o["launcherVersion"]);try LifecycleWire.validateRights(WireShape.object(o["grant"]))
        try WireShape.enumeration(o["grantOwnership"],GrantOwnership.self)
        for key in ["credentialReferenceId","managedGrantId"] { if let value=o[key] { try WireShape.identifier(value) } }
        if let revision=o["managedGrantRevision"] { try WireShape.integer(revision) }
        try WireShape.enumeration(o["transactionState"],OperationPhase.self)
        let c=try WireShape.object(o["cleanup"])
        try WireShape.keys(c,["configCompensation","newGrantCleanup","secretCleanup"])
        try WireShape.enumeration(c["configCompensation"],ConfigCompensation.self)
        try WireShape.enumeration(c["newGrantCleanup"],NewGrantCleanup.self);try WireShape.enumeration(c["secretCleanup"],SecretCleanup.self)
        if o["grantOwnership"] as? String == GrantOwnership.exclusiveManaged.rawValue {
            guard o["managedGrantId"] != nil, o["managedGrantRevision"] != nil else { throw LifecycleFailure.invalidStorage }
        }
        let client=o["clientId"] as? String, target=o["targetKind"] as? String
        guard (client == ClientId.codexLocal.rawValue && target == ConfigTargetKind.codexUser.rawValue) ||
              (client == ClientId.claudeCodeLocal.rawValue && target == ConfigTargetKind.claudeCodeUser.rawValue) else { throw LifecycleFailure.invalidStorage }
    }
}

// Read-only private-state boundary. No shared client-config writer is provided.
final class OwnedConnectionStore {
    private let directory: Int32
    private let expectedOwner: uid_t
    init(root: URL, expectedOwner: uid_t = getuid()) throws {
        guard root.isFileURL, root.path.hasPrefix("/") else { throw LifecycleFailure.unsafeStorage }
        var current=Darwin.open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC)
        guard current >= 0 else { throw LifecycleFailure.unsafeStorage }
        do {
            for component in root.pathComponents.dropFirst() {
                guard component != ".", component != "..", !component.contains("/") else { throw LifecycleFailure.unsafeStorage }
                let next=Darwin.openat(current,component,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
                guard next >= 0 else { throw LifecycleFailure.unsafeStorage }
                _ = Darwin.close(current);current=next
            }
            var metadata=stat()
            guard fstat(current,&metadata)==0, metadata.st_uid==expectedOwner,
                  metadata.st_mode & S_IFMT == S_IFDIR, metadata.st_mode & 0o777 == 0o700 else { throw LifecycleFailure.unsafeStorage }
            directory=current;self.expectedOwner=expectedOwner
        } catch { _ = Darwin.close(current);throw LifecycleFailure.unsafeStorage }
    }
    deinit { _ = Darwin.close(directory) }

    func load(connectionId:String) throws -> OwnershipManifest? {
        try WireShape.identifier(connectionId)
        var root=stat()
        guard fstat(directory,&root)==0, root.st_uid==expectedOwner, root.st_mode & 0o777 == 0o700 else { throw LifecycleFailure.unsafeStorage }
        let descriptor=Darwin.openat(directory,connectionId+".json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        if descriptor < 0 {
            if errno==ENOENT { return nil }
            throw LifecycleFailure.unsafeStorage
        }
        defer { _ = Darwin.close(descriptor) }
        var before=stat()
        guard fstat(descriptor,&before)==0, safe(before), before.st_size <= 65536 else { throw LifecycleFailure.unsafeStorage }
        var bytes=Data(), buffer=[UInt8](repeating:0,count:4096)
        while true {
            let count=buffer.withUnsafeMutableBytes { Darwin.read(descriptor,$0.baseAddress,$0.count) }
            if count < 0 { if errno==EINTR { continue };throw LifecycleFailure.invalidStorage }
            if count==0 { break }
            guard bytes.count+count <= 65536 else { throw LifecycleFailure.invalidStorage }
            bytes.append(contentsOf:buffer.prefix(count))
        }
        var after=stat()
        guard fstat(descriptor,&after)==0, safe(after), before.st_ino==after.st_ino,
              before.st_size==after.st_size, before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec else { throw LifecycleFailure.invalidStorage }
        do {
            try StrictJSONKeys.validate(bytes)
            let raw=try JSONSerialization.jsonObject(with:bytes)
            try OwnershipManifest.validate(raw)
            let manifest=try JSONDecoder().decode(OwnershipManifest.self,from:bytes)
            guard manifest.connectionId==connectionId else { throw LifecycleFailure.invalidStorage }
            return manifest
        } catch { throw LifecycleFailure.invalidStorage }
    }
    private func safe(_ value:stat) -> Bool {
        value.st_uid==expectedOwner && value.st_mode & S_IFMT == S_IFREG &&
        value.st_mode & 0o777 == 0o600 && value.st_nlink==1 && value.st_size>=0
    }
}

// Durable private-state port. A future backing adapter must provide atomic CAS,
// private permissions and durability before returning .written. No host-file
// writer is supplied here; tests inject persisted images, never client config.
struct CancellationPlanBinding: Codable, Equatable {
    let planId:String,digest:String,requesterId:String,installationId:String,connectionId:String
    let clientId:ClientId
    let action:ConnectionAction
    func validate() throws {
        for value in [planId,requesterId,installationId,connectionId] { try WireShape.identifier(value) };try WireShape.hash(digest)
    }
    func matches(_ context:TrustedRequestContext) -> Bool {
        requesterId==context.requesterId && installationId==context.identity.installationId && connectionId==context.connectionId && clientId==context.identity.clientId
    }
}
enum CancellationFenceState: String, Codable { case confirmed,absent,uncertain,conflict }
struct CancellationFence: Codable, Equatable {
    let binding:CancellationPlanBinding
    let state:CancellationFenceState
}
// The complete fence snapshot is required, separate from image bytes. A CAS may
// change only the image and MUST NOT replace/erase the independent fence ledger.
struct PersistedLifecycleState { let version:Int;let data:Data?;let cancellationFences:[CancellationFence] }
private actor CancellationReply {
    private var outcome:CancellationFenceState?
    private var listeners:[CheckedContinuation<CancellationFenceState,Never>]=[]
    func finish(_ result:CancellationFenceState) {
        guard outcome==nil else { return };outcome=result
        for listener in listeners { listener.resume(returning:result) };listeners=[]
    }
    func value() async -> CancellationFenceState {
        if let outcome=outcome { return outcome }
        return await withCheckedContinuation { listeners.append($0) }
    }
}
enum PrivateStateWrite { case written(Int), conflict, uncertain }
protocol PrivateLifecyclePersistence: Actor {
    func read() async throws -> PersistedLifecycleState
    func compareAndSwap(expectedVersion:Int,data:Data) async throws -> PrivateStateWrite
    // Atomic, monotonic plan fence; independent of an in-flight image CAS. It
    // covers EVERY operation from this plan. Same binding is idempotent; a
    // reused plan key with another binding conflicts. Retain resumable fences.
    func recordCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState
    func readCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState
}
extension PrivateLifecyclePersistence {
    // A backing adapter without durable cancellation cannot acknowledge cancel.
    func recordCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState { .uncertain }
    func readCancellationFence(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        do {
            let snapshot=try await read()
            guard snapshot.cancellationFences.count<=200 else { return .uncertain }
            let found=snapshot.cancellationFences.filter { $0.binding.planId==binding.planId }
            guard found.count<=1 else { return .conflict }
            guard let fence=found.first else { return .absent }
            guard fence.binding==binding,[.confirmed,.uncertain].contains(fence.state) else { return .conflict }
            return fence.state
        } catch { return .uncertain }
    }
}
struct StoredEntry: Codable, Equatable {
    let installationId:String, connectionId:String, launcherVersion:String
    let enabledTools:[String]?
    let disabledTools:[String]
    let toolApprovals:[String:String]
    let unmanagedFields:[String:PrivateConfigValue]
    init(_ entry:OwnedLaunchEntry) {
        installationId=entry.installationId;connectionId=entry.connectionId;launcherVersion=entry.launcherVersion
        enabledTools=entry.enabledTools;disabledTools=entry.disabledTools;toolApprovals=entry.toolApprovals;unmanagedFields=entry.unmanagedFields
    }
    var entry:OwnedLaunchEntry { OwnedLaunchEntry(installationId:installationId,connectionId:connectionId,launcherVersion:launcherVersion,enabledTools:enabledTools,disabledTools:disabledTools,toolApprovals:toolApprovals,unmanagedFields:unmanagedFields) }
}
extension PrivateConfigValue: Codable {
    init(from decoder:Decoder) throws {
        let c=try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v=try? c.decode(Bool.self) { self = .boolean(v) }
        else if let v=try? c.decode(String.self) { self = .string(v) }
        else if let v=try? c.decode(Double.self),v.isFinite { self = .number(v) }
        else if let v=try? c.decode([PrivateConfigValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String:PrivateConfigValue].self)) }
    }
    func encode(to encoder:Encoder) throws {
        var c=encoder.singleValueContainer()
        switch self {
        case .null:try c.encodeNil()
        case .string(let v):try c.encode(v)
        case .boolean(let v):try c.encode(v)
        case .number(let v):guard v.isFinite else { throw LifecycleFailure.invalidStorage };try c.encode(v)
        case .array(let v):try c.encode(v)
        case .object(let v):try c.encode(v)
        }
    }
}
struct AdmittedConnectionPlan: Codable, Equatable {
    let publicPlan:ConnectionPlan
    let desired:StoredEntry?
    let inverse:StoredEntry?
    let providerVersion:String
    let credentialReferenceId:String?
    init(_ plan:PrivateConnectionPlan) {
        publicPlan=plan.publicPlan;desired=plan.exactOwnedPatch.entry.map(StoredEntry.init)
        inverse=plan.inverseOwnedPatch.entry.map(StoredEntry.init);providerVersion=plan.privateProviderVersion;credentialReferenceId=plan.credentialReferenceId
    }
}
enum JournalApplyState: String, Codable { case notAttempted, unknown, notApplied, applied }
enum JournalActivation: String, Codable { case notStarted, unknown, active, refused }
struct LifecycleJournalRecord: Codable, Equatable {
    var revision:Int=0
    let operationId:String, requesterId:String, installationId:String, connectionId:String
    let plan:AdmittedConnectionPlan
    let originalOwnership:OwnershipManifest?
    var recoveryOf:String?
    var phase:OperationPhase = .planned
    var applyState:JournalApplyState = .notAttempted
    var receiptVersion:String?
    var overridden=false
    var appliedVersion:String?
    var credential:LifecycleCredential?
    var provisioningStarted=false
    var activation:JournalActivation = .notStarted
    var cleanup=CleanupReceipts(configCompensation:.notNeeded,newGrantCleanup:.notCreated,secretCleanup:.notOwned)
    var cancellationRequested=false
    var compensating=false
    var finished=false
    var reason:LifecycleFailure?
    let createdAt:Date
    var verification:LifecycleVerification?
    var cancellationBinding:CancellationPlanBinding {
        CancellationPlanBinding(planId:plan.publicPlan.planId,digest:plan.publicPlan.digest,requesterId:requesterId,installationId:installationId,connectionId:connectionId,clientId:plan.publicPlan.clientId,action:plan.publicPlan.action)
    }
    func snapshot(now:Date) -> OperationSnapshot {
        let projectedPhase:OperationPhase = applyState == .unknown || activation == .unknown || cleanup.configCompensation == .uncertain || cleanup.newGrantCleanup == .uncertain ? .uncertain:(!finished && cancellationRequested ? .cleanupPending:phase)
        return OperationSnapshot(kind:"operation",operationId:operationId,clientId:plan.publicPlan.clientId,action:plan.publicPlan.action,phase:projectedPhase,cleanup:cleanup,checkedAt:LifecycleTime.stamp(now),reason:reason)
    }
    func validate() throws {
        for id in [operationId,requesterId,installationId,connectionId] { try WireShape.identifier(id) }
        try LifecycleWire.validatePlan(WireShape.object(JSONSerialization.jsonObject(with:JSONEncoder().encode(plan.publicPlan))))
        if let id=recoveryOf { try WireShape.identifier(id);guard id != operationId else { throw LifecycleFailure.invalidStorage } }
        try WireShape.opaqueVersion(plan.providerVersion)
        for value in [plan.desired,plan.inverse].compactMap({$0}) {
            _ = try value.entry.canonicalObject()
            guard value.installationId==installationId,value.connectionId==connectionId else { throw LifecycleFailure.invalidStorage }
        }
        let desiredValue:Any=try plan.desired?.entry.canonicalObject() ?? NSNull()
        let digest=try CanonicalFingerprint.digest([
            "protocolVersion":1,"planId":plan.publicPlan.planId,"action":plan.publicPlan.action.rawValue,"clientId":plan.publicPlan.clientId.rawValue,
            "installationId":installationId,"connectionId":connectionId,"target":ConfigTargetKind.codexUser.rawValue,
            "desiredEntry":desiredValue,"ownershipRevision":plan.publicPlan.expectedOwnershipRevision,"providerVersion":plan.providerVersion,
            "credentialReferenceId":plan.credentialReferenceId as Any? ?? NSNull(),
            "rights":["projectIds":plan.publicPlan.rights.projectIds,"canWrite":plan.publicPlan.rights.canWrite],"expiresAt":plan.publicPlan.expiresAt,
        ])
        guard digest==plan.publicPlan.digest else { throw LifecycleFailure.invalidStorage }
        if let owned=originalOwnership {
            try OwnershipManifest.validate(JSONSerialization.jsonObject(with:JSONEncoder().encode(owned)))
            guard owned.installationId==installationId,owned.connectionId==connectionId,owned.clientId==plan.publicPlan.clientId,
                  owned.ownershipRevision==plan.publicPlan.expectedOwnershipRevision,owned.grant==plan.publicPlan.rights,
                  let inverse=plan.inverse,try EntryFingerprint.digest(inverse.entry)==owned.managedEntryDigest else { throw LifecycleFailure.invalidStorage }
        } else { guard plan.inverse==nil,plan.publicPlan.expectedOwnershipRevision==0 else { throw LifecycleFailure.invalidStorage } }
        if let c=credential { try c.validate();guard c.rights==plan.publicPlan.rights,c.connectionId==connectionId else { throw LifecycleFailure.invalidStorage } }
        for version in [receiptVersion,appliedVersion].compactMap({$0}) { try WireShape.opaqueVersion(version) }
        if applyState == .applied { guard receiptVersion != nil else { throw LifecycleFailure.invalidStorage } }
        if finished { guard [.committed,.rolledBack,.canceled].contains(phase) else { throw LifecycleFailure.invalidStorage } }
        if cleanup.secretCleanup == .deleted { guard [.revoked,.confirmedExpired].contains(cleanup.newGrantCleanup) else { throw LifecycleFailure.invalidStorage } }
        guard revision>=0,createdAt.timeIntervalSince1970.isFinite else { throw LifecycleFailure.invalidStorage }
        guard try JSONEncoder().encode(self).count<=262144 else { throw LifecycleFailure.invalidStorage }
    }
}
private struct PrivateLifecycleBackup: Codable {
    let connectionId:String,createdAt:Date,data:Data
    var pinned:Bool
}
private struct PrivateLifecycleImage: Codable {
    let schemaVersion:Int
    var records:[String:LifecycleJournalRecord]=[:]
    var ownership:[String:OwnershipManifest]=[:]
    var backups:[String:PrivateLifecycleBackup]=[:]
}
struct LifecycleJournalLimits {
    var backupBytes=33554432
    var retainedBackupsPerTarget=3
    var terminalSummaries=100
}
actor OwnedLifecycleJournal {
    private let persistence:any PrivateLifecyclePersistence
    private let limits:LifecycleJournalLimits
    private var version:Int
    private var image:PrivateLifecycleImage
    private var blocked=false
    private var mutationBusy=false
    private var mutationWaiters:[CheckedContinuation<Void,Never>]=[]
    private var fences:[String:CancellationFence]=[:]
    private struct FenceAttempt { let binding:CancellationPlanBinding;let reply:CancellationReply;let worker:Task<Void,Never> }
    private var fenceWrites:[String:FenceAttempt]=[:],fenceReads:[String:FenceAttempt]=[:]
    private let fenceBudgetNanoseconds:UInt64
    private(set) var mutationCount=0
    private init(persistence:any PrivateLifecyclePersistence,limits:LifecycleJournalLimits,version:Int,image:PrivateLifecycleImage,fences:[String:CancellationFence],fenceBudgetNanoseconds:UInt64) {
        self.persistence=persistence;self.limits=limits;self.version=version;self.image=image;self.fences=fences;self.fenceBudgetNanoseconds=fenceBudgetNanoseconds
    }
    static func open(_ persistence:any PrivateLifecyclePersistence,limits:LifecycleJournalLimits=LifecycleJournalLimits(),fenceBudgetNanoseconds:UInt64=1000000000) async throws -> OwnedLifecycleJournal {
        guard limits.backupBytes>=0,limits.backupBytes<=33554432,(0...3).contains(limits.retainedBackupsPerTarget),(0...100).contains(limits.terminalSummaries) else { throw LifecycleFailure.invalidStorage }
        guard (1000000...5000000000).contains(fenceBudgetNanoseconds) else { throw LifecycleFailure.invalidStorage }
        let state=try await persistence.read()
        var fences:[String:CancellationFence]=[:]
        guard state.cancellationFences.count<=200 else { throw LifecycleFailure.invalidStorage }
        for fence in state.cancellationFences {
            try fence.binding.validate()
            guard [.confirmed,.uncertain].contains(fence.state),fences[fence.binding.planId]==nil else { throw LifecycleFailure.invalidStorage }
            fences[fence.binding.planId]=fence
        }
        guard state.version>=0 else { throw LifecycleFailure.invalidStorage }
        var image=PrivateLifecycleImage(schemaVersion:1)
        if let data=state.data {
            guard data.count<=100663296 else { throw LifecycleFailure.invalidStorage }
            try StrictJSONKeys.validate(data)
            let raw=try WireShape.object(JSONSerialization.jsonObject(with:data))
            try WireShape.keys(raw,["schemaVersion","records","ownership","backups"])
            image=try JSONDecoder().decode(PrivateLifecycleImage.self,from:data)
            guard image.schemaVersion==1,image.records.count<=200 else { throw LifecycleFailure.invalidStorage }
            for (key,record) in image.records {
                guard key==record.operationId else { throw LifecycleFailure.invalidStorage };try record.validate()
                let rawRecords=try WireShape.object(raw["records"]),row=try WireShape.object(rawRecords[key])
                try WireShape.keys(row,["revision","operationId","requesterId","installationId","connectionId","plan","phase","applyState","overridden","provisioningStarted","activation","cleanup","cancellationRequested","compensating","finished","createdAt"],optional:["originalOwnership","receiptVersion","appliedVersion","credential","reason","verification","recoveryOf"])
                let plan=try WireShape.object(row["plan"])
                try WireShape.keys(plan,["publicPlan","providerVersion"],optional:["desired","inverse","credentialReferenceId"])
                for field in ["desired","inverse"] { if let entry=plan[field] { try WireShape.keys(WireShape.object(entry),["installationId","connectionId","launcherVersion","disabledTools","toolApprovals","unmanagedFields"],optional:["enabledTools"]) } }
            }
            for record in image.records.values {
                if let origin=record.recoveryOf,let old=image.records[origin] {
                    guard old.compensating,old.installationId==record.installationId,old.requesterId==record.requesterId,old.connectionId==record.connectionId,
                          record.plan.desired==old.plan.inverse,record.plan.inverse==old.plan.desired,record.plan.publicPlan.rights==old.plan.publicPlan.rights else { throw LifecycleFailure.invalidStorage }
                } else if record.recoveryOf != nil && !record.finished { throw LifecycleFailure.invalidStorage }
            }
            for (key,manifest) in image.ownership {
                guard key==manifest.connectionId else { throw LifecycleFailure.invalidStorage }
                try OwnershipManifest.validate(JSONSerialization.jsonObject(with:JSONEncoder().encode(manifest)))
            }
            for (key,backup) in image.backups {
                try WireShape.identifier(key);try WireShape.identifier(backup.connectionId)
                guard backup.createdAt.timeIntervalSince1970.isFinite else { throw LifecycleFailure.invalidStorage }
                if backup.pinned { guard let record=image.records[key],!record.finished,record.connectionId==backup.connectionId else { throw LifecycleFailure.invalidStorage } }
            }
            for record in image.records.values where !record.finished { guard image.backups[record.operationId]?.pinned==true else { throw LifecycleFailure.invalidStorage } }
            guard image.backups.values.allSatisfy({$0.data.count<=2097152}),image.backups.values.reduce(0,{$0+$1.data.count})<=limits.backupBytes else { throw LifecycleFailure.invalidStorage }
        }
        return OwnedLifecycleJournal(persistence:persistence,limits:limits,version:state.version,image:image,fences:fences,fenceBudgetNanoseconds:fenceBudgetNanoseconds)
    }
    func record(_ operationId:String) -> LifecycleJournalRecord? {
        guard var record=image.records[operationId] else { return nil }
        if !record.finished,let fence=fences[record.plan.publicPlan.planId] {
            record.cancellationRequested=true
            if fence.binding != record.cancellationBinding || fence.state != .confirmed { record.phase = .uncertain;record.reason = .cancellationUnconfirmed }
        }
        return record
    }
    func cancellationBinding(planId:String) -> CancellationPlanBinding? { fences[planId]?.binding }
    func ownership(connectionId:String) throws -> OwnershipManifest? { try WireShape.identifier(connectionId);return image.ownership[connectionId] }
    func completedOperation(planId:String,requesterId:String,installationId:String) -> LifecycleJournalRecord? {
        image.records.values.first { $0.plan.publicPlan.planId==planId && $0.requesterId==requesterId && $0.installationId==installationId && $0.finished }
    }
    func operation(planId:String,requesterId:String,installationId:String) -> LifecycleJournalRecord? {
        guard let found=image.records.values.first(where: { $0.plan.publicPlan.planId==planId && $0.requesterId==requesterId && $0.installationId==installationId && !$0.finished }) else { return nil };return record(found.operationId)
    }
    func reserve(_ record:LifecycleJournalRecord,backup:Data) async throws -> LifecycleJournalRecord {
        await acquireMutation();defer { releaseMutation() }
        try record.validate()
        guard backup.count<=2097152,image.records[record.operationId]==nil,
              !image.records.values.contains(where: { !$0.finished && $0.installationId==record.installationId && $0.plan.publicPlan.clientId==record.plan.publicPlan.clientId && !($0.operationId==record.recoveryOf && $0.compensating && $0.requesterId==record.requesterId && $0.connectionId==record.connectionId) }),image.records.count<200 else { throw LifecycleFailure.operationConflict }
        var next=image,updated=record;updated.revision=1
        next.records[record.operationId]=updated
        next.backups[record.operationId]=PrivateLifecycleBackup(connectionId:record.connectionId,createdAt:record.createdAt,data:backup,pinned:true)
        try await persist(next);return updated
    }
    func save(_ record:LifecycleJournalRecord) async throws -> LifecycleJournalRecord {
        await acquireMutation();defer { releaseMutation() }
        try record.validate()
        guard let old=image.records[record.operationId],old.revision==record.revision,
              old.plan==record.plan,old.recoveryOf==record.recoveryOf,old.requesterId==record.requesterId,old.installationId==record.installationId else { throw LifecycleFailure.operationConflict }
        var next=image,updated=record;updated.revision+=1
        updated.cancellationRequested=updated.cancellationRequested || old.cancellationRequested || fences[record.plan.publicPlan.planId] != nil
        next.records[record.operationId]=updated
        if updated.finished { next.backups[record.operationId]?.pinned=false }
        try await persist(next);return updated
    }
    func replaceOwnership(connectionId:String,expected:OwnershipManifest?,with manifest:OwnershipManifest?) async throws {
        await acquireMutation();defer { releaseMutation() }
        guard image.ownership[connectionId]==expected else { throw LifecycleFailure.ownedConflict }
        if let manifest=manifest { try OwnershipManifest.validate(JSONSerialization.jsonObject(with:JSONEncoder().encode(manifest))) }
        var next=image;next.ownership[connectionId]=manifest;try await persist(next)
    }
    func requestCancellation(operationId:String,requesterId:String,installationId:String) async throws {
        guard let record=record(operationId),record.requesterId==requesterId,record.installationId==installationId,!record.finished else { throw LifecycleFailure.permissionRequired }
        try await cancelAdmission(record.cancellationBinding)
    }
    func cancelAdmission(_ binding:CancellationPlanBinding) async throws {
        try binding.validate()
        if let prior=fences[binding.planId] {
            guard prior.binding==binding else { throw LifecycleFailure.operationConflict }
            if prior.state == .confirmed { return }
            // An earlier lost reply may already have committed. Read its exact
            // outcome before another idempotent cancellation request.
            if await cancellationState(binding) == .confirmed { return }
        }
        guard fences.count<200 || fences[binding.planId] != nil else { throw LifecycleFailure.cancellationUnconfirmed }
        // Local withdrawal stops new work immediately; only a confirmed durable
        // ledger receipt may acknowledge acceptance. Never wait on image CAS.
        fences[binding.planId]=CancellationFence(binding:binding,state:.uncertain)
        let attempt:FenceAttempt
        if let pending=fenceWrites[binding.planId] {
            guard pending.binding==binding else { throw LifecycleFailure.operationConflict };attempt=pending
        } else {
            let reply=CancellationReply(),budget=fenceBudgetNanoseconds
            let timer=Task { do { try await Task.sleep(nanoseconds:budget) } catch { return };await reply.finish(.uncertain) }
            let worker=Task {
                let result=await persistence.recordCancellationFence(binding)
                if result == .confirmed { fences[binding.planId]=CancellationFence(binding:binding,state:.confirmed);mutationCount+=1 }
                await reply.finish(result);timer.cancel();fenceWrites.removeValue(forKey:binding.planId)
            }
            attempt=FenceAttempt(binding:binding,reply:reply,worker:worker);fenceWrites[binding.planId]=attempt
        }
        let result=await attempt.reply.value()
        guard result == .confirmed else { throw LifecycleFailure.cancellationUnconfirmed }
    }
    func cancellationState(_ binding:CancellationPlanBinding) async -> CancellationFenceState {
        guard (try? binding.validate()) != nil else { return .conflict }
        if let prior=fences[binding.planId] {
            guard prior.binding==binding else { return .conflict }
            if prior.state == .confirmed { return .confirmed }
        }
        guard fenceReads.count<200 || fenceReads[binding.planId] != nil else { return .uncertain }
        let attempt:FenceAttempt
        if let pending=fenceReads[binding.planId] {
            guard pending.binding==binding else { return .conflict };attempt=pending
        } else {
            let reply=CancellationReply(),budget=fenceBudgetNanoseconds
            let timer=Task { do { try await Task.sleep(nanoseconds:budget) } catch { return };await reply.finish(.uncertain) }
            let worker=Task {
                let observed=await persistence.readCancellationFence(binding)
                if observed == .confirmed { fences[binding.planId]=CancellationFence(binding:binding,state:.confirmed) }
                let effective=fences[binding.planId]?.state ?? observed
                await reply.finish(effective);timer.cancel();fenceReads.removeValue(forKey:binding.planId)
            }
            attempt=FenceAttempt(binding:binding,reply:reply,worker:worker);fenceReads[binding.planId]=attempt
        }
        return await attempt.reply.value()
    }
    func metrics() -> (records:Int,backups:Int,pinned:Int,bytes:Int) {
        (image.records.count,image.backups.count,image.backups.values.filter(\.pinned).count,image.backups.values.reduce(0,{$0+$1.data.count}))
    }
    private func acquireMutation() async {
        if !mutationBusy { mutationBusy=true;return }
        await withCheckedContinuation { mutationWaiters.append($0) }
    }
    private func releaseMutation() {
        if mutationWaiters.isEmpty { mutationBusy=false }
        else { mutationWaiters.removeFirst().resume() }
    }
    private func persist(_ proposed:PrivateLifecycleImage) async throws {
        guard !blocked else { throw LifecycleFailure.invalidStorage }
        var next=proposed
        let targets=Set(next.backups.values.map(\.connectionId))
        for target in targets {
            let candidates=next.backups.filter { $0.value.connectionId==target && !$0.value.pinned }.sorted { $0.value.createdAt>$1.value.createdAt }
            for item in candidates.dropFirst(limits.retainedBackupsPerTarget) { next.backups.removeValue(forKey:item.key) }
        }
        let dependencies=Set(next.records.values.filter { !$0.finished }.compactMap(\.recoveryOf))
        let terminal=next.records.values.filter { $0.finished && !dependencies.contains($0.operationId) }.sorted { $0.createdAt>$1.createdAt }
        for record in terminal.dropFirst(limits.terminalSummaries) { next.records.removeValue(forKey:record.operationId) }
        guard next.backups.values.reduce(0,{$0+$1.data.count})<=limits.backupBytes else { throw LifecycleFailure.configTooLarge }
        let bytes=try JSONEncoder().encode(next)
        guard bytes.count<=100663296 else { throw LifecycleFailure.invalidStorage }
        do {
            switch try await persistence.compareAndSwap(expectedVersion:version,data:bytes) {
            case .written(let newVersion):image=next;version=newVersion;mutationCount+=1
            case .conflict:blocked=true;throw LifecycleFailure.operationConflict
            case .uncertain:blocked=true;throw LifecycleFailure.invalidStorage
            }
        } catch { blocked=true;throw error }
    }
}
