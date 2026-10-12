import Darwin
import Foundation

func executeTool(
    _ executable: String, _ arguments: [String], capture: Bool = false, timeout: Double = 4
) -> (ok: Bool, output: String) {
    let process = Process()
    let finished = DispatchSemaphore(value: 0)
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.standardOutput = capture ? output : FileHandle.nullDevice
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: "ADB_TRACE")
    process.environment = environment
    process.terminationHandler = { _ in finished.signal() }
    do { try process.run() } catch { return (false, "") }
    if finished.wait(timeout: .now() + timeout) == .timedOut {
        process.terminate()
        if finished.wait(timeout: .now() + 0.25) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
        }
        return (false, "")
    }
    let bytes = capture ? output.fileHandleForReading.readDataToEndOfFile() : Data()
    guard bytes.count < 65536 else { return (false, "") }
    return (
        process.terminationStatus == 0,
        String(data: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    )
}
