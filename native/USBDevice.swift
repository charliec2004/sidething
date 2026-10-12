import Foundation
import Network

// ADB remains a USB transport. Only the explicitly registered serial is paired.
// One persistent device-list subscription replaces USB polling.
final class USBDevice {
    let serial: String
    let adb = env["CARTHING_ADB_BIN"] ?? resources.appendingPathComponent("adb").path
    let changed: (String) -> Void
    var tracker: NWConnection?, retry: DispatchWorkItem?, socket: URLSessionWebSocketTask?
    var buffer = Data(), greeting = true, attached = false, stopped = false
    private let generationLock = NSLock()
    private var generationValue = 0
    var generation: Int {
        get { generationLock.withLock { generationValue } }
        set { generationLock.withLock { generationValue = newValue } }
    }
    let setupQueue = DispatchQueue(label: "sidething.usb")
    var ownedForwards: Set<UInt16> = []
    var forwarding: UInt16?
    var brightness = 92, displayOn = true, lightBusy = false
    init?(changed: @escaping (String) -> Void) {
        guard let data = try? Data(contentsOf: runtime.appendingPathComponent("device.json")),
            let profile = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let value = profile["serial"] as? String, (6...40).contains(value.count),
            value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
        else { return nil }
        serial = value
        self.changed = changed
        if let saved = profile["brightness"] as? Int, (5...100).contains(saved) {
            brightness = saved
        }
    }
    func start() {
        guard !stopped else { return }
        changed("Looking for Car Thing")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            let result = executeTool(self.adb, ["start-server"], timeout: 6)
            DispatchQueue.main.async {
                if result.ok { self.subscribe() } else { self.lostTracker() }
            }
        }
    }
    func subscribe() {
        guard !stopped else { return }
        buffer.removeAll()
        greeting = true
        let connection = NWConnection(
            host: "127.0.0.1",
            port: NWEndpoint.Port(
                rawValue: UInt16(env["CARTHING_ADB_SERVER_PORT"] ?? "5037") ?? 5037)!, using: .tcp)
        tracker = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self = self, let connection = connection, connection === self.tracker else {
                return
            }
            if case .ready = state {
                let command = Data("host:track-devices-l".utf8)
                var packet = Data(String(format: "%04x", command.count).utf8)
                packet.append(command)
                connection.send(
                    content: packet,
                    completion: .contentProcessed { error in
                        if error != nil { self.lostTracker() } else { self.receive(connection) }
                    })
            } else if case .failed = state {
                self.lostTracker()
            }
        }
        connection.start(queue: .main)
    }
    func receive(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) {
            [weak self] bytes, _, done, error in
            guard let self = self, connection === self.tracker, !self.stopped else { return }
            if let bytes = bytes { self.buffer.append(bytes) }
            guard !done, error == nil, self.buffer.count <= 16384 else {
                self.lostTracker()
                return
            }
            if self.greeting {
                guard self.buffer.count >= 4 else {
                    self.receive(connection)
                    return
                }
                guard self.buffer.prefix(4) == Data("OKAY".utf8) else {
                    self.lostTracker()
                    return
                }
                self.buffer.removeFirst(4)
                self.greeting = false
            }
            while self.buffer.count >= 4 {
                guard let prefix = String(data: self.buffer.prefix(4), encoding: .utf8),
                    let size = Int(prefix, radix: 16), size <= 16000
                else {
                    self.lostTracker()
                    return
                }
                guard self.buffer.count >= size + 4 else { break }
                let data = Data(self.buffer.dropFirst(4).prefix(size))
                self.buffer.removeFirst(size + 4)
                let lines = (String(data: data, encoding: .utf8) ?? "").split(separator: "\n")
                let found = lines.contains { line in
                    let fields = line.split(whereSeparator: { $0.isWhitespace })
                    return fields.count >= 2 && fields[0] == self.serial && fields[1] == "device"
                }
                if found != self.attached {
                    self.attached = found
                    self.generation += 1
                    self.retry?.cancel()
                    self.socket?.cancel(with: .goingAway, reason: nil)
                    self.removeForward()
                    if found {
                        self.configure(self.generation)
                    } else {
                        self.changed("Car Thing disconnected")
                    }
                }
            }
            self.receive(connection)
        }
    }
    func lostTracker() {
        guard !stopped else { return }
        generation += 1
        attached = false
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        removeForward()
        tracker?.stateUpdateHandler = nil
        tracker?.cancel()
        tracker = nil
        changed("USB connection unavailable")
        retry?.cancel()
        let next = DispatchWorkItem { [weak self] in self?.start() }
        retry = next
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: next)
    }
    func configure(_ revision: Int) {
        guard attached, !stopped, revision == generation else { return }
        changed("Connecting SideThing")
        let level = Self.backlightLevel(brightness)
        setupQueue.async { [weak self] in
            guard let self = self, revision == self.generation else { return }
            let target = ["-s", self.serial]
            let reverse = executeTool(
                self.adb, target + ["reverse", "tcp:\(port)", "tcp:\(port)"], timeout: 1)
            guard revision == self.generation else { return }
            let forward = executeTool(
                self.adb, target + ["forward", "tcp:0", "tcp:2222"], capture: true, timeout: 1)
            let debugPort = UInt16(forward.output)
            if let debugPort = debugPort { self.ownedForwards.insert(debugPort) }
            guard revision == self.generation else {
                if let debugPort = debugPort { self.dropForward(debugPort) }
                return
            }
            let clock = executeTool(
                self.adb,
                target + ["shell", "date", "-u", "-s", "@\(Int(Date().timeIntervalSince1970))"],
                timeout: 1)
            _ = executeTool(
                self.adb,
                target + [
                    "shell",
                    "printf '\(level)' > /sys/class/backlight/aml-bl/brightness && printf '0' > /sys/class/backlight/aml-bl/bl_power",
                ], timeout: 1)
            DispatchQueue.main.async {
                guard revision == self.generation, !self.stopped else {
                    if let debugPort = debugPort { self.removeForward(debugPort) }
                    return
                }
                guard reverse.ok, forward.ok, clock.ok, let debugPort = debugPort, debugPort > 0
                else {
                    if let debugPort = debugPort { self.removeForward(debugPort) }
                    self.retryDevice(revision)
                    return
                }
                self.displayOn = true
                self.forwarding = debugPort
                self.openPlayer(debugPort, revision)
            }
        }
    }
    func openPlayer(_ debugPort: UInt16, _ revision: Int) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(debugPort)/json/list")!)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] bytes, response, _ in
            DispatchQueue.main.async {
                guard let self = self, revision == self.generation, !self.stopped else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, let data = bytes,
                    data.count < 64000,
                    let pages = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                    let page = pages.first(where: { $0["type"] as? String == "page" }),
                    let value = page["webSocketDebuggerUrl"] as? String,
                    let endpoint = URL(string: value),
                    endpoint.scheme == "ws", endpoint.host == "127.0.0.1",
                    endpoint.port == Int(debugPort), endpoint.path.hasPrefix("/devtools/page/")
                else {
                    self.retryDevice(revision)
                    return
                }
                let socket = URLSession.shared.webSocketTask(with: endpoint)
                socket.maximumMessageSize = 64000
                self.socket = socket
                socket.resume()
                let desired = "\(origin)/?v=\(uiVersion)"
                let current = (page["url"] as? String ?? "").components(separatedBy: "#")[0]
                if current == desired {
                    self.command(
                        socket, method: "Runtime.evaluate",
                        params: [
                            "expression": "sessionStorage.getItem('sidecarToken') === '\(token)'",
                            "returnByValue": true,
                        ]
                    ) { result in
                        let evaluation = result?["result"] as? [String: Any]
                        if evaluation?["value"] as? Bool == true {
                            self.command(
                                socket, method: "Runtime.evaluate",
                                params: [
                                    "expression":
                                        "window.dispatchEvent(new Event('carthing:connected'))"
                                ]
                            ) { result in
                                if result != nil {
                                    self.connected(socket, revision)
                                } else {
                                    self.retryDevice(revision)
                                }
                            }
                        } else {
                            self.navigate(socket, desired, revision)
                        }
                    }
                } else {
                    self.navigate(socket, desired, revision)
                }
            }
        }.resume()
    }
    func command(
        _ socket: URLSessionWebSocketTask, method: String, params: [String: Any],
        completion: @escaping ([String: Any]?) -> Void
    ) {
        var done = false
        func finish(_ result: [String: Any]?) {
            guard !done else { return }
            done = true
            completion(result)
        }
        let timeout = DispatchWorkItem {
            socket.cancel(with: .goingAway, reason: nil)
            finish(nil)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4, execute: timeout)
        func receive() {
            socket.receive { result in
                DispatchQueue.main.async {
                    guard !done else { return }
                    guard case .success(.string(let text)) = result,
                        let data = text.data(using: .utf8),
                        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    else {
                        timeout.cancel()
                        finish(nil)
                        return
                    }
                    guard value["id"] as? Int == 1 else {
                        receive()
                        return
                    }
                    timeout.cancel()
                    finish(value["error"] == nil ? value["result"] as? [String: Any] : nil)
                }
            }
        }
        socket.send(
            .string(
                String(data: json(["id": 1, "method": method, "params": params]), encoding: .utf8)!)
        ) { error in
            DispatchQueue.main.async {
                if error != nil {
                    timeout.cancel()
                    finish(nil)
                } else {
                    receive()
                }
            }
        }
    }
    func navigate(_ socket: URLSessionWebSocketTask, _ desired: String, _ revision: Int) {
        command(socket, method: "Page.navigate", params: ["url": "\(desired)#\(token)"]) {
            [weak self] result in
            guard let self = self else { return }
            if result != nil && result?["errorText"] == nil {
                self.connected(socket, revision)
            } else {
                socket.cancel(with: .goingAway, reason: nil)
                self.retryDevice(revision)
            }
        }
    }
    func connected(_ socket: URLSessionWebSocketTask, _ revision: Int) {
        guard revision == generation, !stopped else { return }
        changed("Car Thing connected")
        watchDisplay(socket, revision)
    }
    func watchDisplay(_ socket: URLSessionWebSocketTask, _ revision: Int) {
        socket.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self, revision == self.generation, !self.stopped,
                    socket === self.socket
                else { return }
                if case .failure = result {
                    self.retryDevice(revision)
                } else {
                    self.watchDisplay(socket, revision)
                }
            }
        }
    }
    func retryDevice(_ revision: Int) {
        guard attached, !stopped, revision == generation else { return }
        changed("Waiting for Car Thing display")
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        removeForward()
        retry?.cancel()
        let next = DispatchWorkItem { [weak self] in self?.configure(revision) }
        retry = next
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: next)
    }
    func stop() {
        stopped = true
        generation += 1
        retry?.cancel()
        tracker?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        // Drain canceled setup work before the process exits, including a port
        // allocated just before its main-queue callback could run.
        setupQueue.sync { for debugPort in ownedForwards { dropForward(debugPort) } }
        forwarding = nil
    }
    func dropForward(_ debugPort: UInt16) {
        guard ownedForwards.remove(debugPort) != nil else { return }
        _ = executeTool(adb, ["-s", serial, "forward", "--remove", "tcp:\(debugPort)"], timeout: 1)
    }
    func removeForward(_ stale: UInt16? = nil) {
        guard let debugPort = stale ?? forwarding else { return }
        if stale == nil { forwarding = nil }
        setupQueue.async { self.dropForward(debugPort) }
    }
    // This panel uses inverse PWM; zero is reserved for display-off.
    static func backlightLevel(_ percent: Int) -> Int {
        max(1, 255 - Int((Double(percent) * 254 / 100).rounded()))
    }
    func setBacklight(_ percent: Int?, on: Bool?, completion: @escaping (Bool) -> Void) {
        guard attached, !stopped, !lightBusy else {
            completion(false)
            return
        }
        let level = percent ?? brightness
        let enabled = on ?? displayOn
        let revision = generation
        guard (5...100).contains(level) else {
            completion(false)
            return
        }
        lightBusy = true
        let raw = enabled ? Self.backlightLevel(level) : 0
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let result = executeTool(
                self.adb,
                [
                    "-s", self.serial, "shell",
                    "printf '\(raw)' > /sys/class/backlight/aml-bl/brightness && printf '\(enabled ? 0 : 4)' > /sys/class/backlight/aml-bl/bl_power",
                ])
            DispatchQueue.main.async {
                self.lightBusy = false
                guard result.ok, revision == self.generation, !self.stopped else {
                    completion(false)
                    return
                }
                self.brightness = level
                self.displayOn = enabled
                let profile = json(["serial": self.serial, "brightness": level])
                let file = runtime.appendingPathComponent("device.json")
                do {
                    try profile.write(to: file, options: .atomic)
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o600], ofItemAtPath: file.path)
                } catch {
                    completion(false)
                    return
                }
                completion(true)
            }
        }
    }
}
