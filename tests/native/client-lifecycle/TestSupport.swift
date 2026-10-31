import Foundation

enum Check {
    static var count = 0
    static func that(_ condition: @autoclosure () -> Bool, _ name: String) {
        guard condition() else { fputs("FAIL \(name)\n", stderr); exit(1) }
        count += 1
    }
    static func rejects(_ name: String, _ body: () throws -> Void) {
        do { try body(); that(false, name) } catch { count += 1 }
    }
}
