import Foundation

// One deadline and one completion callback; no per-second work on the Mac.
final class Countdown {
    let file: URL
    let now: () -> TimeInterval
    var phase = "idle", remaining = 0.0, endsAt = 0.0, finishedAt = 0.0, duration = 0.0
    var changed: (() -> Void)?, completed: (() -> Void)?
    var alarm: Timer?
    init(file: URL, now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.file = file
        self.now = now
        if let data = try? Data(contentsOf: file),
            let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let phase = saved["phase"] as? String,
            ["idle", "ready", "running", "paused", "finished"].contains(phase),
            let remaining = saved["remaining"] as? Double, remaining.isFinite,
            (0...86400).contains(remaining),
            let end = saved["endsAt"] as? Double, end.isFinite
        {
            self.phase = phase
            self.remaining = remaining
            self.endsAt = end
            self.finishedAt = max(0, saved["finishedAt"] as? Double ?? 0)
            if let duration = saved["duration"] as? Double, duration.isFinite,
                (0...86400).contains(duration)
            {
                self.duration = duration
            } else if phase != "idle" {
                self.duration = max(60, ceil(remaining / 60) * 60)
            }
        }
    }
    var seconds: Double { phase == "running" ? max(0, endsAt - now()) : remaining }
    var snapshot: [String: Any] {
        [
            "phase": phase, "remaining": seconds, "endsAt": endsAt * 1000,
            "finishedAt": finishedAt * 1000, "duration": duration,
        ]
    }
    func start() { arm() }
    func apply(_ action: String, minutes: Int = 0) {
        switch action {
        case "adjust", "set":
            let value =
                action == "set"
                ? Double(minutes * 60) : (phase == "idle" ? 60 : seconds) + Double(minutes * 60)
            remaining = min(86400, max(60, value))
            duration =
                (phase == "running" || phase == "paused") && action == "adjust"
                ? min(86400, max(60, duration + Double(minutes * 60))) : remaining
            if phase == "running" {
                endsAt = now() + remaining
            } else if phase != "paused" {
                phase = "ready"
            }
        case "toggle":
            if phase == "running" {
                remaining = seconds
                phase = "paused"
                endsAt = 0
            } else {
                guard remaining > 0 else { return }
                endsAt = now() + remaining
                phase = "running"
            }
        case "replay":
            guard phase == "finished", duration > 0 else { return }
            remaining = duration
            endsAt = now() + duration
            phase = "running"
        case "reset":
            phase = "idle"
            duration = 0
            remaining = 0
            endsAt = 0
        default: return
        }
        finishedAt = 0
        save()
        arm()
        changed?()
    }
    func expireIfNeeded() {
        guard phase == "running", seconds <= 0 else { return }
        phase = "finished"
        finishedAt = now()
        remaining = 0
        endsAt = 0
        save()
        alarm?.invalidate()
        alarm = nil
        changed?()
        completed?()
    }
    func arm() {
        alarm?.invalidate()
        alarm = nil
        guard phase == "running" else { return }
        if seconds <= 0 {
            expireIfNeeded()
            return
        }
        alarm = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.expireIfNeeded()
            if self?.phase == "running" { self?.arm() }
        }
    }
    func save() {
        let saved: [String: Any] = [
            "phase": phase, "remaining": remaining, "endsAt": endsAt,
            "finishedAt": finishedAt, "duration": duration,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: saved) {
            try? data.write(to: file, options: .atomic)
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
    }
    func stop() {
        alarm?.invalidate()
        alarm = nil
    }
}
