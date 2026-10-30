import AppKit
import WebKit

@available(macOS 11.3, *)
@MainActor final class Scenario {
    let root: URL
    var controller: StickerApp!
    var external: [URL] = []
    var checks = 0
    init(root: URL) {
        self.root = root
        let install = Installation(root: root, docker: "/unused/mock/docker", context: "fixture", project: "fixture", resources: root)
        controller = StickerApp(installation: install, externalOpener: { [weak self] url in
            self?.external.append(url)
            // Dispatch must remain in the fixture; never NSWorkspace.open.
            print("INTERCEPT external \(url.absoluteString)"); fflush(stdout)
        }, dataStore: .nonPersistent())
    }
    func log(_ text: String) { print(text); fflush(stdout) }
    func check(_ condition: Bool, _ text: String) throws {
        guard condition else { throw NSError(domain: "Fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
        checks += 1; log("PASS \(text)")
    }
    func pause(_ seconds: Double = 0.3) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    func js(_ code: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in controller.webView.evaluateJavaScript(code) { value, error in if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value) } } }
    }
    func status(_ ready: Bool) throws {
        let origin = try String(contentsOf: root.appendingPathComponent("origin"), encoding: .utf8)
        let object: [String: Any] = ["schemaVersion": 1, "state": ready ? "ready" : "stopped", "containerRunning": ready, "appResponse": ready ? "verified" : "not_checked", "browserReachability": "unverified", "daemon": "local_socket", "url": origin, "urlScope": "docker_host", "reason": ready ? "none" : "stopped", "action": "none", "lockName": ""]
        try JSONSerialization.data(withJSONObject: object).write(to: root.appendingPathComponent("status.json"))
    }
    func waitForDocument() async throws {
        for _ in 0..<100 { if (try? await js("typeof window.docID")) as? String == "string" { return }; await pause(0.1) }
        throw NSError(domain: "Fixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "document timeout"])
    }
    func run() async {
        do {
            await pause(0.5)
            try check(controller.webView.url == nil, "stopped service does not load or start")
            let initialMode = ProcessInfo.processInfo.environment["STICKER_FIXTURE_MODE"] ?? "normal"
            if initialMode == "first-failure" {
                try "no".write(to: root.appendingPathComponent("online"), atomically: false, encoding: .utf8)
                try status(true); controller.refreshAndOpen(); await pause(1)
                try check((try? await js("window.docID")) as? String == nil, "failed first load has no synthetic document")
                try "yes".write(to: root.appendingPathComponent("online"), atomically: false, encoding: .utf8)
            }
            try status(true); controller.refreshAndOpen()
            try await waitForDocument()
            let document = try await js("window.docID") as? String
            try check(document != nil, "first ready load")
            let mode = ProcessInfo.processInfo.environment["STICKER_FIXTURE_MODE"] ?? "normal"
            if mode == "busy-quit" {
                try Data().write(to: root.appendingPathComponent("busy"))
                controller.refresh(); await pause(0.2)
                log("PASS busy quit requested while owned mock task runs")
                NSApp.terminate(nil)
                return
            }
            if mode == "open-quit" || mode == "save-quit" {
                controller.webView.evaluateJavaScript(mode == "open-quit" ? "document.querySelector('#file').click()" : "document.querySelector('#blob').click()", completionHandler: nil)
                for _ in 0..<30 { if controller.window.attachedSheet != nil { break }; await pause(0.1) }
                try check(controller.window.attachedSheet is NSSavePanel, "pending file panel ready for quit")
                log("PASS file panel quit requested")
                NSApp.terminate(nil)
                return
            }
            if mode == "download" {
                controller.webView.evaluateJavaScript("document.querySelector('#blob').click()", completionHandler: nil)
                for _ in 0..<30 { if controller.window.attachedSheet != nil { break }; await pause(0.1) }
                guard let panel = controller.window.attachedSheet as? NSSavePanel else { throw NSError(domain:"Fixture",code:3,userInfo:[NSLocalizedDescriptionKey:"save panel absent"]) }
                _ = panel // Choose the destination through actual UI; post-presentation properties do not update the native sheet.
                log("READY choose through native UI: \(root.path)/product-download.txt")
                let target = root.appendingPathComponent("product-download.txt")
                for _ in 0..<1800 { if FileManager.default.fileExists(atPath: target.path) { break }; await pause(0.1) }
                try check(try Data(contentsOf: target) == Data("Sticker synthetic download 한글\n".utf8), "product Blob save exact bytes")
                controller.webView.evaluateJavaScript("document.querySelector('#blob').click()", completionHandler: nil)
                for _ in 0..<30 { if controller.window.attachedSheet != nil { break }; await pause(0.1) }
                try check(controller.window.attachedSheet is NSSavePanel, "second download save panel")
                if let sheet = controller.window.attachedSheet { controller.window.endSheet(sheet, returnCode: .cancel) }
                await pause()
                try check(try Data(contentsOf: target) == Data("Sticker synthetic download 한글\n".utf8), "download cancellation preserves saved file")
                log("PASS product download save and cancel")
                NSApp.terminate(nil)
                return
            }
            if mode == "duplicate" {
                let duplicate = Process()
                duplicate.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                duplicate.arguments = ["-n", "-a", Bundle.main.bundleURL.path]
                try duplicate.run()
                await pause(2)
                let matching = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier!).filter { $0.bundleURL?.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL }
                try check(matching.count == 1, "explicit duplicate launch coalesces to one installed app instance")
            }
            _ = try await js("document.querySelector('#draft').value='보존할 합성 입력';history.pushState({},'', '#work');window.scrollTo(0,900)")
            await pause()
            let scroll = try await js("scrollY") as? Double
            for _ in 0..<10 { controller.openWindow() }
            controller.window.close(); controller.openWindow()
            controller.window.miniaturize(nil); controller.openWindow()
            await pause()
            try check(try await js("window.docID") as? String == document, "repeat focus close reopen minimize keep document")
            try check(try await js("document.querySelector('#draft').value") as? String == "보존할 합성 입력", "draft survives")
            try check(try await js("location.hash") as? String == "#work", "route survives")
            try check(try await js("scrollY") as? Double == scroll, "scroll survives")
            try "no".write(to: root.appendingPathComponent("online"), atomically: false, encoding: .utf8)
            try status(false); controller.refreshAndOpen(); await pause()
            _ = try await js("window.network='pending';fetch('/metrics').then(()=>{window.network='unexpected'}).catch(()=>{window.network='failed'});void 0")
            await pause()
            try check(try await js("window.network") as? String == "failed", "actual service request fails during outage")
            try check(try await js("window.docID") as? String == document, "service outage does not reload draft")
            try "yes".write(to: root.appendingPathComponent("online"), atomically: false, encoding: .utf8)
            try status(true); controller.refreshAndOpen(); await pause()
            _ = try await js("window.network='pending';fetch('/metrics').then(r=>r.json()).then(x=>{window.network=x.loads}).catch(()=>{window.network='failed'});void 0")
            await pause()
            try check(try await js("window.network") as? Int == 1, "service requests recover with one document load")
            try check(try await js("window.docID") as? String == document, "service recovery does not reload draft")
            _ = try await js("history.pushState({},'', '#second')")
            controller.back(); await pause()
            try check(try await js("location.hash") as? String == "#work", "back returns to prior route")
            controller.window.setContentSize(NSSize(width:375,height:600)); await pause()
            try check(try await js("innerWidth") as? Int == 375, "375px native content width")
            _ = try await js("location.href='https://example.invalid/automatic'")
            await pause()
            try check(try await js("window.docID") as? String == document, "automatic external navigation blocked")
            _ = try await js("document.querySelector('#external').click()")
            await pause()
            try check(external.count == 1, "explicit external link intercepted without browser")
            _ = try await js("(()=>{let f=document.createElement('iframe');f.id='untrusted';document.body.append(f);f.contentDocument.body.innerHTML='<a id=escape target=_top href=https://example.invalid/frame>escape</a>';f.contentDocument.querySelector('a').click();return true})()")
            await pause()
            let frameDocument = try await js("window.docID") as? String
            try check(external.count == 1 && frameDocument == document, "subframe top navigation cannot dispatch or replace page")
            controller.webView.evaluateJavaScript("document.querySelector('#file').click()", completionHandler: nil)
            await pause()
            try check(controller.window.attachedSheet is NSOpenPanel, "file selection uses native panel")
            if let sheet = controller.window.attachedSheet { controller.window.endSheet(sheet, returnCode: .cancel) }
            await pause()
            try check(try await js("document.querySelector('#file').files.length") as? Int == 0, "file selection cancellation preserves empty selection")
            controller.webView.evaluateJavaScript("window.answer=confirm('fixture pending confirm')", completionHandler: nil)
            await pause()
            try check(controller.window.attachedSheet != nil, "JavaScript confirm has native sheet")
            if let sheet = controller.window.attachedSheet { controller.window.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
            await pause()
            try check(try await js("window.answer") as? Bool == false, "confirm cancellation callback")
            controller.webView.evaluateJavaScript("window.answer=confirm('fixture quit confirm')", completionHandler: nil)
            await pause()
            try check(controller.window.attachedSheet != nil, "pending quit sheet ready")
            log("PASS \(checks) product controller checks; requesting quit through delegate")
            NSApp.terminate(nil)
        } catch { log("FAIL \(error)"); exit(1) }
    }
}
@main struct ScenarioMain {
    @MainActor static func main() {
        guard #available(macOS 11.3, *), let resource = Bundle.main.resourceURL,
              let path = try? String(contentsOf: resource.appendingPathComponent("fixture-root"), encoding: .utf8) else { exit(2) }
        let root = URL(fileURLWithPath: path.trimmingCharacters(in: .whitespacesAndNewlines))
        guard root.path.hasPrefix("/private/tmp/sticker-product-") else { exit(2) }
        let app = StickerApplication.shared; app.setActivationPolicy(.regular)
        let scenario = Scenario(root: root)
        app.delegate = scenario.controller
        let deadline: Double = ProcessInfo.processInfo.environment["STICKER_FIXTURE_MODE"] == "download" ? 200 : 100
        Timer.scheduledTimer(withTimeInterval: deadline, repeats: false) { _ in print("FAIL overall timeout"); fflush(stdout); exit(1) }
        Task { await scenario.run() }
        withExtendedLifetime(scenario) { app.run() }
    }
}
