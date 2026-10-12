import AppKit
import Foundation

// Chrome checks the exact allowed extension origin before starting this host.
// Credentials stay in this process; page scripts and the extension never receive them.
final class NativeBridge: NSObject, URLSessionDataDelegate {
    let lock = NSLock()
    var buffer = Data()
    var credentials: [String: String] = [:]
    var session: URLSession!
    var events: URLSessionDataTask?
    var ready = false
    func output(_ value: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: value), d.count < 128_000 else {
            return
        }
        var n = UInt32(d.count).littleEndian
        lock.lock()
        defer { lock.unlock() }
        withUnsafeBytes(of: &n) { FileHandle.standardOutput.write(Data($0)) }
        FileHandle.standardOutput.write(d)
    }
    func connect() {
        guard let d = try? Data(contentsOf: sessionFile),
            let c = try? JSONSerialization.jsonObject(with: d) as? [String: String],
            let endpoint = c["origin"], endpoint == origin, let key = c["token"]
        else {
            output(["connected": false])
            return
        }
        credentials = c
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = 86400
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: URL(string: endpoint + "/api/events?role=browser")!)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        events = session.dataTask(with: request)
        events?.resume()
    }
    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            output(["connected": false])
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if !ready {
            ready = true
            output(["ready": true])
        }
        buffer.append(data)
        if buffer.count > 64_000 {
            events?.cancel()
            output(["connected": false])
            return
        }
        while let end = buffer.range(of: Data("\n\n".utf8)) {
            let line = buffer[..<end.lowerBound]
            buffer.removeSubrange(..<end.upperBound)
            if let s = String(data: line, encoding: .utf8), s.hasPrefix("event: browser-command\n"),
                let start = s.range(of: "data: "),
                let d = s[start.upperBound...].data(using: .utf8),
                let v = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            {
                output(v)
            }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?)
    { output(["connected": false]) }
    func send(_ value: [String: Any]) {
        guard ready else { return }
        guard let endpoint = credentials["origin"], let key = credentials["token"],
            let d = try? JSONSerialization.data(withJSONObject: value), d.count < 200_000
        else { return }
        var request = URLRequest(url: URL(string: endpoint + "/api/browser")!)
        request.httpMethod = "POST"
        request.httpBody = d
        request.timeoutInterval = 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { _, response, _ in
            self.output(["connected": (response as? HTTPURLResponse)?.statusCode == 200])
        }.resume()
    }
}
func runNativeBridge() {
    let bridge = NativeBridge()
    bridge.connect()
    func read(_ size: Int) -> Data? {
        var d = Data()
        while d.count < size {
            guard let part = try? FileHandle.standardInput.read(upToCount: size - d.count),
                !part.isEmpty
            else { return nil }
            d.append(part)
        }
        return d
    }
    while let header = read(4) {
        let size = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        guard size > 0, size < 200_000, let data = read(Int(size)),
            let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { break }
        bridge.send(value)
    }
    bridge.events?.cancel()
    bridge.session?.invalidateAndCancel()
}
