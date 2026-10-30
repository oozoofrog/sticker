import Foundation

private func matches(_ text: String, _ pattern: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) == text.startIndex..<text.endIndex
}

struct AccessSnapshot: Decodable {
    let schemaVersion: Int
    let state: String
    let containerRunning: Bool?
    let appResponse: String
    let browserReachability: String
    let daemon: String
    let url: String?
    let urlScope: String
    let reason: String
    let action: String
    let lockName: String

    static func parse(_ data: Data) -> AccessSnapshot? {
        guard data.count <= 16384,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              ["schemaVersion", "state", "containerRunning", "appResponse", "browserReachability", "daemon", "url", "urlScope", "reason", "action", "lockName"].allSatisfy({ object.keys.contains($0) }),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              value.schemaVersion == 1,
              ["docker_missing", "daemon_unavailable", "not_installed", "stopped", "starting", "ready", "unknown"].contains(value.state),
              ["none", "opened", "url_only", "started", "stopped", "busy", "failed"].contains(value.action),
              ["verified", "unavailable", "not_checked"].contains(value.appResponse),
              value.browserReachability == "unverified", value.urlScope == "docker_host",
              ["local_socket", "remote", "unknown"].contains(value.daemon),
              matches(value.reason, "^[a-z_]{1,80}$"),
              value.lockName.isEmpty || matches(value.lockName, "^sticker-control-[0-9]+-[0-9]+$"),
              value.url == nil || Self.loopbackURL(value.url!) != nil,
              value.state != "ready" || (value.containerRunning == true && value.appResponse == "verified") else { return nil }
        return value
    }
    static func loopbackURL(_ value: String) -> URL? {
        guard matches(value, "^http://(localhost|127\\.0\\.0\\.1)(:[1-9][0-9]{0,4})?$"),
              let url = URL(string: value), let port = URLComponents(url: url, resolvingAgainstBaseURL: false).map({ $0.port ?? 80 }),
              (1...65535).contains(port) else { return nil }
        return url
    }
    var localReadyURL: URL? {
        guard state == "ready", daemon == "local_socket", reason == "none", !["failed", "busy"].contains(action), let url else { return nil }
        return Self.loopbackURL(url)
    }
    var canStart: Bool { state == "stopped" || state == "not_installed" }
    var label: String {
        let labels = ["docker_missing": "Docker 없음", "daemon_unavailable": "Docker 연결 불가", "not_installed": "서비스 미설치", "stopped": "서비스 중지", "starting": "서비스 준비 중", "ready": "앱 응답 확인", "unknown": "상태 미확인"]
        if daemon == "remote" { return "원격 Docker · 이 맥의 창에서는 열 수 없습니다" }
        if action == "busy" { return "다른 제어 작업 중" }
        if action == "failed" { return (labels[state] ?? "상태 미확인") + " · 요청 실패" }
        return labels[state] ?? "상태 미확인"
    }
}

struct Installation {
    let root: URL
    let docker: String
    let context: String
    let project: String
    var resources: URL = URL(fileURLWithPath: "/")

    static func parseManifest(_ text: String) -> Installation? {
        let lines = text.components(separatedBy: "\n")
        guard lines.count == 6, lines[0] == "sticker-access-v2", lines[5].isEmpty,
              lines[1].hasPrefix("/"), lines[2].hasPrefix("/"),
              lines[1...4].allSatisfy({ !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }),
              matches(lines[3], "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$"),
              lines[4].isEmpty || matches(lines[4], "^[a-z0-9][a-z0-9_-]*$") else { return nil }
        return Installation(root: URL(fileURLWithPath: lines[1], isDirectory: true), docker: lines[2], context: lines[3], project: lines[4])
    }
    static func load(resources: URL) throws -> Installation {
        let manifest = resources.appendingPathComponent("sticker-source")
        let attributes = try FileManager.default.attributesOfItem(atPath: manifest.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= 8192,
              var value = parseManifest(try String(contentsOf: manifest, encoding: .utf8)),
              FileManager.default.fileExists(atPath: value.root.appendingPathComponent("scripts/sticker.sh").path),
              FileManager.default.isExecutableFile(atPath: resources.appendingPathComponent("bin/docker").path) else { throw CocoaError(.fileReadCorruptFile) }
        value.resources = resources
        return value
    }
    var environment: [String: String] {
        var result = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("DOCKER_") && !$0.key.hasPrefix("COMPOSE_") }
        result["DOCKER_CONTEXT"] = context
        if !project.isEmpty { result["COMPOSE_PROJECT_NAME"] = project }
        result["PATH"] = resources.appendingPathComponent("bin").path + ":/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
        return result
    }
}

enum NavigationChoice: Equatable { case internalPage, externalLink, deny }
enum NavigationPolicy {
    static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        guard let a = URLComponents(url: url, resolvingAgainstBaseURL: false), let b = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              a.user == nil, a.password == nil, a.scheme == "http", a.host == b.host,
              (a.port ?? 80) == (b.port ?? 80), clean(url) else { return false }
        return true
    }
    static func clean(_ url: URL) -> Bool {
        url.absoluteString.unicodeScalars.allSatisfy { $0.value > 32 && $0.value < 127 } && !url.absoluteString.contains("\\")
    }
    static func classify(_ url: URL, origin: URL, explicit: Bool, mainFrame: Bool) -> NavigationChoice {
        guard mainFrame, clean(url) else { return .deny }
        if sameOrigin(url, origin) { return .internalPage }
        guard explicit, let c = URLComponents(url: url, resolvingAgainstBaseURL: false), ["http", "https"].contains(c.scheme ?? ""),
              c.user == nil, c.password == nil, let host = c.host, !host.isEmpty,
              (1...65535).contains(c.port ?? (c.scheme == "https" ? 443 : 80)) else { return .deny }
        return .externalLink
    }
    static func isDownloadURL(_ url: URL, origin: URL) -> Bool {
        sameOrigin(url, origin) || (clean(url) && url.absoluteString.hasPrefix("blob:" + origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/"))
    }
}

enum WindowAction: Equatable { case load(URL), focus, showStatus, originChanged }
struct WindowState {
    private(set) var origin: URL?
    private(set) var hasDocument = false
    private var loading = false
    mutating func open(readyOrigin: URL?) -> WindowAction {
        if let old = origin, let readyOrigin, old != readyOrigin { return .originChanged }
        if hasDocument || loading { return .focus }
        guard let readyOrigin else { return .showStatus }
        origin = readyOrigin; loading = true
        return .load(readyOrigin)
    }
    mutating func didLoad() { loading = false; hasDocument = true }
    mutating func didFail() { loading = false }
}

final class CompletionOnce<Value> {
    private var completion: ((Value) -> Void)?
    init(_ completion: @escaping (Value) -> Void) { self.completion = completion }
    func resolve(_ value: Value) {
        guard let callback = completion else { return }
        completion = nil
        callback(value)
    }
}
