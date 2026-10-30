import AppKit
import WebKit

@available(macOS 11.3, *)
final class Race: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKDownloadDelegate {
    let root: URL
    let web = WKWebView()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    var index = -1
    var active: WKDownload?
    var timeout: Timer?
    let sentinel = Data("existing synthetic data must survive\n".utf8)
    init(root: URL) { self.root = root }
    func log(_ text: String) { print(text); fflush(stdout) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Sticker download race fixture"
        window.contentView = web
        window.orderFront(nil)
        web.navigationDelegate = self
        timeout = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { _ in self.log("FAIL timeout"); exit(1) }
        web.loadHTMLString("<html><body>synthetic download race</body></html>", baseURL: URL(string: "http://127.0.0.1"))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { next() }
    func next() {
        guard index < 3 else { log("PASS 3 actual WebKit destination races"); exit(0) }
        web.evaluateJavaScript("(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['new download bytes']));a.download='race.txt';document.body.append(a);a.click();a.remove()})()") { _, error in if let error { self.log("FAIL javascript \(error)"); exit(1) } }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(action.shouldPerformDownload ? .download : .allow) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { active = download; download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let target = root.appendingPathComponent("race-\(index)")
        do {
            guard !FileManager.default.fileExists(atPath: target.path) else { throw CocoaError(.fileWriteFileExists) }
            // The competitor wins after the application checks absence, before WebKit receives its destination.
            if index == 0 { try sentinel.write(to: target, options: .withoutOverwriting) }
            if index == 1 {
                try sentinel.write(to: root.appendingPathComponent("symlink-target"), options: .withoutOverwriting)
                try FileManager.default.createSymbolicLink(at: target, withDestinationURL: root.appendingPathComponent("symlink-target"))
            }
            if index == 2 { try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false) }
            log("race-created \(index)")
            completionHandler(target)
            if index >= 0 {
                let capturedIndex = index
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    guard self.index == capturedIndex, let active = self.active else { return }
                    self.log("cancel-stalled-race \(capturedIndex)")
                    active.cancel { _ in DispatchQueue.main.async { if self.index == capturedIndex { self.verify(result: "cancelled") } } }
                }
            }
        } catch { log("FAIL setup \(error)"); exit(1) }
    }
    func downloadDidFinish(_ download: WKDownload) { verify(result: "finished") }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { verify(result: "failed:\((error as NSError).code)") }
    func verify(result: String) {
        let target = root.appendingPathComponent("race-\(index)")
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: target.path)
            let expected: FileAttributeType = index <= 0 ? .typeRegular : index == 1 ? .typeSymbolicLink : .typeDirectory
            guard attrs[.type] as? FileAttributeType == expected else { throw CocoaError(.fileWriteUnknown) }
            if index < 2 { guard try Data(contentsOf: target) == (index == -1 ? Data("new download bytes".utf8) : sentinel) else { throw CocoaError(.fileWriteUnknown) } }
            guard (index == -1 ? result == "finished" : (result.hasPrefix("failed:") || result == "cancelled")) else { throw CocoaError(.fileWriteUnknown) }
            log("preserved \(index) \(result)")
            index += 1; active = nil
            DispatchQueue.main.async { self.next() }
        } catch { log("FAIL clobber-or-unexpected-success \(index) \(result) \(error)"); exit(1) }
    }
}
@main struct RaceMain {
    static func main() {
        guard CommandLine.arguments.count == 2, #available(macOS 11.3, *) else { exit(2) }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: root.path), attrs[.type] as? FileAttributeType == .typeDirectory, (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o700 else { exit(2) }
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        let delegate = Race(root: root); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
