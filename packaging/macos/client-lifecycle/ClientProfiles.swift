import Foundation

enum MetadataIdentity { case codexBundle, claudeCodePackage, claudeDesktopBundle, unverified }
struct ClientMetadata {
    let identity: MetadataIdentity
    let installationIdentity: String
    let version: String?
    let executable: Bool
}
protocol MetadataDiscovery {
    func candidates(for clientId: ClientId) async throws -> [ClientMetadata]
}
// Slots are fixed. A platform reader supplies metadata only; it cannot accept a caller path/command.
// This increment intentionally wires no operating-home reader or client executable.
enum MetadataSlot: CaseIterable {
    case codexUserBin, codexHomebrewBin, codexLocalBin, codexChatGPTBundle, codexStandaloneBundle
    case claudeUserBin, claudeHomebrewBin, claudeLocalBin, claudeDesktopBundle
}
protocol MetadataReader {
    func metadata(at slot: MetadataSlot) async throws -> ClientMetadata?
}
struct FixedMetadataDiscovery: MetadataDiscovery {
    let reader: MetadataReader
    func candidates(for clientId: ClientId) async throws -> [ClientMetadata] {
        let slots: [MetadataSlot]
        switch clientId {
        case .codexLocal: slots = [.codexUserBin,.codexHomebrewBin,.codexLocalBin,.codexChatGPTBundle,.codexStandaloneBundle]
        case .claudeCodeLocal: slots = [.claudeUserBin,.claudeHomebrewBin,.claudeLocalBin]
        case .claudeDesktop: slots = [.claudeDesktopBundle]
        }
        var result: [ClientMetadata] = []
        for slot in slots { if let record = try await reader.metadata(at:slot) { result.append(record) } }
        return result
    }
}
enum ClientProfiles {
    static func detect(using discovery: MetadataDiscovery, now: Date = Date()) async throws -> [ClientSnapshot] {
        var snapshots: [ClientSnapshot] = []
        for client in ClientId.allCases {
            let records: [ClientMetadata]
            do { records = try await discovery.candidates(for:client) }
            catch { snapshots.append(snapshot(client,nil,.unsupportedProfile,.metadataUnavailable,now)); continue }
            guard records.count <= 16 else { snapshots.append(snapshot(client,nil,.unsupportedProfile,.candidateLimit,now)); continue }
            if records.isEmpty { snapshots.append(snapshot(client,nil,.notDetected,.notInCheckedLocations,now)); continue }
            guard records.allSatisfy({ matches($0,client) }) else {
                snapshots.append(snapshot(client,nil,.unsupportedProfile,.invalidMetadata,now)); continue
            }
            let distinct = Set(records.map(\.installationIdentity))
            guard distinct.count == 1 else { snapshots.append(snapshot(client,nil,.ambiguousInstallation,.multipleInstallations,now)); continue }
            let versions = Set(records.compactMap(\.version))
            guard versions.count == 1, let version = versions.first, records.allSatisfy({ $0.version == version }),
                  (try? WireShape.version(version)) != nil else {
                snapshots.append(snapshot(client,nil,.unsupportedProfile,.invalidMetadata,now)); continue
            }
            snapshots.append(snapshot(client,version,client == .claudeDesktop ? .providerManaged : .writerUnavailable,
                                      client == .claudeDesktop ? .providerManaged : .writerNotCertified,now))
        }
        return snapshots
    }
    private static func matches(_ metadata:ClientMetadata,_ client:ClientId) -> Bool {
        guard metadata.executable, !metadata.installationIdentity.isEmpty,
              metadata.installationIdentity.utf8.count <= 4096 else { return false }
        switch (client,metadata.identity) {
        case (.codexLocal,.codexBundle),(.claudeCodeLocal,.claudeCodePackage),(.claudeDesktop,.claudeDesktopBundle):return true
        default:return false
        }
    }
    private static func snapshot(_ id:ClientId,_ version:String?,_ availability:Availability,_ reason:MetadataReason,_ now:Date) -> ClientSnapshot {
        let name: String
        switch id { case .codexLocal:name="Codex";case .claudeCodeLocal:name="Claude Code";case .claudeDesktop:name="Claude Desktop" }
        return ClientSnapshot(clientId:id,displayName:name,safeVersion:version,availability:availability,
                              registration:.unknown,ownershipRevision:0,allowedActions:[],credentialState:.grantRequired,
                              protocolCheck:.notChecked,clientLoad:.unknown,checkedAt:LifecycleTime.stamp(now),reasonCodes:[reason])
    }
}
