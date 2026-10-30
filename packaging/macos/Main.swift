import AppKit

@main
struct StickerMain {
    static func main() {
        let app = StickerApplication.shared
        app.setActivationPolicy(.regular)
        do {
            guard #available(macOS 11.3, *), let resources = Bundle.main.resourceURL else { throw CocoaError(.featureUnsupported) }
            let delegate = try StickerApp(installation: Installation.load(resources: resources))
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "스티커 설치 정보를 확인할 수 없습니다."
            alert.informativeText = "설치 경로에서 접근 앱을 다시 설치하세요. 서비스와 데이터는 변경하지 않았습니다."
            alert.runModal()
        }
    }
}
