import Foundation
import Darwin

func manifestFixture() -> OwnershipManifest {
    OwnershipManifest(schemaVersion:1,installationId:"installation-one",connectionId:"connection-one",clientId:.codexLocal,
                      targetKind:.codexUser,serverKey:"sticker",
                      managedEntryDigest:"d3b61d2bff01d9eb59d311bd2c41489fa55a0fc94f0b63287d6bafb2dacabc9d",ownershipRevision:2,creationOperationId:"operation-original",
                      launcherVersion:"1.0.0",credentialReferenceId:"reference-one",grant:GrantSummary(projectIds:["project-one"],canWrite:true),
                      grantOwnership:.exclusiveManaged,managedGrantId:"grant-one",managedGrantRevision:1,
                      lastProviderVersion:"version-one",transactionState:.committed,
                      cleanup:CleanupReceipts(configCompensation:.notNeeded,newGrantCleanup:.notCreated,secretCleanup:.notOwned))
}
func writeFixtureManifest(_ root:URL,_ data:Data) throws -> URL {
    let file = root.appendingPathComponent("connection-one.json")
    try data.write(to:file)
    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
    return file
}
func ownershipTests(output:URL) throws {
    let root = output.appendingPathComponent("ownership-fixture-" + UUID().uuidString,isDirectory:true)
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
    defer { try? FileManager.default.removeItem(at:root) }
    let encoded = try JSONEncoder().encode(manifestFixture())
    let file = try writeFixtureManifest(root,encoded)
    let store = try OwnedConnectionStore(root:root)
    let loaded=try store.load(connectionId:"connection-one")
    Check.that(loaded == manifestFixture(), "loads owned regular private manifest")
    let missing=try store.load(connectionId:"not-created")
    Check.that(missing == nil, "missing manifest distinct from corrupt")
    Check.rejects("connection identifier cannot escape root") { _ = try store.load(connectionId:"../foreign") }
    try FileManager.default.setAttributes([.posixPermissions:0o644],ofItemAtPath:file.path)
    Check.rejects("public manifest rejected") { _ = try store.load(connectionId:"connection-one") }
    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
    let linked = root.appendingPathComponent("linked.json")
    guard link(file.path,linked.path) == 0 else { throw LifecycleFailure.invalidStorage }
    Check.rejects("hard linked manifest rejected") { _ = try store.load(connectionId:"connection-one") }
    try FileManager.default.removeItem(at:linked)
    try FileManager.default.removeItem(at:file)
    try FileManager.default.createSymbolicLink(at:file,withDestinationURL:root.appendingPathComponent("nonexistent"))
    Check.rejects("symlink manifest rejected") { _ = try store.load(connectionId:"connection-one") }
    try FileManager.default.removeItem(at:file)
    _ = try writeFixtureManifest(root,Data(repeating:32,count:65537))
    Check.rejects("manifest bounded before parse") { _ = try store.load(connectionId:"connection-one") }
    let duplicate=String(decoding:encoded,as:UTF8.self).dropLast()+",\"serverKey\":\"sticker\"}"
    _ = try writeFixtureManifest(root,Data(duplicate.utf8))
    Check.rejects("duplicate manifest key is ambiguous") { _ = try store.load(connectionId:"connection-one") }
    var raw = try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
    raw["token"] = "fixture-secret-canary"
    _ = try writeFixtureManifest(root,JSONSerialization.data(withJSONObject:raw))
    Check.rejects("unknown secret field rejected") { _ = try store.load(connectionId:"connection-one") }
    raw.removeValue(forKey:"token")
    raw["lastProviderVersion"]="sha256:fixture/opaque=="
    _ = try writeFixtureManifest(root,JSONSerialization.data(withJSONObject:raw))
    let opaqueVersionManifest=try store.load(connectionId:"connection-one")
    Check.that(opaqueVersionManifest?.lastProviderVersion == "sha256:fixture/opaque==", "private stored provider version remains opaque")
    raw["connectionId"]="other-connection"
    _ = try writeFixtureManifest(root,JSONSerialization.data(withJSONObject:raw))
    Check.rejects("record must match requested connection") { _ = try store.load(connectionId:"connection-one") }
    _ = try writeFixtureManifest(root,encoded)
    try FileManager.default.setAttributes([.posixPermissions:0o755],ofItemAtPath:root.path)
    Check.rejects("nonprivate root rejected") { _ = try OwnedConnectionStore(root:root) }
    try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:root.path)
    let alias=output.appendingPathComponent("alias-"+UUID().uuidString)
    try FileManager.default.createSymbolicLink(at:alias,withDestinationURL:root)
    defer { try? FileManager.default.removeItem(at:alias) }
    Check.rejects("symlink root rejected") { _ = try OwnedConnectionStore(root:alias) }
    Check.rejects("wrong owner metadata rejected") { _ = try OwnedConnectionStore(root:root,expectedOwner:getuid()+1) }
}
