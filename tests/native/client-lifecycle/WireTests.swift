import Foundation

func wireTests(fixtures:URL) throws {
    let rows = try JSONSerialization.jsonObject(with:Data(contentsOf:fixtures)) as! [[String:Any]]
    for row in rows {
        let data = try JSONSerialization.data(withJSONObject:row["value"]!)
        var accepted = false
        do {
            if row["kind"] as? String == "request" { _ = try LifecycleWire.decodeRequest(data) }
            else { try LifecycleWire.validateResponse(data) }
            accepted = true
        } catch {}
        Check.that(accepted == (row["valid"] as? Bool), "wire fixture \(row["name"]!)")
    }
    let base = Data(#"{"version":1,"requestId":"r","method":"detectClients","refreshMetadata":false}"#.utf8)
    var exact = base; exact.append(Data(repeating:32,count:65536-base.count))
    _ = try LifecycleWire.decodeRequest(exact)
    Check.that(true, "wire exact 64KiB accepted")
    exact.append(32)
    Check.rejects("wire rejects 64KiB+1") { _ = try LifecycleWire.decodeRequest(exact) }
    for input in [
        #"{"version":1,"requestId":"r","method":"cancelPlan","planId":"p","planId":"other"}"#,
        #"{"version":1,"requestId":"r","method":"cancelPlan","planId":"p","plan\u0049d":"other"}"#
    ] {
        Check.rejects("duplicate or escaped duplicate key rejected") { _ = try LifecycleWire.decodeRequest(Data(input.utf8)) }
    }
    let traversal = Data(#"{"version":1,"requestId":"r","method":"cancelPlan","planId":"../foreign"}"#.utf8)
    Check.rejects("opaque IDs cannot be paths") { _ = try LifecycleWire.decodeRequest(traversal) }
}
