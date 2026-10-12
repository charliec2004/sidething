import AppKit

// Updates are explicit and built from the same public source checkout.
func checkForUpdates() {
    let endpoint = URL(
        string: "https://api.github.com/repos/charliec2004/sidething/releases/latest")!
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 10
    request.setValue("SideThing", forHTTPHeaderField: "User-Agent")
    URLSession.shared.dataTask(with: request) { data, response, _ in
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "SideThing updates"
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                let release = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let tag = release["tag_name"] as? String,
                tag.range(of: #"^v[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil
            else {
                alert.informativeText = "Couldn’t check GitHub. Try again when you’re online."
                alert.runModal()
                return
            }
            let version =
                (try? String(
                    contentsOf: resources.appendingPathComponent("VERSION"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? "0.1.0"
            guard String(tag.dropFirst()).compare(version, options: .numeric) == .orderedDescending
            else {
                alert.informativeText = "You’re up to date (\(version))."
                alert.runModal()
                return
            }
            alert.informativeText =
                "\(tag) is available. Update will build it from your source checkout and restart the helper. Pairing and settings are retained."
            alert.addButton(withTitle: "Update")
            alert.addButton(withTitle: "Later")
            guard alert.runModal() == .alertFirstButtonReturn,
                let checkout = try? String(
                    contentsOf: resources.appendingPathComponent("source-root.txt"), encoding: .utf8
                )
            else { return }
            let runner = URL(
                fileURLWithPath: checkout.trimmingCharacters(in: .whitespacesAndNewlines)
            ).appendingPathComponent("update.command")
            NSWorkspace.shared.open(runner)
        }
    }.resume()
}
