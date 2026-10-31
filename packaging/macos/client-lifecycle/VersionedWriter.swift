import Foundation

// Private provider contracts. These are not browser/MCP request DTOs.
struct ProviderWriteReceipt: Equatable {
    let version:String // Receipt only; never a subsequent expectedVersion.
    let overridden:Bool
}
// Applied means provider saved a leaf; it never establishes initialize/tools,
// effective policy, credential activation or a connected client.
enum ProviderWriteResult: Equatable {
    case applied(ProviderWriteReceipt), conflict, invalid, unavailable, uncertain, operationConflict
    var isApplied:Bool { if case .applied = self { return true };return false }
    var isOverridden:Bool { if case .applied(let receipt) = self { return receipt.overridden };return false }
}
enum ProviderOperationState: Equatable { case unknown, recorded(ProviderWriteResult) }
protocol VersionedWriter: Actor {
    func readOwnedTarget(profileId:ClientId,connectionId:String) async throws -> PrivateConfigSnapshot
    func applyOwnedPatch(expectedVersion:String,patch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult
    func readOperation(operationId:String) async -> ProviderOperationState
    func restoreOwnedPatch(expectedCurrentVersion:String,inversePatch:ExactOwnedPatch,operationId:String) async -> ProviderWriteResult
}
struct VerifiedClientIdentity {
    let clientId:ClientId
    let installationId:String
    let version:String
}
struct CertifiedWriter { let writer:any VersionedWriter }
struct WriterRegistry {
    // No runtime/profile is certified by injected tests or older public schema.
    // In particular installed 0.166 and recorded 0.165 remain unavailable.
    func writer(for identity:VerifiedClientIdentity) -> CertifiedWriter? { nil }
}
