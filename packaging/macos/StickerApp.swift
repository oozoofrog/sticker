import AppKit
import WebKit

@available(macOS 11.3, *)
@objc(StickerApplication)
final class StickerApplication: NSApplication {
    override func terminate(_ sender: Any?) {
        guard let controller = delegate as? StickerApp else { super.terminate(sender); return }
        // AppKit does not reach applicationShouldTerminate while a sheet is active.
        controller.cancelPanelsBeforeTermination { [weak self] in self?.terminateAfterPanels(sender) }
    }
    private func terminateAfterPanels(_ sender: Any?) { super.terminate(sender) }
}

@available(macOS 11.3, *)
final class StickerApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let installation: Installation
    let externalOpener: (URL) -> Void
    let webView: WKWebView
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let message = NSTextField(labelWithString: "서비스 상태를 확인합니다.")
    private var statusItem: NSStatusItem!
    private var statusLabel: NSMenuItem!
    private var state = WindowState()
    private var snapshot: AccessSnapshot?
    private var process: Process?
    private var poll: Timer?
    private var outputDirectory: URL?
    private var outputHandle: FileHandle?
    private var pendingOpen = false
    private var quitting = false
    private var repliedToQuit = false
    private var pendingDownloads: Set<ObjectIdentifier> = []
    private var panels: [UUID: () -> Void] = [:]
    private var panelTermination: (() -> Void)?
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var focusObserver: NSObjectProtocol?

    init(installation: Installation, externalOpener: @escaping (URL) -> Void = { NSWorkspace.shared.open($0) }, dataStore: WKWebsiteDataStore = .default()) {
        self.installation = installation
        self.externalOpener = externalOpener
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let identity = Bundle.main.bundleIdentifier ?? "org.oozoofrog.sticker.access"
        let notificationName = Notification.Name(identity + ".focus")
        // LaunchServices normally coalesces launches. Also handle explicit `open -n`.
        let own = NSRunningApplication.current
        let siblings = NSRunningApplication.runningApplications(withBundleIdentifier: identity).filter { candidate in
            guard candidate.processIdentifier != own.processIdentifier, let a = candidate.bundleURL, let b = own.bundleURL else { return false }
            let x = try? FileManager.default.attributesOfItem(atPath: a.path)
            let y = try? FileManager.default.attributesOfItem(atPath: b.path)
            return x?[.systemFileNumber] as? NSNumber == y?[.systemFileNumber] as? NSNumber && x?[.systemNumber] as? NSNumber == y?[.systemNumber] as? NSNumber && x != nil && y != nil
        }
        if let existing = siblings.filter({ ($0.launchDate ?? .distantPast) < (own.launchDate ?? .distantFuture) || ($0.launchDate == own.launchDate && $0.processIdentifier < own.processIdentifier) }).first {
            DistributedNotificationCenter.default().postNotificationName(notificationName, object: Bundle.main.bundleURL.path, userInfo: nil, deliverImmediately: true)
            existing.activate(options: [.activateIgnoringOtherApps])
            NSApp.terminate(nil)
            return
        }
        focusObserver = DistributedNotificationCenter.default().addObserver(forName: notificationName, object: Bundle.main.bundleURL.path, queue: .main) { [weak self] _ in self?.openWindow() }
        window.title = "스티커"
        window.minSize = NSSize(width: 375, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let retry = NSButton(title: "연결 다시 확인", target: self, action: #selector(refreshAndOpen))
        let banner = NSStackView(views: [message, retry])
        banner.orientation = .horizontal
        banner.spacing = 12
        banner.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        let content = NSStackView(views: [banner, webView])
        content.orientation = .vertical
        content.alignment = .width
        content.spacing = 0
        window.contentView = content
        webView.setContentHuggingPriority(.defaultLow, for: .vertical)
        setupMenus()
        openWindow()
    }
    private func setupMenus() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "스티커 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); main.addItem(edit); edit.submenu = NSMenu(title: "편집")
        for (name, selector, key) in [("실행 취소", "undo:", "z"), ("잘라내기", "cut:", "x"), ("복사", "copy:", "c"), ("붙여넣기", "paste:", "v"), ("모두 선택", "selectAll:", "a")] {
            edit.submenu?.addItem(withTitle: name, action: Selector(selector), keyEquivalent: key)
        }
        let navigation = NSMenuItem(); main.addItem(navigation); navigation.submenu = NSMenu(title: "이동")
        navigation.submenu?.addItem(withTitle: "뒤로", action: #selector(back), keyEquivalent: "[").target = self
        navigation.submenu?.addItem(withTitle: "앞으로", action: #selector(forward), keyEquivalent: "]").target = self
        NSApp.mainMenu = main
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "스티커"
        let menu = NSMenu()
        statusLabel = menu.addItem(withTitle: "상태 확인 중", action: nil, keyEquivalent: "")
        for (name, action) in [("스티커 열기", #selector(openWindow)), ("상태 새로고침", #selector(refresh)), ("서비스 시작", #selector(start)), ("서비스 중지…", #selector(stop))] {
            menu.addItem(withTitle: name, action: action, keyEquivalent: "").target = self
        }
        menu.addItem(withTitle: "진행 중 다운로드 취소", action: #selector(cancelDownloads), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "스티커 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = menu
    }
    @objc func back() { webView.goBack() }
    @objc func forward() { webView.goForward() }
    @objc func openWindow() {
        guard !quitting else { return }
        window.makeKeyAndOrderFront(nil)
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        if state.hasDocument { return }
        pendingOpen = true
        run("status")
    }
    @objc func refreshAndOpen() { pendingOpen = true; run("status") }
    @objc func refresh() { run("status") }
    @objc func start() { pendingOpen = true; run("start") }
    @objc func stop() {
        guard process == nil, !quitting else { return }
        window.makeKeyAndOrderFront(nil)
        let alert = NSAlert()
        alert.messageText = "스티커 서비스를 중지할까요?"
        alert.informativeText = "연결된 에이전트의 호출이 실패할 수 있습니다. 이 창의 입력은 그대로 유지합니다."
        alert.addButton(withTitle: "취소"); alert.addButton(withTitle: "서비스 중지")
        show(alert) { [weak self] response in if response == .alertSecondButtonReturn { self?.run("stop") } }
    }
    private func showMessage(_ text: String) { message.stringValue = text; statusLabel?.title = text }
    private func run(_ verb: String) {
        guard ["status", "start", "stop"].contains(verb), process == nil, !quitting else { return }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sticker-control-" + UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let output = directory.appendingPathComponent("result")
            guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: output)
            let child = Process()
            child.executableURL = URL(fileURLWithPath: "/bin/bash")
            child.arguments = [installation.root.appendingPathComponent("scripts/sticker.sh").path, verb, "--json"]
            child.currentDirectoryURL = installation.root
            child.environment = installation.environment
            child.standardInput = FileHandle.nullDevice
            child.standardOutput = handle
            child.standardError = FileHandle.nullDevice
            try child.run()
            outputDirectory = directory; outputHandle = handle; process = child
            #if STICKER_NATIVE_TRACE
            print("TRACE task-start verb=\(verb) pid=\(child.processIdentifier)"); fflush(stdout)
            #endif
            showMessage(verb == "status" ? "상태 확인 중" : "서비스 작업 중")
            poll = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.finishTask() }
        } catch {
            try? FileManager.default.removeItem(at: directory)
            showMessage("서비스 명령을 실행할 수 없습니다.")
        }
    }
    private func finishTask() {
        guard let child = process, !child.isRunning, let directory = outputDirectory else { return }
        poll?.invalidate(); poll = nil
        try? outputHandle?.close(); outputHandle = nil
        let result = directory.appendingPathComponent("result")
        let attributes = try? FileManager.default.attributesOfItem(atPath: result.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? Int.max
        let data = size <= 16384 ? try? Data(contentsOf: result) : nil
        snapshot = data.flatMap(AccessSnapshot.parse)
        try? FileManager.default.removeItem(at: directory)
        process = nil; outputDirectory = nil
        #if STICKER_NATIVE_TRACE
        print("TRACE task-cleanup removed=\(!FileManager.default.fileExists(atPath: directory.path))"); fflush(stdout)
        #endif
        if quitting { completeQuit(); return }
        showMessage(snapshot?.label ?? "서비스 응답을 확인할 수 없습니다.")
        guard pendingOpen else { return }
        pendingOpen = false
        switch state.open(readyOrigin: snapshot?.localReadyURL) {
        case .load(let url): webView.load(URLRequest(url: url))
        case .originChanged: showMessage("서비스 주소가 바뀌었습니다. 입력을 보관한 뒤 앱을 다시 여세요.")
        case .focus, .showStatus: break
        }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openWindow(); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        #if STICKER_NATIVE_TRACE
        print("TRACE quit-enter process=\(process != nil) downloads=\(downloads.count) pending=\(pendingDownloads.count)"); fflush(stdout)
        #endif
        if quitting { return process == nil && downloads.isEmpty && pendingDownloads.isEmpty ? .terminateNow : .terminateCancel }
        quitting = true
        let cancellations = Array(panels.values); panels.removeAll()
        cancellations.forEach { $0() }
        cancelDownloads()
        if process == nil && downloads.isEmpty && pendingDownloads.isEmpty { repliedToQuit = true; return .terminateNow }
        // Returning terminateLater starts an AppKit modal loop which can starve
        // the main-queue WebKit/Process callbacks needed to finish draining.
        // Cancel this attempt, then retry once our own work has completed.
        return .terminateCancel
    }
    @objc func cancelDownloads() {
        for download in Array(downloads.values) {
            download.cancel { [weak self, weak download] _ in
                DispatchQueue.main.async {
                    if let download { self?.downloads.removeValue(forKey: ObjectIdentifier(download)) }
                    if self?.quitting == false { self?.showMessage("다운로드를 취소했습니다.") }
                    self?.completeQuit()
                }
            }
        }
    }
    private func completeQuit() {
        #if STICKER_NATIVE_TRACE
        print("TRACE quit-check process=\(process != nil) downloads=\(downloads.count) pending=\(pendingDownloads.count)"); fflush(stdout)
        #endif
        if quitting && !repliedToQuit && process == nil && downloads.isEmpty && pendingDownloads.isEmpty {
            repliedToQuit = true
            #if STICKER_NATIVE_TRACE
            print("TRACE quit-reply"); fflush(stdout)
            #endif
            NSApp.terminate(nil)
        }
    }
    func applicationWillTerminate(_ notification: Notification) {
        #if STICKER_NATIVE_TRACE
        print("TRACE quit-complete"); fflush(stdout)
        #endif
        if let focusObserver { DistributedNotificationCenter.default().removeObserver(focusObserver) }
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    }
    func cancelPanelsBeforeTermination(_ completion: @escaping () -> Void) {
        guard panelTermination == nil else { return }
        guard !panels.isEmpty else { completion(); return }
        panelTermination = completion
        let cancellations = Array(panels.values)
        cancellations.forEach { $0() }
    }
    private func finishedPanel(_ key: UUID) {
        panels.removeValue(forKey: key)
        if panels.isEmpty, let completion = panelTermination {
            panelTermination = nil
            DispatchQueue.main.async(execute: completion)
        }
    }
    private func show(_ alert: NSAlert, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        guard !quitting, panels.isEmpty else { completion(.cancel); return }
        let key = UUID(), once = CompletionOnce(completion)
        panels[key] = { [weak self] in self?.window.endSheet(alert.window, returnCode: .cancel); once.resolve(.cancel) }
        alert.beginSheetModal(for: window) { [weak self] result in self?.finishedPanel(key); once.resolve(result) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.didLoad(); showMessage("스티커 연결됨") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { state.didFail(); showMessage("화면에 연결할 수 없습니다. 서비스 상태를 다시 확인하세요.") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { state.didFail(); showMessage("페이지 이동에 실패했습니다. 현재 입력을 확인하세요.") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { state.didFail(); showMessage("화면 프로세스가 종료됐습니다. 저장하지 않은 입력은 복구할 수 없습니다. 앱을 다시 여세요.") }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !quitting, action.sourceFrame.isMainFrame, let origin = state.origin, let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload && action.navigationType == .linkActivated && NavigationPolicy.isDownloadURL(url, origin: origin) { pendingDownloads.insert(ObjectIdentifier(action)); decisionHandler(.download); return }
        let choice = NavigationPolicy.classify(url, origin: origin, explicit: action.navigationType == .linkActivated, mainFrame: action.targetFrame?.isMainFrame ?? true)
        switch choice {
        case .internalPage:
            if action.targetFrame == nil { if action.navigationType == .linkActivated { webView.load(action.request) }; decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        case .externalLink: externalOpener(url); decisionHandler(.cancel)
        case .deny: decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard !quitting, response.isForMainFrame, let origin = state.origin, let url = response.response.url, NavigationPolicy.isDownloadURL(url, origin: origin) else { decisionHandler(.cancel); return }
        if response.canShowMIMEType { decisionHandler(.allow) } else { pendingDownloads.insert(ObjectIdentifier(response)); decisionHandler(.download) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage text: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = text; alert.addButton(withTitle: "확인"); show(alert) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage text: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = text; alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소"); show(alert) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt; alert.addButton(withTitle: "확인"); alert.addButton(withTitle: "취소")
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 300, height: 24); alert.accessoryView = field
        show(alert) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard !quitting, panels.isEmpty else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
        let key = UUID(), once = CompletionOnce(completionHandler)
        panels[key] = { [weak self] in self?.window.endSheet(panel, returnCode: .cancel); once.resolve(nil) }
        panel.beginSheetModal(for: window) { [weak self] result in self?.finishedPanel(key); once.resolve(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { pendingDownloads.remove(ObjectIdentifier(navigationAction)); track(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { pendingDownloads.remove(ObjectIdentifier(navigationResponse)); track(download) }
    private func track(_ download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download; download.delegate = self
        if quitting { download.cancel { [weak self, weak download] _ in DispatchQueue.main.async { if let download { self?.downloads.removeValue(forKey: ObjectIdentifier(download)) }; self?.completeQuit() } } }
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard !quitting, panels.isEmpty else { completionHandler(nil); return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        let key = UUID(), once = CompletionOnce(completionHandler)
        panels[key] = { [weak self] in self?.window.endSheet(panel, returnCode: .cancel); once.resolve(nil) }
        panel.beginSheetModal(for: window) { [weak self] result in
            self?.finishedPanel(key)
            guard result == .OK, let url = panel.url, (try? FileManager.default.attributesOfItem(atPath: url.path)) == nil else { once.resolve(nil); return }
            // WebKit requires a nonexistent destination and fails if it appears before writing.
            self?.showMessage("다운로드 중 · 메뉴바에서 취소할 수 있습니다.")
            once.resolve(url)
        }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) { decisionHandler(.cancel) }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeValue(forKey: ObjectIdentifier(download)); showMessage("다운로드 완료"); completeQuit() }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloads.removeValue(forKey: ObjectIdentifier(download)); if !quitting { showMessage("다운로드가 취소됐거나 저장할 수 없습니다.") }; completeQuit() }
}
