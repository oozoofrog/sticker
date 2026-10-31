import Foundation

struct FixtureMetadata: MetadataDiscovery {
    let records: [ClientId: [ClientMetadata]]
    func candidates(for clientId: ClientId) async throws -> [ClientMetadata] { records[clientId] ?? [] }
}

struct SlotFixtureReader: MetadataReader {
    func metadata(at slot: MetadataSlot) async throws -> ClientMetadata? {
        switch slot {
        case .codexUserBin: return ClientMetadata(identity:.codexBundle,installationIdentity:"slot-codex",version:"0.166.0",executable:true)
        case .claudeDesktopBundle: return ClientMetadata(identity:.claudeDesktopBundle,installationIdentity:"slot-desktop",version:"1.0.0",executable:true)
        default:return nil
        }
    }
}
struct FailingFixtureDiscovery: MetadataDiscovery {
    func candidates(for clientId:ClientId) async throws -> [ClientMetadata] {
        throw NSError(domain:"private-fixture-path-canary",code:1)
    }
}

func profileTests() async throws {
    let now = Date(timeIntervalSince1970: 1793448000)
    let known = ClientMetadata(identity: .codexBundle, installationIdentity: "bundle-one",
                               version: "0.166.0-alpha.5.1", executable: true)
    let snapshots = try await ClientProfiles.detect(using: FixtureMetadata(records: [.codexLocal:[known]]), now:now)
    Check.that(snapshots.count == 3, "all fixed surfaces remain truthful")
    let codex = snapshots[0]
    Check.that(codex.clientId == .codexLocal && codex.availability == .writerUnavailable, "known Codex cannot enable uncertified writer")
    Check.that(codex.allowedActions.isEmpty && codex.credentialState == .grantRequired, "first use needs product grant, never a manual token")
    Check.that(codex.protocolCheck == .notChecked && codex.clientLoad == .unknown, "metadata is not protocol proof")
    Check.that(snapshots[1].availability == .notDetected, "not in locations is not globally installed")
    let aliases = try await ClientProfiles.detect(using: FixtureMetadata(records:[.codexLocal:[known,known]]), now:now)
    Check.that(aliases[0].availability == .writerUnavailable, "aliases of same installation not ambiguous")
    let other = ClientMetadata(identity:.codexBundle,installationIdentity:"bundle-two",version:"0.166.0",executable:true)
    let ambiguous = try await ClientProfiles.detect(using: FixtureMetadata(records:[.codexLocal:[known,other]]),now:now)
    Check.that(ambiguous[0].availability == .ambiguousInstallation && ambiguous[0].safeVersion == nil, "distinct installations never choose a winner")
    let desktop = ClientMetadata(identity:.claudeDesktopBundle,installationIdentity:"desktop-one",version:"1.0.0",executable:true)
    let claude = ClientMetadata(identity:.claudeCodePackage,installationIdentity:"code-one",version:"2.1.0",executable:true)
    let unsupported = try await ClientProfiles.detect(using: FixtureMetadata(records:[.claudeDesktop:[desktop],.claudeCodeLocal:[claude]]),now:now)
    Check.that(unsupported[2].availability == .providerManaged && unsupported[2].allowedActions.isEmpty, "Desktop is provider managed")
    Check.that(unsupported[1].availability == .writerUnavailable && unsupported[1].allowedActions.isEmpty, "Claude Code not certified by a package name")
    let wrong = ClientMetadata(identity:.claudeCodePackage,installationIdentity:"wrong",version:"2.1.0",executable:true)
    let spoof = try await ClientProfiles.detect(using: FixtureMetadata(records:[.codexLocal:[wrong]]),now:now)
    Check.that(spoof[0].availability == .unsupportedProfile, "wrong vendor identity not Codex")
    let unversioned = ClientMetadata(identity:.codexBundle,installationIdentity:"unknown",version:nil,executable:true)
    let unknown = try await ClientProfiles.detect(using: FixtureMetadata(records:[.codexLocal:[unversioned]]),now:now)
    Check.that(unknown[0].availability == .unsupportedProfile && unknown[0].allowedActions.isEmpty, "unknown version cannot mutate")
    let cap = try await ClientProfiles.detect(using: FixtureMetadata(records:[.codexLocal:Array(repeating:known,count:17)]),now:now)
    Check.that(cap[0].availability == .unsupportedProfile, "candidate limit is enforced before deduplication")
    let fixed=try await ClientProfiles.detect(using:FixedMetadataDiscovery(reader:SlotFixtureReader()),now:now)
    Check.that(fixed[0].availability == .writerUnavailable && fixed[1].availability == .notDetected && fixed[2].availability == .providerManaged, "fixed location slots cannot cross client surfaces")
    let failed=try await ClientProfiles.detect(using:FailingFixtureDiscovery(),now:now)
    Check.that(failed.allSatisfy { $0.availability == .unsupportedProfile && $0.reasonCodes == [.metadataUnavailable] }, "metadata failure is a bounded state")
    let failureJSON=try JSONEncoder().encode(failed)
    Check.that(!String(decoding:failureJSON,as:UTF8.self).contains("private-fixture-path-canary"), "metadata errors never expose underlying paths")
    let privateJSON = try JSONEncoder().encode(codex)
    Check.that(!String(decoding:privateJSON,as:UTF8.self).contains("bundle-one"), "private canonical installation identity not published")
}
