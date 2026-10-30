// STK-71 synthetic feasibility fixture. No production configuration or JS/native bridge.
import AppKit
import WebKit

struct Fixture: Decodable {
    let directory: String
    let trace: String
    let origin: String
    let url: String
}

@MainActor
final class Probe: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var config: Fixture!
    var initial = true
    var stopped = false
    var quitPending = false
    var pendingPanels = 0
    var downloads: [WKDownload] = []

    func log(_ event: String) {
        print(event)
        guard let config else { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: ["event": event, "at": ISO8601DateFormatter().string(from: Date())])
            let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: config.trace))
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data + Data([10]))
        } catch {
            stopped = true
            web?.stopLoading()
            window?.orderOut(nil)
            print("STOP fixture_trace_unavailable")
        }
    }

    func origin(_ url: URL?) -> String? {
        guard let url, url.absoluteString.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }),
              !url.absoluteString.contains("\\"), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme == "http", c.user == nil, c.password == nil,
              let host = c.host, ["127.0.0.1", "localhost"].contains(host) else { return nil }
        let port = c.port ?? 80
        guard (1...65535).contains(port) else { return nil }
        return "http://\(host):\(port)"
    }
    func trusted(_ frame: WKFrameInfo) -> Bool { frame.isMainFrame && origin(frame.request.url) == config.origin }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard let path = Bundle.main.url(forResource: "fixture", withExtension: "json") else { throw CocoaError(.fileReadNoSuchFile) }
            let candidate = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
            guard candidate.directory.range(of: "^/(private/)?tmp/sticker-window-[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
                  candidate.trace == candidate.directory + "/trace.jsonl", origin(URL(string: candidate.url)) == candidate.origin,
                  candidate.url == candidate.origin + "/" else { throw CocoaError(.fileReadCorruptFile) }
            config = candidate
        } catch { print("STOP invalid_fixture"); NSApp.terminate(nil); return }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Sticker Swift Window Fixture — NOT production"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: window.contentView!.bounds, configuration: settings)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView!.addSubview(web)
        let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        let quit = NSMenuItem(title: "Quit Fixture", action: #selector(requestQuit), keyEquivalent: "q")
        quit.target = self; appMenu.addItem(quit); appItem.submenu = appMenu; menu.addItem(appItem)
        let editItem = NSMenuItem(), edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key))
        }
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
        window.center(); log("created"); show()
        if !stopped { web.load(URLRequest(url: URL(string: config.url)!)) }
    }
    func show() {
        guard !stopped, window != nil else { return }
        window.deminiaturize(nil); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true); log("focus")
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if pendingPanels > 0 { log("hide_deferred_for_panel"); return false }; sender.orderOut(nil); log("hidden"); return false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if pendingPanels > 0 { log("quit_cancelled_for_panel"); return .terminateCancel }
        log("os_quit"); return .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func sheet(_ message: String, completion: @escaping (Bool) -> Void) {
        guard !stopped else { completion(false); return }
        let alert = NSAlert(); alert.messageText = "Sticker fixture · " + config.origin
        alert.informativeText = String(message.prefix(400))
        alert.addButton(withTitle: "확인").keyEquivalent = "\r"
        alert.addButton(withTitle: "취소").keyEquivalent = "\u{1b}"
        var finished = false; pendingPanels += 1
        alert.beginSheetModal(for: window) { response in
            guard !finished else { return }; finished = true; self.pendingPanels -= 1
            completion(response == .alertFirstButtonReturn)
        }
    }
    @objc func requestQuit() {
        guard !stopped, !quitPending, pendingPanels == 0 else { return }; quitPending = true
        sheet("시험 앱을 종료할까요? 입력은 저장되지 않습니다.") { accepted in
            self.quitPending = false; self.log(accepted ? "quit_confirmed" : "quit_cancelled")
            if accepted { NSApp.terminate(nil) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !stopped, let url = action.request.url else { decisionHandler(.cancel); return }
        if initial && url.absoluteString == config.url && action.targetFrame?.isMainFrame == true {
            initial = false; log("initial_navigation"); decisionHandler(.allow); return
        }
        guard trusted(action.sourceFrame) else { log("untrusted_frame_cancelled"); decisionHandler(.cancel); return }
        if action.shouldPerformDownload && (origin(url) == config.origin || url.absoluteString.hasPrefix("blob:" + config.origin + "/")) {
            log("download_requested"); decisionHandler(.download); return
        }
        if origin(url) == config.origin && action.targetFrame?.isMainFrame == true {
            decisionHandler(.allow); return
        }
        // Explicit external link eligibility is recorded only: fixture never launches another application.
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if action.navigationType == .linkActivated, ["http", "https"].contains(c?.scheme ?? ""),
           c?.user == nil, c?.password == nil, let host = c?.host, !host.isEmpty,
           url.absoluteString.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }),
           !url.absoluteString.contains("\\") { log("external_link_cancelled") }
        else { log("navigation_cancelled") }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard !stopped, response.isForMainFrame, let url = response.response.url,
              origin(url) == config.origin || url.absoluteString.hasPrefix("blob:" + config.origin + "/") else {
            log("response_cancelled"); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { log("loaded") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { log("load_failed") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { stopped = true; log("renderer_terminated"); window.title = "STOP — renderer terminated" }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { log("popup_denied"); return nil }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard !stopped, trusted(frame) else { completionHandler(false); return }
        log("confirm_requested"); sheet(message) { accepted in self.log("confirm_completed"); completionHandler(accepted) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard !stopped, trusted(frame) else { completionHandler(); return }
        sheet(message) { _ in self.log("alert_completed"); completionHandler() }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard !stopped, trusted(frame) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: config.directory)
        log("upload_requested"); guard !stopped else { completionHandler(nil); return }
        var finished = false; pendingPanels += 1
        panel.beginSheetModal(for: window) { response in
            guard !finished else { return }; finished = true; self.pendingPanels -= 1
            guard response == .OK, let url = panel.url, url.path == self.config.directory + "/upload.txt" else {
                self.log("upload_cancelled"); completionHandler(nil); return
            }
            self.log("upload_selected"); completionHandler([url])
        }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { downloads.append(download); download.delegate = self; log("download_created") }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { downloads.append(download); download.delegate = self; log("download_created") }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard !stopped else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.directoryURL = URL(fileURLWithPath: config.directory); panel.nameFieldStringValue = "download.txt"; panel.canCreateDirectories = false
        log("download_save_requested"); guard !stopped else { completionHandler(nil); return }
        var finished = false; pendingPanels += 1
        panel.beginSheetModal(for: window) { response in
            guard !finished else { return }; finished = true; self.pendingPanels -= 1
            guard response == .OK, let url = panel.url, url.path == self.config.directory + "/download.txt",
                  !FileManager.default.fileExists(atPath: url.path) else {
                self.log("download_destination_cancelled"); completionHandler(nil); return
            }
            self.log("download_destination_selected"); completionHandler(url)
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) { log("download_redirect_denied"); decisionHandler(.cancel) }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeAll { $0 === download }; log("download_finished") }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloads.removeAll { $0 === download }; log("download_failed") }
}

@main
struct FixtureMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let probe = Probe()
        application.setActivationPolicy(.regular)
        application.delegate = probe
        withExtendedLifetime(probe) { application.run() }
    }
}
