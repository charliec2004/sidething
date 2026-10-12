import Foundation
@main struct StateChecks {
    static func main() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var now = 1000.0
        let timer = Countdown(file: dir.appendingPathComponent("timer.json"), now: { now })
        timer.apply("set", minutes: 15); timer.apply("toggle")
        now += 17.25; timer.apply("toggle")
        precondition(timer.phase == "paused" && timer.seconds == 882.75)
        let restored = Countdown(file: timer.file, now: { now })
        precondition(restored.phase == "paused" && restored.seconds == 882.75)
        timer.apply("toggle"); timer.apply("adjust", minutes: 1)
        precondition(timer.seconds == 942.75)
        var completed = 0; timer.completed = { completed += 1 }
        now += 943; timer.expireIfNeeded(); timer.expireIfNeeded()
        precondition(timer.phase == "finished" && completed == 1 && timer.finishedAt == now)
        let finished = Countdown(file: timer.file, now: { now })
        precondition(finished.phase == "finished" && finished.duration == 960)
        finished.apply("replay")
        precondition(finished.phase == "running" && finished.seconds == 960 && finished.finishedAt == 0)
        finished.stop()
        timer.apply("reset"); precondition(timer.phase == "idle" && timer.duration == 0)
        let p = Players()
        func media(_ name: String, _ playing: Bool) -> [String: Any] { ["title": name, "playing": playing] }
        p.update("music", media: media("Album", true), artwork: Data())
        p.update("browser:1", media: media("Video", true), artwork: Data())
        precondition(p.selected == "browser:1")
        p.cycle(); precondition(p.selected == "music")
        p.update("browser:1", media: media("Video", true), artwork: Data())
        precondition(p.selected == "music", "Elapsed updates must not steal selection")
        p.update("music", media: media("Album", false), artwork: Data())
        p.cycle(); precondition(p.selected == "browser:1")
        p.remove("browser:1"); precondition(p.selected == "music")
        let artwork = Data([1, 2, 3])
        p.update("music", media: media("Album", false), artwork: artwork)
        let version = p.current!.artworkVersion
        p.update("music", media: media("Album", true), artwork: artwork)
        precondition(p.current!.artworkVersion == version, "Metadata must retain the artwork version")
        p.update("music", media: media("Album", true), artwork: Data([4, 5, 6]))
        precondition(p.current!.artworkVersion != version, "New artwork needs a new version")
        print("PASS: timer pause/resume, minute adjustment, persistence and single completion; newest player selection, manual cycling and removal.")
    }
}
