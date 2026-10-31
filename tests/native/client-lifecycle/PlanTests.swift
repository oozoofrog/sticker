import Foundation

func fixtureEntry() -> OwnedLaunchEntry {
    OwnedLaunchEntry(installationId:"installation-one",connectionId:"connection-one",launcherVersion:"1.0.0",
                    enabledTools:["sticker_list_projects","sticker_get_issue"],disabledTools:["sticker_delete_issue"],
                    toolApprovals:["sticker_update_issue":"prompt"],unmanagedFields:["fixtureHint":.string("keep")])
}
func fixtureSnapshot(entry:OwnedLaunchEntry? = nil,version:String="version-one",parseStatus:ConfigParseStatus = .valid,bytes:Data = Data("# foreign comment\nmodel = 'fixture-model'\n".utf8)) -> PrivateConfigSnapshot {
    PrivateConfigSnapshot(clientId:.codexLocal,installationId:"installation-one",connectionId:"connection-one",
                          targetKind:.codexUser,providerVersion:version,rawBytes:bytes,ownedEntry:entry,parseStatus:parseStatus)
}
func fixtureIntent(_ action:ConnectionAction = .connect,revision:Int=0,project:String?="project-one",visibility:ToolVisibilityIntent = .preserve,launcher:String="2.0.0") -> ChangeIntent {
    ChangeIntent(action:action,clientId:.codexLocal,installationId:"installation-one",connectionId:"connection-one",
                 currentProjectId:project,expectedOwnershipRevision:revision,desiredLauncherVersion:launcher,
                 credentialReferenceId:"reference-one",visibility:visibility)
}
func planTests() throws {
    let now=Date(timeIntervalSince1970:1793448000)
    let planner=ConnectionPlanner()
    let originalBytes=Data("# foreign comment\nmodel = 'fixture-model'\n".utf8)
    let first=try planner.plan(snapshot:fixtureSnapshot(bytes:originalBytes),ownership:nil,intent:fixtureIntent(),now:now)
    Check.that(first.publicPlan.rights == GrantSummary(projectIds:["project-one"],canWrite:true), "new Connect has explicit current-project grant")
    Check.that(first.originalConfigBytes == originalBytes, "pure plan leaves complete foreign config and comments intact")
    Check.that(first.exactOwnedPatch.entry?.launcherVersion == "2.0.0" && first.inverseOwnedPatch.entry == nil, "new owned entry has inverse removal")
    Check.that(first.publicPlan.retainedFilters.approvalsPreserved, "planning cannot disable approval preservation")
    Check.that(LifecycleTime.date(first.publicPlan.expiresAt) == now.addingTimeInterval(300), "plan lasts exactly five minutes")
    try planner.validate(first,digest:first.publicPlan.digest,now:now.addingTimeInterval(299))
    Check.rejects("expired plan cannot authorize later action") { try planner.validate(first,digest:first.publicPlan.digest,now:now.addingTimeInterval(300)) }
    Check.rejects("different digest rejected") { try planner.validate(first,digest:String(repeating:"b",count:64),now:now) }
    let forged=PrivateConnectionPlan(publicPlan:first.publicPlan,exactOwnedPatch:ExactOwnedPatch(entry:nil),
                                      inverseOwnedPatch:first.inverseOwnedPatch,originalConfigBytes:first.originalConfigBytes,
                                      privateProviderVersion:first.privateProviderVersion,credentialReferenceId:first.credentialReferenceId)
    Check.rejects("private patch cannot change while reusing public digest") {
        try planner.validate(forged,digest:first.publicPlan.digest,now:now)
    }
    let encoded=try JSONEncoder().encode(first.publicPlan)
    let envelope=try JSONSerialization.data(withJSONObject:["version":1,"requestId":"r","method":"planChange","result":JSONSerialization.jsonObject(with:encoded)])
    try LifecycleWire.validateResponse(envelope)
    let publicText=String(decoding:encoded,as:UTF8.self)
    Check.that(!publicText.contains("fixture-model") && !publicText.contains("reference-one") && !publicText.contains("version-one"), "public plan cannot leak raw config, private reference or provider version")
    let entry=fixtureEntry()
    let fingerprint=try EntryFingerprint.digest(entry)
    Check.that(fingerprint == "d3b61d2bff01d9eb59d311bd2c41489fa55a0fc94f0b63287d6bafb2dacabc9d", "known independent canonical entry fingerprint")
    Check.rejects("same-name unowned entry cannot be adopted") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:nil,intent:fixtureIntent(),now:now)
    }
    let owned=manifestFixture()
    let update=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.update,revision:2,project:"other-project"),now:now)
    Check.that(update.publicPlan.rights.projectIds == ["project-one"], "ordinary update never widens or changes the existing grant")
    Check.that(update.exactOwnedPatch.entry?.enabledTools == ["sticker_list_projects","sticker_get_issue"], "existing allowlist retained")
    Check.that(update.exactOwnedPatch.entry?.disabledTools == ["sticker_delete_issue"], "existing denylist retained")
    Check.that(update.exactOwnedPatch.entry?.toolApprovals == ["sticker_update_issue":"prompt"], "per-tool approvals retained")
    Check.that(update.exactOwnedPatch.entry?.unmanagedFields == ["fixtureHint":.string("keep")], "unmanaged entry fields retained")
    Check.that(update.inverseOwnedPatch.entry == entry, "update inverse is exact prior owned leaf")
    let rotated=ChangeIntent(action:.update,clientId:.codexLocal,installationId:"installation-one",connectionId:"connection-one",
                             currentProjectId:"project-one",expectedOwnershipRevision:2,desiredLauncherVersion:"2.0.0",
                             credentialReferenceId:"reference-other",visibility:.preserve)
    Check.rejects("ordinary update cannot silently change private credential reference") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:rotated,now:now)
    }
    let removal=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.remove,revision:2),now:now)
    Check.that(removal.exactOwnedPatch.entry == nil && removal.inverseOwnedPatch.entry == entry, "Remove only plans exact owned-leaf deletion")
    var changed=entry;changed.launcherVersion="3.0.0"
    Check.rejects("user modified owned leaf conflicts") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:changed),ownership:owned,intent:fixtureIntent(.update,revision:2),now:now)
    }
    var foreign=owned;foreign.installationId="other-installation"
    Check.rejects("other installation cannot claim entry") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:foreign,intent:fixtureIntent(.remove,revision:2),now:now)
    }
    Check.rejects("stale ownership revision conflicts") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.update,revision:1),now:now)
    }
    Check.rejects("ambiguous provider parse rejected without rewriting") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(parseStatus:.ambiguous),ownership:nil,intent:fixtureIntent(),now:now)
    }
    Check.rejects("config bytes over 2MiB rejected") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(bytes:Data(repeating:32,count:2097153)),ownership:nil,intent:fixtureIntent(),now:now)
    }
    Check.rejects("missing current project never becomes global") {
        _ = try ConnectionPlanner().plan(snapshot:fixtureSnapshot(),ownership:nil,intent:fixtureIntent(project:nil),now:now)
    }
    let capped=ConnectionPlanner()
    for _ in 0..<4 { _ = try capped.plan(snapshot:fixtureSnapshot(),ownership:nil,intent:fixtureIntent(),now:now) }
    Check.rejects("fifth live plan for same client rejected") {
        _ = try capped.plan(snapshot:fixtureSnapshot(),ownership:nil,intent:fixtureIntent(),now:now)
    }
    _ = try capped.plan(snapshot:fixtureSnapshot(),ownership:nil,intent:fixtureIntent(),now:now.addingTimeInterval(300))
    Check.that(true,"expired plans release capacity")
    let one=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.update,revision:2),now:now,planId:"fixed-plan")
    let changedVisibility=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.update,revision:2,visibility:.replace(enabled:["sticker_list_projects"],disabled:[])),now:now,planId:"fixed-plan")
    Check.that(one.publicPlan.digest != changedVisibility.publicPlan.digest, "digest binds explicit visibility change")
    let opaqueVersion=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(version:"sha256:fixture/opaque=="),ownership:nil,intent:fixtureIntent(),now:now)
    Check.that(!opaqueVersion.publicPlan.expectedProviderVersion.contains(":") && opaqueVersion.privateProviderVersion == "sha256:fixture/opaque==", "provider versions are opaque privately and handles publicly")
    let changedVersion=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry,version:"version-two"),ownership:owned,intent:fixtureIntent(.update,revision:2),now:now,planId:"fixed-plan")
    Check.that(one.publicPlan.digest != changedVersion.publicPlan.digest, "digest binds provider version")
    let changedLauncher=try ConnectionPlanner().plan(snapshot:fixtureSnapshot(entry:entry),ownership:owned,intent:fixtureIntent(.update,revision:2,launcher:"2.0.1"),now:now,planId:"fixed-plan")
    Check.that(one.publicPlan.digest != changedLauncher.publicPlan.digest, "digest binds managed launcher version")
}
