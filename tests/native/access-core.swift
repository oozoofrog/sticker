import Foundation

@main struct CoreTests {
    static func main() throws {
        var count = 0
        func check(_ value: @autoclosure () -> Bool, _ name: String) {
            guard value() else { fputs("FAIL \(name)\n", stderr); exit(1) }
            count += 1
        }
        let valid: [String: Any] = ["schemaVersion": 1, "state": "ready", "containerRunning": true, "appResponse": "verified", "browserReachability": "unverified", "daemon": "local_socket", "url": "http://localhost:8787", "urlScope": "docker_host", "reason": "none", "action": "none", "lockName": ""]
        func snapshot(_ edits: [String: Any] = [:]) -> AccessSnapshot? {
            AccessSnapshot.parse(try! JSONSerialization.data(withJSONObject: valid.merging(edits) { _, new in new }))
        }
        check(snapshot()?.localReadyURL?.absoluteString == "http://localhost:8787", "verified loopback")
        check(snapshot(["daemon": "remote"])?.localReadyURL == nil, "remote is not local readiness")
        check(snapshot(["containerRunning": false]) == nil, "contradictory ready")
        check(snapshot(["appResponse": "unavailable"]) == nil, "unverified ready")
        check(snapshot(["schemaVersion": 2]) == nil, "unknown schema")
        check(snapshot(["state": "future"]) == nil, "unknown state")
        check(snapshot(["lockName": "../x"]) == nil, "invalid lock")
        check(AccessSnapshot.parse(Data(repeating: 32, count: 16385)) == nil, "bounded output")
        for value in ["https://localhost:8787", "http://evil.test", "http://localhost:65536", "http://localhost:0", "http://localhost:8787/path", "http://user@localhost", "http://127.0.0.1.evil", "http://localhost%2f.evil", "http://localhost:08787"] {
            check(snapshot(["url": value]) == nil, "reject origin \(value)")
        }
        check(snapshot(["url": "http://127.0.0.1"]) != nil, "default port")
        let origin = URL(string: "http://localhost:8787")!
        check(NavigationPolicy.classify(URL(string: "http://localhost:8787/#issue=abc")!, origin: origin, explicit: false, mainFrame: true) == .internalPage, "same origin route")
        check(NavigationPolicy.classify(URL(string: "https://github.com/oozoofrog/sticker")!, origin: origin, explicit: true, mainFrame: true) == .externalLink, "explicit external")
        check(NavigationPolicy.classify(URL(string: "https://github.com")!, origin: origin, explicit: false, mainFrame: true) == .deny, "automatic external")
        check(NavigationPolicy.classify(origin, origin: origin, explicit: true, mainFrame: false) == .deny, "subframe")
        check(NavigationPolicy.classify(URL(string: "https://user:pass@example.com")!, origin: origin, explicit: true, mainFrame: true) == .deny, "credential URL")
        check(NavigationPolicy.classify(URL(string: "file:///etc/passwd")!, origin: origin, explicit: true, mainFrame: true) == .deny, "file navigation")
        check(NavigationPolicy.isDownloadURL(URL(string: "blob:http://localhost:8787/uuid")!, origin: origin), "own blob")
        check(!NavigationPolicy.isDownloadURL(URL(string: "blob:http://localhost:87870/uuid")!, origin: origin), "foreign blob")
        var state = WindowState()
        check(state.open(readyOrigin: nil) == .showStatus, "stopped does not load")
        check(state.open(readyOrigin: origin) == .load(origin), "first open loads")
        check(state.open(readyOrigin: origin) == .focus, "pending open coalesced")
        state.didFail()
        check(state.open(readyOrigin: origin) == .load(origin), "explicit failed-first-load retry")
        state.didLoad()
        check(state.open(readyOrigin: nil) == .focus, "service outage keeps page")
        check(state.open(readyOrigin: origin) == .focus, "recovery keeps draft")
        check(state.open(readyOrigin: URL(string: "http://localhost:9999")!) == .originChanged, "changed origin does not replace draft")
        var calls = 0
        let completion = CompletionOnce<Bool> { _ in calls += 1 }
        completion.resolve(false); completion.resolve(true)
        check(calls == 1, "panel completion once")
        let lines = "sticker-access-v2\n/tmp/source 한글\n/usr/local/bin/docker\ndesktop-linux\nsticker\n"
        check(Installation.parseManifest(lines)?.context == "desktop-linux", "manifest context")
        check(Installation.parseManifest(lines)?.project == "sticker", "manifest project")
        check(Installation.parseManifest(lines.replacingOccurrences(of: "desktop-linux", with: "x\ny")) == nil, "manifest line injection")
        check(Installation.parseManifest(lines.replacingOccurrences(of: "/tmp/source 한글", with: "relative")) == nil, "manifest absolute root")
        check(Installation.parseManifest(lines.replacingOccurrences(of: "sticker-access-v2", with: "foreign")) == nil, "manifest ownership")
        print("PASS \(count) native core checks")
    }
}
