import Foundation

@main struct NativeLifecycleTests {
    static func main() async {
        do {
            let arguments = CommandLine.arguments
            guard arguments.count == 3 else { throw LifecycleFailure.invalidInput }
            try await profileTests()
            try wireTests(fixtures:URL(fileURLWithPath:arguments[1]))
            #if TASK2
            try ownershipTests(output:URL(fileURLWithPath:arguments[2],isDirectory:true))
            try planTests()
            #endif
            #if TASK3
            try await writerGateTests()
            try await codexWriterConformanceTests(fixtures:URL(fileURLWithPath:arguments[1]).deletingLastPathComponent().appendingPathComponent("writer-contract.json"))
            #endif
            #if TASK4
            try await transactionTests()
            try await recoveryTests()
            try await concurrentWriterTests()
            #endif
            print("PASS \(Check.count) native client lifecycle checks")
        } catch {
            let code = (error as? LifecycleFailure)?.rawValue ?? "fixture_failure"
            fputs("FAIL native fixture suite: \(code)\n",stderr)
            exit(1)
        }
    }
}
