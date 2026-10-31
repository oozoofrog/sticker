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
