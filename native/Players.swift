import Foundation

// Only retain players we can address independently: Music and bridged tabs.
// MediaRemote's other apps remain available while they own the media session.
final class Players {
    struct Player {
        var media: [String: Any]
        var artwork: Data
        var encoded: String
        var started: TimeInterval
    }
    var items: [String: Player] = [:]
    var selected = ""
    var native = ""
    var current: Player? { items[selected] }
    func update(_ id: String, media: [String: Any], artwork: Data, encoded: String = "") {
        let previous = items[id]
        let playing = media["playing"] as? Bool == true
        let started =
            previous == nil
            || (playing
                && (previous?.media["playing"] as? Bool != true
                    || previous?.media["title"] as? String != media["title"] as? String))
        items[id] = Player(
            media: media, artwork: artwork, encoded: encoded,
            started: started ? Date().timeIntervalSince1970 : previous!.started)
        if selected.isEmpty || started && playing { selected = id }
        if items.count > 8, let oldest = ordered.last { remove(oldest) }
    }
    var ordered: [String] { items.keys.sorted { items[$0]!.started > items[$1]!.started } }
    func remove(_ id: String) {
        items[id] = nil
        if selected == id { selected = ordered.first ?? "" }
    }
    func cycle() {
        let ids = ordered
        guard !ids.isEmpty else { return }
        selected = ids[((ids.firstIndex(of: selected) ?? -1) + 1) % ids.count]
    }
    func nativeChanged(_ id: String) {
        if native != id, native != "com.apple.Music" { remove(native) }
        native = id
    }
    func removeBrowser() {
        for id in Array(items.keys) where id.hasPrefix("browser:") { remove(id) }
    }
}
