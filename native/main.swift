import AppKit
import CoreLocation
import CryptoKit
import Darwin
import ImageIO
import Network

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "--music-control" {
    runMusicCommand(Array(CommandLine.arguments.dropFirst(2)))
}

let env = ProcessInfo.processInfo.environment
let port = UInt16(env["PORT"] ?? "4318") ?? 4318
let seekStep = 10.0
let origin = "http://127.0.0.1:\(port)"
let resources = URL(
    fileURLWithPath: env["CARTHING_RESOURCES"] ?? Bundle.main.resourcePath
        ?? FileManager.default.currentDirectoryPath)
let uiVersion = String(
    SHA256.hash(
        data: ["index.html", "app.js", "style.css"].reduce(Data()) {
            $0 + ((try? Data(contentsOf: resources.appendingPathComponent($1))) ?? Data())
        }
    ).map { String(format: "%02x", $0) }.joined().prefix(12))
let runtime = URL(
    fileURLWithPath: env["CARTHING_DATA_DIR"]
        ?? (FileManager.default.homeDirectoryForCurrentUser.path
            + "/Library/Application Support/CarThing"))
try FileManager.default.createDirectory(
    at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
let sessionFile = runtime.appendingPathComponent("session.json")
let approvedExtension = "chrome-extension://cimdjidafppbekippocbhcjbbngdkjck/"
if CommandLine.arguments.contains(approvedExtension) {
    runNativeBridge()
    exit(0)
}
let previous = (try? Data(contentsOf: sessionFile)).flatMap {
    try? JSONSerialization.jsonObject(with: $0) as? [String: String]
}
let token =
    previous?["token"].flatMap { $0.count == 64 && $0.allSatisfy { $0.isHexDigit } ? $0 : nil }
    ?? UUID().uuidString.replacingOccurrences(of: "-", with: "")
    + UUID().uuidString.replacingOccurrences(of: "-", with: "")
let sessionData = try JSONSerialization.data(withJSONObject: ["origin": origin, "token": token])
try sessionData.write(to: sessionFile, options: .atomic)
try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sessionFile.path)

func json(_ value: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
}
func text(_ value: Any?, limit: Int = 500) -> String {
    String((value as? String ?? "").prefix(limit))
}
func numeric(_ value: Any?) -> Double {
    let n = (value as? NSNumber)?.doubleValue ?? 0
    return n.isFinite ? n : 0
}
func mode(_ value: Any?) -> Any {
    let n = Int(numeric(value))
    return (1...3).contains(n) ? n : NSNull()
}
func authenticated(_ value: String) -> Bool {
    let a = Array(value.utf8)
    let b = Array("Bearer \(token)".utf8)
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}

final class Peer {
    let connection: NWConnection
    let id = UUID()
    var pending = false
    var browser = false
    var latest: Data?
    init(_ c: NWConnection) { connection = c }
    func push(_ data: Data) {
        if pending {
            latest = data
            return
        }
        pending = true
        connection.send(
            content: data,
            completion: .contentProcessed { [weak self] error in
                guard let self = self else { return }
                self.pending = false
                if error != nil {
                    self.connection.cancel()
                    return
                }
                if let next = self.latest {
                    self.latest = nil
                    self.push(next)
                }
            })
    }
}

final class Service {
    weak var device: USBDevice?
    var requestCurrentLocation: (() -> Void)?
    var locator: CurrentLocation?
    let countdown = Countdown(file: runtime.appendingPathComponent("timer.json"))
    var musicModes: [String: Any]?
    var musicRefreshing = false, musicSignature = ""
    var musicObserver: NSObjectProtocol?
    var musicTermination: NSObjectProtocol?
    var nightShift: [String: Any] = ["supported": false, "enabled": false, "strength": 0]
    var listener: NWListener!
    var peers: [UUID: Peer] = [:]
    var media: [String: Any] = ["status": "loading", "kind": "unknown"]
    var weather: [String: Any] = ["status": "unconfigured"]
    var settings: [String: Any] = ["unit": "fahrenheit"]
    var currentLocation: [String: Any]?
    var artwork = Data(), artworkHash = "", sourceArtwork = ""
    var nativeArtwork = Data(), nativeArtworkHash = ""
    var child: Process?, restartTimer: Timer?, heartbeat: Timer?, weatherTimer: Timer?
    var controlBusy = false, shuttingDown = false, weatherBusy = false
    var rates: [String: [TimeInterval]] = [:]
    var previousState = Data()
    let streamQueue = DispatchQueue(label: "carthing.metadata", qos: .utility)
    var streamBuffer = Data()
    let players = Players()
    var nativePayload: [String: Any] = [:]
    var browserCommand: (id: String, peer: Peer)?
    var browserTimeout: Timer?
    let helper =
        env["CARTHING_MEDIA_BIN"]
        ?? resources.appendingPathComponent("media-control/bin/media-control").path

    func start() throws {
        if let d = try? Data(contentsOf: runtime.appendingPathComponent("settings.json")),
            let v = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
            ["fahrenheit", "celsius"].contains(text(v["unit"]))
        {
            settings = ["unit": v["unit"]!]
        }
        let p = NWParameters.tcp
        p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: p, on: NWEndpoint.Port(rawValue: port)!)
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener.stateUpdateHandler = { state in
            if case .failed = state {
                fputs("Car Thing listener could not start.\n", stderr)
                NSApplication.shared.terminate(nil)
            }
        }
        listener.start(queue: .main)
        if !CommandLine.arguments.contains("--headless") {
            SideThingNightShiftStart { [weak self] in self?.refreshNightShift() }
            refreshNightShift()
        }
        countdown.changed = { [weak self] in self?.publish() }
        countdown.completed = {
            if !CommandLine.arguments.contains("--headless") { NSSound(named: "Glass")?.play() }
        }
        countdown.start()
        if !CommandLine.arguments.contains("--headless") {
            musicObserver = DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name("com.apple.Music.playerInfo"), object: nil, queue: .main
            ) { [weak self] _ in self?.refreshMusic() }
            musicTermination = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
            ) { [weak self] notification in
                guard
                    let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey]
                        as? NSRunningApplication, application.bundleIdentifier == "com.apple.Music",
                    let self = self
                else { return }
                self.players.remove("com.apple.Music")
                self.musicModes = nil
                self.selectPlayer()
                self.publish()
            }
            refreshMusic()
        }
        SystemAudio.start { [weak self] in self?.publish() }
        startStream()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.refreshNightShift()
            self?.publish()
            self?.peers.values.filter { !$0.pending }.forEach {
                $0.push(Data(": keepalive\n\n".utf8))
            }
        }
        refreshWeather()
        weatherTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
            if let locator = self?.locator { locator.request() } else { self?.refreshWeather() }
        }
    }
    func snapshot() -> [String: Any] {
        var config = settings
        config["location"] = currentLocation ?? NSNull()
        config["timeZone"] = TimeZone.current.identifier
        config["utcOffsetSeconds"] = TimeZone.current.secondsFromGMT(for: Date())
        return [
            "media": media, "weather": weather, "config": config, "hardware": hardware(),
            "timer": countdown.snapshot, "serverTime": Date().timeIntervalSince1970 * 1000,
        ]
    }
    func hardware() -> [String: Any] {
        [
            "brightness": device?.brightness ?? 92, "displayOn": device?.displayOn ?? true,
            "connected": device?.attached ?? false, "output": SystemAudio.current["output"]!,
            "outputRevision": SystemAudio.current["outputRevision"] ?? 0,
            "volume": SystemAudio.current["volume"]!, "nightShift": nightShift,
        ]
    }
    func publish() {
        let d = json(snapshot())
        guard d != previousState else { return }
        previousState = d
        var packet = Data("event: state\ndata: ".utf8)
        packet.append(d)
        packet.append(Data("\n\n".utf8))
        for peer in peers.values where !peer.browser { peer.push(packet) }
    }
    func startStream() {
        guard !shuttingDown else { return }
        let p = Process()
        let output = Pipe()
        p.executableURL = URL(fileURLWithPath: helper)
        p.arguments = ["stream", "--micros", "--debounce=100"]
        p.standardOutput = output
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.lostStream() } }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.streamQueue.async { [weak self] in
                guard let self = self else { return }
                self.streamBuffer.append(chunk)
                if self.streamBuffer.count > 8_000_000 {
                    self.streamBuffer.removeAll()
                    DispatchQueue.main.async { self.child?.terminate() }
                    return
                }
                while let end = self.streamBuffer.firstIndex(of: 10) {
                    let line = self.streamBuffer.prefix(upTo: end)
                    self.streamBuffer.removeSubrange(...end)
                    guard let v = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                        let payload = v["payload"] as? [String: Any]
                    else { continue }
                    let diff = v["diff"] as? Bool ?? false
                    DispatchQueue.main.async { self.ingest(payload, diff: diff) }
                }
            }
        }
        do {
            try p.run()
            child = p
        } catch { lostStream() }
    }
    func lostStream() {
        guard !shuttingDown else { return }
        media["status"] = "unavailable"
        publish()
        restartTimer?.invalidate()
        restartTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            self?.startStream()
        }
    }
    func ingest(_ update: [String: Any], diff: Bool = false) {
        var m = diff ? nativePayload : [:]
        for (key, value) in update { m[key] = value is NSNull ? nil : value }
        nativePayload = m
        guard !m.isEmpty, !text(m["title"]).isEmpty else {
            media = ["status": "empty", "kind": "unknown"]
            artwork.removeAll()
            artworkHash = ""
            sourceArtwork = ""
            nativeArtwork.removeAll()
            nativeArtworkHash = ""
            players.nativeChanged("")
            selectPlayer()
            publish()
            return
        }
        let source = text(m["bundleIdentifier"])
        let browser = [
            "safari", "chrome", "chromium", "firefox", "asidebrowser", "arc", "brave", "edge",
        ].contains { source.lowercased().contains($0) }
        let kind =
            numeric(m["mediaType"]) == 2 || (browser && numeric(m["mediaType"]) != 1)
            ? "video" : "music"
        media = [
            "status": "ready", "kind": kind, "title": text(m["title"]), "artist": text(m["artist"]),
            "source": source,
            "playing": m["playing"] as? Bool ?? false, "repeatMode": mode(m["repeatMode"]),
            "shuffleMode": mode(m["shuffleMode"]),
            "duration": max(0, numeric(m["durationMicros"]) / 1_000_000),
            "elapsed": max(0, numeric(m["elapsedTimeMicros"]) / 1_000_000),
            "timestamp": numeric(m["timestampEpochMicros"]) / 1000,
            "rate": max(0, numeric(m["playbackRate"])),
        ]
        let encoded = m["artworkData"] as? String ?? ""
        if encoded != sourceArtwork {
            sourceArtwork = encoded
            if encoded.count <= 7_000_000, let bytes = Data(base64Encoded: encoded), !bytes.isEmpty
            {
                nativeArtwork = thumbnail(bytes)
                nativeArtworkHash =
                    nativeArtwork.isEmpty
                    ? ""
                    : String(
                        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined().prefix(
                            24))
            } else {
                nativeArtwork.removeAll()
                nativeArtworkHash = ""
            }
        }
        artwork = nativeArtwork
        if artwork.isEmpty, let previous = players.items[source],
            text(previous.media["title"]) == text(media["title"]),
            text(previous.media["artist"]) == text(media["artist"])
        {
            artwork = previous.artwork
        }
        artworkHash = nativeArtworkHash
        media["seekStep"] = seekStep
        media["artworkVersion"] = artworkHash

        let appleMusic = source == "com.apple.Music"
        if appleMusic, let modes = musicModes { media.merge(modes) { _, next in next } }
        let signature =
            appleMusic
            ? [source, text(m["title"]), String(m["playing"] as? Bool ?? false)].joined(
                separator: "|") : ""
        if signature != musicSignature {
            musicSignature = signature
            if appleMusic { refreshMusic() }
        }
        let video = media["kind"] as? String == "video"
        media["capabilities"] = [
            "seek": numeric(media["duration"]) > 0,
            "skip": !video && !(m["prohibitsSkip"] as? Bool ?? false),
            "shuffle": !video && !(media["shuffleMode"] is NSNull),
            "repeat": !video && !(media["repeatMode"] is NSNull),
        ]
        players.nativeChanged(source)
        // A bridged tab replaces the browser's anonymous MediaRemote card.
        if !browser || !players.items.keys.contains(where: { $0.hasPrefix("browser:") }) {
            players.update(source, media: media, artwork: artwork)
        }
        selectPlayer()
        publish()
    }
    func selectPlayer() {
        if let player = players.current {
            media = player.media
            media["sourceId"] = players.selected
            media["sourceCount"] = players.items.count
            artwork = player.artwork
            artworkHash =
                artwork.isEmpty
                ? ""
                : String(
                    SHA256.hash(data: artwork).map { String(format: "%02x", $0) }.joined().prefix(
                        24))
            media["artworkVersion"] = artworkHash
        } else {
            media = ["status": "empty", "kind": "unknown"]
            artwork.removeAll()
            artworkHash = ""
        }
    }
    func updateMusic(_ value: [String: Any]) {
        if text(nativePayload["bundleIdentifier"]) == "com.apple.Music" {
            if text(nativePayload["title"]) != text(value["title"]) {
                nativeArtwork.removeAll()
                nativeArtworkHash = ""
                sourceArtwork = ""
                nativePayload["artworkData"] = nil
            }
            for key in ["title", "artist", "playing"] { nativePayload[key] = value[key] }
            nativePayload["elapsedTimeMicros"] = numeric(value["elapsed"]) * 1_000_000
            nativePayload["durationMicros"] = numeric(value["duration"]) * 1_000_000
            nativePayload["timestampEpochMicros"] = numeric(value["timestamp"]) * 1000
        }
        musicModes = ["repeatMode": value["repeatMode"]!, "shuffleMode": value["shuffleMode"]!]
        guard !text(value["title"]).isEmpty else {
            players.remove("com.apple.Music")
            selectPlayer()
            publish()
            return
        }
        var m = value
        m["status"] = "ready"
        m["source"] = "com.apple.Music"
        m["kind"] = "music"
        m["rate"] = 1
        m["seekStep"] = seekStep
        m["capabilities"] = [
            "seek": numeric(m["duration"]) > 0, "skip": true, "shuffle": true, "repeat": true,
        ]
        let previous = players.items["com.apple.Music"]
        var image =
            text(previous?.media["title"]) == text(m["title"])
            ? (previous?.artwork ?? Data()) : Data()
        if image.isEmpty, text(nativePayload["bundleIdentifier"]) == "com.apple.Music",
            text(nativePayload["title"]) == text(m["title"])
        {
            image = nativeArtwork
        }
        if image.isEmpty, let encoded = value["artworkData"] as? String,
            let bytes = Data(base64Encoded: encoded)
        {
            image = thumbnail(bytes)
        }
        m["artworkData"] = nil
        players.update("com.apple.Music", media: m, artwork: image)
        selectPlayer()
        publish()
    }
    func refreshNightShift() {
        guard !CommandLine.arguments.contains("--headless") else { return }
        let next = SideThingNightShiftRead() as! [String: Any]
        if json(next) != json(nightShift) {
            nightShift = next
            publish()
        }
    }
    func refreshMusic() {
        guard !musicRefreshing,
            !CommandLine.arguments.contains("--headless") || env["CARTHING_MUSIC_BIN"] != nil,
            env["CARTHING_MUSIC_BIN"] != nil
                || !NSRunningApplication.runningApplications(
                    withBundleIdentifier: "com.apple.Music"
                ).isEmpty
        else { return }
        musicRefreshing = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let value = musicCommand()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.musicRefreshing = false
                if let value = value { self.updateMusic(value) }
            }
        }
    }
    func thumbnail(_ bytes: Data) -> Data {
        guard
            let source = CGImageSourceCreateWithData(
                bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
            let image = CGImageSourceCreateThumbnailAtIndex(
                source, 0,
                [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: 480,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                ] as CFDictionary)
        else { return Data() }
        return NSBitmapImageRep(cgImage: image).representation(
            using: .jpeg, properties: [.compressionFactor: 0.82]) ?? Data()
    }
    func validSettings(_ v: [String: Any]) -> Bool {
        ["fahrenheit", "celsius"].contains(text(v["unit"]))
            && Set(v.keys).isSubset(of: ["unit", "location"])
            && (v["location"] == nil || v["location"] is NSNull)
    }
    func refreshWeather() {
        guard !weatherBusy, let l = currentLocation else { return }
        weatherBusy = true
        var u = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        u.queryItems = [
            "latitude": "\(numeric(l["latitude"]))", "longitude": "\(numeric(l["longitude"]))",
            "current": "temperature_2m,apparent_temperature,weather_code",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "hourly": "temperature_2m", "forecast_hours": "6",
            "temperature_unit": text(settings["unit"]), "forecast_days": "6", "timezone": "auto",
        ].map { URLQueryItem(name: $0.key, value: $0.value) }
        let revision = json(["location": l, "unit": settings["unit"]!])
        var request = URLRequest(url: u.url!)
        request.timeoutInterval = 8
        URLSession.shared.dataTask(with: request) { [weak self] bytes, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.weatherBusy = false
                guard
                    json(["location": self.currentLocation ?? [:], "unit": self.settings["unit"]!])
                        == revision
                else {
                    self.refreshWeather()
                    return
                }
                if error == nil, let r = response as? HTTPURLResponse, r.statusCode == 200,
                    let d = bytes, d.count < 1_000_000,
                    let v = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                    let current = v["current"] as? [String: Any],
                    current["temperature_2m"] is NSNumber, let daily = v["daily"] as? [String: Any]
                {
                    self.weather = [
                        "status": "ready", "current": current, "daily": daily,
                        "hourly": v["hourly"] ?? [:],
                        "updated": Date().timeIntervalSince1970 * 1000,
                    ]
                } else {
                    self.weather["status"] =
                        self.weather["current"] == nil ? "unavailable" : "stale"
                }
                self.publish()
            }
        }.resume()
    }
    func accept(_ c: NWConnection) {
        let peer = Peer(c)
        let peerID = peer.id
        c.stateUpdateHandler = { [weak self] state in
            if case .cancelled = state {
                guard let self = self else { return }
                let browser = self.peers[peerID]?.browser == true
                self.peers.removeValue(forKey: peerID)
                if browser {
                    self.players.removeBrowser()
                    self.ingest(self.nativePayload)
                }
            }
        }
        c.start(queue: .main)
        var buffer = Data()
        let timeout = DispatchWorkItem { c.cancel() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
        func receive() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 8192) {
                [weak self] bytes, _, done, error in
                guard let self = self else {
                    c.cancel()
                    return
                }
                if let d = bytes { buffer.append(d) }
                guard buffer.count <= 220_000 else {
                    c.cancel()
                    return
                }
                if let range = buffer.range(of: Data("\r\n\r\n".utf8)),
                    let head = String(data: buffer[..<range.lowerBound], encoding: .utf8)
                {
                    let lines = head.components(separatedBy: "\r\n")
                    let first = lines[0].split(separator: " ")
                    var headers: [String: String] = [:]
                    for line in lines.dropFirst() {
                        let parts = line.split(separator: ":", maxSplits: 1)
                        if parts.count == 2 {
                            let k = parts[0].lowercased()
                            guard headers[k] == nil else {
                                c.cancel()
                                return
                            }
                            headers[k] = parts[1].trimmingCharacters(in: .whitespaces)
                        }
                    }
                    guard first.count == 3, first[2] == "HTTP/1.1",
                        headers["transfer-encoding"] == nil,
                        let size = Int(headers["content-length"] ?? "0"),
                        (0...(first[1] == "/api/browser" ? 200_000 : 4096)).contains(size)
                    else {
                        c.cancel()
                        return
                    }
                    let body = buffer[range.upperBound...]
                    if body.count >= size {
                        timeout.cancel()
                        self.route(
                            peer, method: String(first[0]), target: String(first[1]),
                            headers: headers, body: Data(body.prefix(size)))
                        return
                    }
                }
                if done || error != nil { c.cancel() } else { receive() }
            }
        }
        receive()
    }
    func reply(
        _ peer: Peer, _ code: Int = 200, _ body: Data, type: String = "application/json",
        extra: String = ""
    ) {
        let policy =
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
        var packet = Data(
            "HTTP/1.1 \(code) Response\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\nContent-Security-Policy: \(policy)\r\n\(extra)\r\n"
                .utf8)
        packet.append(body)
        peer.connection.send(
            content: packet, completion: .contentProcessed { _ in peer.connection.cancel() })
    }
    func route(_ peer: Peer, method: String, target: String, headers: [String: String], body: Data)
    {
        func failHTTP(_ code: Int, _ message: String) {
            reply(peer, code, json(["error": message]))
        }
        guard headers["host"] == "127.0.0.1:\(port)",
            headers["origin"] == nil || headers["origin"] == origin
        else {
            failHTTP(403, "Origin denied")
            return
        }
        guard let u = URLComponents(string: target), let route = u.path.removingPercentEncoding
        else {
            failHTTP(400, "Invalid request")
            return
        }
        let assets: [String: String] = [
            "/": "index.html", "/app.js": "app.js", "/style.css": "style.css",
            "/screens.html": "screens.html", "/screens.css": "screens.css",
            "/music.svg": "music.svg", "/video.svg": "video.svg", "/x.svg": "x.svg",
            "/inter-light.woff2": "inter-light.woff2",
            "/inter-regular.woff2": "inter-regular.woff2",
            "/inter-medium.woff2": "inter-medium.woff2",
        ]
        if let file = assets[route], method == "GET" {
            guard let d = try? Data(contentsOf: resources.appendingPathComponent(file)) else {
                failHTTP(404, "Not found")
                return
            }
            let type =
                file.hasSuffix(".woff2")
                ? "font/woff2"
                : file.hasSuffix(".js")
                    ? "text/javascript"
                    : file.hasSuffix(".css")
                        ? "text/css" : file.hasSuffix(".svg") ? "image/svg+xml" : "text/html"
            reply(peer, 200, d, type: type)
            return
        }
        guard
            [
                "/api/state", "/api/timer", "/api/source", "/api/events", "/api/artwork",
                "/api/control", "/api/hardware",
                "/api/outputs", "/api/location", "/api/settings", "/api/browser",
            ].contains(route)
        else {
            failHTTP(404, "Not found")
            return
        }
        guard authenticated(headers["authorization"] ?? "") else {
            failHTTP(401, "Pair this display through the menu bar app.")
            return
        }
        let now = Date().timeIntervalSince1970
        let recent = (rates[route] ?? []).filter { now - $0 < 60 }
        guard
            recent.count
                < ((route == "/api/hardware" || route == "/api/timer")
                    ? 1200 : route == "/api/state" ? 180 : 60)
        else {
            failHTTP(429, "Please wait before retrying.")
            return
        }
        rates[route] = recent + [now]
        if method == "GET" {
            if route == "/api/outputs" {
                reply(
                    peer, 200,
                    json([
                        "outputs": SystemAudio.outputs(),
                        "selected": SystemAudio.current["output"]!,
                    ]))
                return
            }
            if route == "/api/state" {
                reply(peer, 200, json(snapshot()))
                return
            }
            if route == "/api/artwork" {
                reply(peer, artwork.isEmpty ? 404 : 200, artwork, type: "image/jpeg")
                return
            }
            if route == "/api/events" {
                guard peers.count < 8 else {
                    failHTTP(429, "Too many displays.")
                    return
                }
                peer.browser =
                    u.queryItems?.contains(where: { $0.name == "role" && $0.value == "browser" })
                    == true
                if peer.browser && peers.values.contains(where: { $0.browser }) {
                    failHTTP(409, "A browser bridge is already connected.")
                    return
                }
                peer.push(
                    Data(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n"
                            .utf8))
                peers[peer.id] = peer
                // Observe the client's EOF immediately instead of retaining closed tabs
                // until a later heartbeat write detects them.
                peer.connection.receive(minimumIncompleteLength: 1, maximumLength: 1) {
                    _, _, _, _ in peer.connection.cancel()
                }
                var event = Data("event: state\ndata: ".utf8)
                event.append(json(snapshot()))
                event.append(Data("\n\n".utf8))
                peer.push(event)
                return
            }
        }
        guard method == "POST", headers["content-type"] == "application/json",
            let v = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else {
            failHTTP(400, "Invalid JSON request")
            return
        }
        if route == "/api/location" {
            guard let choose = requestCurrentLocation else {
                failHTTP(503, "Current location unavailable.")
                return
            }
            reply(peer, 200, json(["ok": true]))
            DispatchQueue.main.async(execute: choose)
            return
        }
        if route == "/api/source" {
            guard text(v["action"]) == "cycle", !controlBusy else {
                failHTTP(409, "Player switch unavailable")
                return
            }
            players.cycle()
            selectPlayer()
            publish()
            reply(peer, 200, json(snapshot()))
            return
        }
        if route == "/api/timer" {
            let action = text(v["action"])
            guard ["adjust", "set", "toggle", "reset", "replay"].contains(action) else {
                failHTTP(400, "Invalid timer action")
                return
            }
            var minutes = 0
            if action == "adjust" || action == "set" {
                guard let value = v["minutes"] as? NSNumber,
                    CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
                    value.doubleValue == Double(value.intValue),
                    action == "set"
                        ? (1...1440).contains(value.intValue)
                        : (-1440...1440).contains(value.intValue) && value.intValue != 0
                else {
                    failHTTP(400, "Timer changes use whole minutes")
                    return
                }
                minutes = value.intValue
            }
            countdown.apply(action, minutes: minutes)
            reply(
                peer, 200,
                json([
                    "timer": countdown.snapshot, "serverTime": Date().timeIntervalSince1970 * 1000,
                ]))
            return
        }
        if route == "/api/hardware" {
            let action = text(v["action"])
            if action == "output" {
                guard let n = v["id"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                    n.doubleValue == Double(n.uint32Value), SystemAudio.select(n.uint32Value)
                else {
                    failHTTP(409, "Audio output is unavailable.")
                    return
                }
                reply(peer, 200, json(["hardware": hardware()]))
                return
            }
            if action == "volume" {
                guard let n = v["delta"] as? NSNumber, n.doubleValue.isFinite,
                    abs(n.doubleValue) <= 0.2, n.doubleValue != 0
                else {
                    failHTTP(400, "Invalid volume change")
                    return
                }
                guard SystemAudio.adjust(n.floatValue) != nil else {
                    failHTTP(409, "Volume is controlled by the output device.")
                    return
                }
                publish()
                reply(peer, 200, json(["hardware": hardware()]))
                return
            }
            guard let device = device else {
                failHTTP(409, "Car Thing is disconnected.")
                return
            }
            let level: Int?
            let on: Bool?
            if action == "brightness", let n = v["value"] as? Int, (5...100).contains(n) {
                level = n
                on = nil
            } else if action == "display", let enabled = v["on"] as? Bool {
                level = nil
                on = enabled
            } else {
                failHTTP(400, "Invalid hardware control")
                return
            }
            device.setBacklight(level, on: on) { success in
                if success {
                    self.publish()
                    self.reply(peer, 200, json(["hardware": self.hardware()]))
                } else {
                    failHTTP(503, "Display did not accept the change.")
                }
            }
            return
        }
        if route == "/api/settings" {
            guard validSettings(v) else {
                failHTTP(400, "Invalid settings")
                return
            }
            do { try storeSettings(v) } catch {
                failHTTP(503, "Settings could not be saved.")
                return
            }
            reply(peer, 200, json(["ok": true]))
            return
        }
        if route == "/api/browser" {
            if v["type"] as? String == "ack" {
                guard let command = browserCommand, text(v["id"]) == command.id,
                    let ok = v["ok"] as? Bool
                else {
                    failHTTP(409, "Unknown command acknowledgement")
                    return
                }
                browserTimeout?.invalidate()
                browserCommand = nil
                controlBusy = false
                reply(
                    command.peer, ok ? 200 : 503,
                    json(ok ? ["ok": true] : ["error": "Video did not accept the command."]))
                reply(peer, 200, json(["ok": true]))
                return
            }
            guard let url = URL(string: text(v["url"], limit: 2048)), let host = url.host,
                url.scheme == "https",
                [
                    "www.youtube.com", "youtube.com", "x.com", "www.x.com", "twitter.com",
                    "www.twitter.com",
                ].contains(host), !text(v["title"]).isEmpty
            else {
                failHTTP(400, "Unsupported video page")
                return
            }
            var id = "browser:" + url.absoluteString
            if let tab = v["tabId"] as? NSNumber {
                guard CFGetTypeID(tab) != CFBooleanGetTypeID(),
                    tab.doubleValue == Double(tab.intValue), tab.intValue >= 0
                else {
                    failHTTP(400, "Invalid tab")
                    return
                }
                id = "browser:\(tab.intValue)"
            }
            if v["ended"] as? Bool == true {
                players.remove(id)
                selectPlayer()
                publish()
                reply(peer, 200, json(["ok": true]))
                return
            }
            let old = players.items[id]
            var image = old?.artwork ?? Data()
            var encoded = old?.encoded ?? ""
            if text(old?.media["title"]) != text(v["title"]) {
                image = Data()
                encoded = ""
            }
            if let next = v["thumbnail"] as? String, next.count < 150_000, next != encoded,
                let bytes = Data(base64Encoded: next)
            {
                encoded = next
                image = thumbnail(bytes)
            }
            let m: [String: Any] = [
                "status": "ready", "source": "browser-bridge", "kind": "video",
                "tabId": v["tabId"] ?? NSNull(),
                "title": text(v["title"]), "artist": text(v["creator"]),
                "website": host.contains("youtube") ? "youtube" : "x",
                "playing": v["playing"] as? Bool ?? false, "elapsed": max(0, numeric(v["elapsed"])),
                "duration": min(864000, max(0, numeric(v["duration"]))),
                "timestamp": Date().timeIntervalSince1970 * 1000,
                "rate": 1, "seekStep": seekStep,
                "capabilities": [
                    "seek": numeric(v["duration"]) > 0, "skip": false, "repeat": false,
                    "shuffle": false,
                ],
            ]
            if players.native.lowercased().contains("chrome")
                || players.native.lowercased().contains("safari")
            {
                players.remove(players.native)
            }
            players.update(id, media: m, artwork: image, encoded: encoded)
            selectPlayer()
            publish()
            reply(peer, 200, json(["ok": true]))
            return
        }
        guard route == "/api/control" else {
            failHTTP(404, "Not found")
            return
        }
        let action = text(v["action"])
        guard
            [
                "toggle-play-pause", "next-track", "previous-track", "seek-back", "seek-forward",
                "shuffle", "repeat", "seek",
            ].contains(action)
        else {
            failHTTP(400, "Unknown action")
            return
        }
        guard !controlBusy, media["status"] as? String == "ready" else {
            failHTTP(409, "Player unavailable or command pending.")
            return
        }
        if let target = v["sourceId"] as? String, target != players.selected {
            failHTTP(409, "Player changed. Try again.")
            return
        }
        let caps = media["capabilities"] as? [String: Bool] ?? [:]
        var absoluteSeek: Double?
        if action == "seek" {
            guard caps["seek"] == true, let target = v["seconds"] as? NSNumber,
                CFGetTypeID(target) != CFBooleanGetTypeID(), target.doubleValue.isFinite,
                target.doubleValue >= 0, target.doubleValue <= numeric(media["duration"])
            else {
                failHTTP(400, "Invalid seek position")
                return
            }
            absoluteSeek = target.doubleValue
        }
        if media["source"] as? String == "browser-bridge" {
            guard ["toggle-play-pause", "seek-back", "seek-forward", "seek"].contains(action),
                action == "toggle-play-pause" || caps["seek"] == true
            else {
                failHTTP(409, "Control unavailable in this video.")
                return
            }
            guard peers.values.contains(where: { $0.browser }) else {
                failHTTP(409, "Browser bridge disconnected.")
                return
            }
            controlBusy = true
            let id = UUID().uuidString
            browserCommand = (id, peer)
            var packet = Data("event: browser-command\ndata: ".utf8)
            packet.append(
                json([
                    "id": id, "action": action, "seconds": absoluteSeek ?? seekStep,
                    "tabId": media["tabId"] ?? NSNull(),
                ]))
            packet.append(Data("\n\n".utf8))
            peers.values.filter { $0.browser }.forEach { $0.push(packet) }
            browserTimeout = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) {
                [weak self] _ in
                guard let self = self else { return }
                self.browserCommand = nil
                self.controlBusy = false
                self.reply(
                    peer, 503,
                    json(["error": "Browser did not confirm the command. It was not retried."]))
            }
            return
        }
        var args = absoluteSeek.map { ["seek", String($0)] } ?? [action]
        var expected: Int?
        if action == "repeat" || action == "shuffle" {
            guard caps[action] == true else {
                failHTTP(409, "Control unavailable in this player.")
                return
            }
            let current = Int(numeric(media["\(action)Mode"]))
            expected = action == "repeat" ? [1: 3, 3: 2, 2: 1][current] : (current == 1 ? 3 : 1)
            guard let n = expected else {
                failHTTP(409, "Control state unavailable.")
                return
            }
            args = [action, "\(n)"]
        }
        if action == "next-track" || action == "previous-track" {
            guard caps["skip"] == true else {
                failHTTP(409, "Track navigation unavailable.")
                return
            }
        }
        if action == "seek-back" || action == "seek-forward" {
            guard caps["seek"] == true else {
                failHTTP(409, "Seeking unavailable.")
                return
            }
            let elapsed =
                numeric(media["elapsed"])
                + ((media["playing"] as? Bool ?? false)
                    ? max(0, Date().timeIntervalSince1970 - numeric(media["timestamp"]) / 1000)
                        * numeric(media["rate"]) : 0)
            args = [
                "seek",
                String(
                    min(
                        numeric(media["duration"]),
                        max(0, elapsed + (action == "seek-back" ? -seekStep : seekStep)))),
            ]
        }
        let useMusic = media["source"] as? String == "com.apple.Music"
        controlBusy = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let musicResult =
                useMusic
                ? musicCommand(
                    args[0], mode: expected, position: args[0] == "seek" ? Double(args[1]) : nil)
                : nil
            let commandOK = useMusic ? musicResult != nil : executeTool(self.helper, args).ok
            DispatchQueue.main.async {
                if !commandOK {
                    self.controlBusy = false
                    failHTTP(503, "The player did not accept the command.")
                    return
                }
                if let musicResult = musicResult {
                    self.updateMusic(musicResult)
                    self.refreshMusic()
                    self.controlBusy = false
                    self.reply(peer, 200, json(["ok": true]))
                    return
                }
                if let expected = expected {
                    let deadline = Date().addingTimeInterval(2)
                    func confirm() {
                        if Int(numeric(self.media["\(action)Mode"])) == expected {
                            self.controlBusy = false
                            self.reply(peer, 200, json(["ok": true]))
                            return
                        }
                        if Date() >= deadline {
                            self.controlBusy = false
                            failHTTP(409, "The player did not confirm the change.")
                            return
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: confirm)
                    }
                    confirm()
                } else {
                    self.controlBusy = false
                    self.reply(peer, 200, json(["ok": true]))
                }
            }
        }
    }
    func storeSettings(_ next: [String: Any]) throws {
        guard validSettings(next) else { throw NSError(domain: "CarThing", code: 1) }
        let preferences: [String: Any] = ["unit": next["unit"]!]
        try json(preferences).write(
            to: runtime.appendingPathComponent("settings.json"), options: .atomic)
        settings = preferences
        weather = ["status": currentLocation == nil ? "unconfigured" : "loading"]
        publish()
        refreshWeather()
    }
    func stop() {
        SideThingNightShiftStop()
        countdown.stop()
        if let observer = musicTermination {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        if let observer = musicObserver {
            DistributedNotificationCenter.default().removeObserver(observer)
        }
        SystemAudio.stop()
        locator?.stop()
        shuttingDown = true
        restartTimer?.invalidate()
        heartbeat?.invalidate()
        weatherTimer?.invalidate()
        child?.terminate()
        listener?.cancel()
        peers.values.forEach { $0.connection.cancel() }
    }
}

final class App: NSObject, NSApplicationDelegate {
    let service = Service()
    var item: NSStatusItem?
    var device: USBDevice?
    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try service.start() } catch {
            fputs("Car Thing service could not start: \(error).\n", stderr)
            NSApplication.shared.terminate(nil)
            return
        }
        if !CommandLine.arguments.contains("--headless") {
            item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item?.button?.image = NSImage(
                systemSymbolName: "play.rectangle", accessibilityDescription: "SideThing")
            let menu = NSMenu()
            menu.addItem(
                withTitle: "Open display", action: #selector(openDisplay), keyEquivalent: "")
            menu.addItem(
                withTitle: "Preview all screens", action: #selector(openScreens), keyEquivalent: "")
            menu.addItem(
                withTitle: "Check for updates…", action: #selector(checkUpdates), keyEquivalent: "")
            menu.addItem(
                withTitle: "Use current location", action: #selector(weatherLocation),
                keyEquivalent: "")
            menu.addItem(
                withTitle: "Weather by Open-Meteo", action: #selector(weatherAttribution),
                keyEquivalent: "")
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
            for entry in menu.items { entry.target = self }
            item?.menu = menu
        }
        device = USBDevice { [weak self] message in
            self?.item?.button?.toolTip = message
            self?.service.publish()
        }
        service.requestCurrentLocation = { [weak self] in self?.weatherLocation() }
        if !CommandLine.arguments.contains("--headless") {
            let locator = CurrentLocation()
            service.locator = locator
            locator.changed = { [weak self] value in
                guard let self = self else { return }
                if json(self.service.currentLocation ?? [:]) != json(value) {
                    self.service.weather = ["status": "loading"]
                }
                self.service.currentLocation = value
                self.service.publish()
                self.service.refreshWeather()
            }
            locator.status = { [weak self] status in
                guard let self = self else { return }
                if status == "location-denied" {
                    self.service.currentLocation = nil
                    self.service.weather = ["status": status]
                } else if self.service.weather["current"] == nil {
                    self.service.weather["status"] = status
                }
                self.service.publish()
            }
            locator.request()
        }
        service.device = device
        device?.start()
        if CommandLine.arguments.contains("--open") { openDisplay() }
    }
    @objc func openDisplay() { NSWorkspace.shared.open(URL(string: "\(origin)/#\(token)")!) }
    @objc func openScreens() { NSWorkspace.shared.open(URL(string: "\(origin)/screens.html")!) }
    @objc func weatherLocation() {
        guard let locator = service.locator else { return }
        if locator.manager.authorizationStatus == .denied
            || locator.manager.authorizationStatus == .restricted
        {
            NSWorkspace.shared.open(
                URL(
                    string:
                        "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
                )!)
        } else {
            locator.request()
        }
    }
    @objc func checkUpdates() { checkForUpdates() }
    @objc func weatherAttribution() {
        NSWorkspace.shared.open(URL(string: "https://open-meteo.com/")!)
    }
    @objc func quit() { NSApplication.shared.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        device?.stop()
        service.stop()
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let app = App()
application.delegate = app
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
term.setEventHandler { application.terminate(nil) }
interrupt.setEventHandler { application.terminate(nil) }
term.resume()
interrupt.resume()
application.run()
