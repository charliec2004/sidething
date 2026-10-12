import AppKit

// Direct Music scripting API: MediaRemote omits its shuffle/repeat settings.
func runMusicCommand(_ arguments: [String]) -> Never {
    guard let action = arguments.first else { exit(1) }
    let n = arguments.count > 1 ? Int(arguments[1]) : nil
    let command: String
    switch action {
    case "get": command = ""
    case "shuffle":
        guard let n = n, [1, 3].contains(n) else { exit(1) }
        command = "set shuffle enabled to \(n == 3 ? "true" : "false")"
    case "repeat":
        guard let n = n, (1...3).contains(n) else { exit(1) }
        command = "set song repeat to \([1: "off", 2: "one", 3: "all"][n]!)"
    case "next-track": command = "next track"
    case "previous-track": command = "previous track"
    case "toggle-play-pause": command = "playpause"
    case "seek":
        guard arguments.count == 2, let seconds = Double(arguments[1]), seconds.isFinite,
            (0...864000).contains(seconds)
        else { exit(1) }
        command = "set player position to \(seconds)"
    default: exit(1)
    }
    let source = """
        with timeout of 2 seconds
            tell application id "com.apple.Music"
                if not running then error "Music is not running"
                \(command)
                set s to 1
                if shuffle enabled then set s to 3
                set r to 1
                if song repeat is one then set r to 2
                if song repeat is all then set r to 3
                set t to ""
                set a to ""
                set d to 0
                set p to 0
                try
                    set t to name of current track
                    set a to artist of current track
                    set d to duration of current track
                    set p to player position
                end try
                return {s, r, t, a, d, p, player state is playing}
            end tell
        end timeout
        """
    var error: NSDictionary?
    guard let result = NSAppleScript(source: source)?.executeAndReturnError(&error), error == nil,
        result.numberOfItems == 7
    else { exit(1) }
    var value: [String: Any] = [
        "shuffleMode": result.atIndex(1)!.int32Value,
        "repeatMode": result.atIndex(2)!.int32Value,
        "title": result.atIndex(3)!.stringValue ?? "",
        "artist": result.atIndex(4)!.stringValue ?? "",
        "duration": result.atIndex(5)!.doubleValue, "elapsed": result.atIndex(6)!.doubleValue,
        "playing": result.atIndex(7)!.booleanValue,
        "timestamp": Date().timeIntervalSince1970 * 1000,
    ]
    if action == "get", !((value["title"] as? String) ?? "").isEmpty {
        let script = NSAppleScript(
            source:
                "with timeout of 2 seconds\n tell application id \"com.apple.Music\" to get raw data of artwork 1 of current track\nend timeout"
        )
        var artworkError: NSDictionary?
        if let raw = script?.executeAndReturnError(&artworkError), artworkError == nil,
            let image = NSImage(data: raw.data), let tiff = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiff)
        {
            let scale = 240 / CGFloat(max(1, max(bitmap.pixelsWide, bitmap.pixelsHigh)))
            let size = NSSize(
                width: CGFloat(bitmap.pixelsWide) * scale,
                height: CGFloat(bitmap.pixelsHigh) * scale)
            let small = NSImage(size: size)
            small.lockFocus()
            image.draw(in: NSRect(origin: .zero, size: size))
            small.unlockFocus()
            if let t = small.tiffRepresentation, let b = NSBitmapImageRep(data: t),
                let jpeg = b.representation(using: .jpeg, properties: [.compressionFactor: 0.65]),
                jpeg.count < 40000
            {
                value["artworkData"] = jpeg.base64EncodedString()
            }
        }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { exit(1) }
    FileHandle.standardOutput.write(data)
    exit(0)
}
func musicCommand(_ action: String = "get", mode: Int? = nil, position: Double? = nil) -> [String:
    Any]?
{
    let executable = env["CARTHING_MUSIC_BIN"] ?? CommandLine.arguments[0]
    let result = executeTool(
        executable,
        ["--music-control", action]
            + (position.map { [String($0)] } ?? mode.map { [String($0)] } ?? []), capture: true)
    guard result.ok, let data = result.output.data(using: .utf8),
        let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let shuffle = value["shuffleMode"] as? Int, [1, 3].contains(shuffle),
        let repeatMode = value["repeatMode"] as? Int, (1...3).contains(repeatMode)
    else { return nil }
    return value
}
