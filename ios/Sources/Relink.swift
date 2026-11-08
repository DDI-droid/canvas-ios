import Foundation

/// Following the canvas server when its address changes.
///
/// The PC runs the canvas behind a free Cloudflare tunnel whose address changes whenever the
/// tunnel restarts. `canvas/supervisor.py` publishes every new address to a secret GitHub gist
/// (the address only, never the key). The page tells the app where that gist is (a default is
/// built in). When the saved address stops answering, the app reads the gist and loads the new
/// address with the same key and session. Nobody pastes a link again.
enum Relink {
    /// This canvas's gist. The page's `registry` message overrides it (another PC, a new gist).
    static let builtIn = "https://api.github.com/gists/257df7d1676f8d1a8c62e2e01de04599"
    private static let defaultsKey = "canvas.registry"

    static var registry: URL? {
        get { URL(string: UserDefaults.standard.string(forKey: defaultsKey) ?? builtIn) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: defaultsKey) }
    }

    static func isRegistry(_ text: String) -> Bool {
        text.range(of: #"^https://api\.github\.com/gists/[0-9a-f]{8,64}$"#, options: .regularExpression) != nil
    }

    /// Where the canvas is now (an https origin), or nil if the gist can't be read.
    static func lookup(_ done: @escaping (URL?) -> Void) {
        guard let base = registry, var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return done(nil)
        }
        comps.queryItems = [URLQueryItem(name: "t", value: String(Int(Date().timeIntervalSince1970)))]
        guard let url = comps.url else { return done(nil) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("CanvasApp", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            var found: URL?
            if let data,
               let gist = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let files = gist["files"] as? [String: Any],
               let file = files["canvas-link.json"] as? [String: Any],
               let content = file["content"] as? String,
               let info = try? JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any],
               let raw = info["url"] as? String,
               let u = URL(string: raw), u.scheme == "https", let host = u.host, !host.isEmpty {
                found = u
            }
            DispatchQueue.main.async { done(found) }
        }.resume()
    }

    /// The saved link at a new host: same path, key and session.
    static func moved(_ link: URL, to origin: URL) -> URL? {
        guard var comps = URLComponents(url: link, resolvingAgainstBaseURL: false),
              let host = origin.host, !host.isEmpty else { return nil }
        comps.scheme = "https"
        comps.host = host
        comps.port = origin.port
        return comps.url
    }

    /// Errors that mean "nothing answers at this address" (as opposed to, say, no internet).
    static func isDeadAddress(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        return [NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed,
                NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorBadServerResponse,
                NSURLErrorSecureConnectionFailed].contains(ns.code)
    }
}

/// The page's settings and unsent ink, kept by the app as well. The browser keeps a page's
/// storage per address, and the canvas's address can change (Relink), so the page posts every
/// change here and each page load gets a copy (`window.__canvasNativeStore`, util.js).
/// One small file per key in Application Support.
enum NativeStore {
    private static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("PageStore", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private static func file(for key: String) -> URL? {
        guard !key.isEmpty, key.count <= 120,
              let name = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
        return dir.appendingPathComponent(name)
    }

    static func set(_ key: String, _ value: String?) {
        guard let f = file(for: key) else { return }
        if let value {
            try? Data(value.utf8).write(to: f, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: f)
        }
    }

    /// `window.__canvasNativeStore = {…}`, injected at document start.
    static func script() -> String {
        var all: [String: String] = [:]
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for f in files {
            guard let key = f.lastPathComponent.removingPercentEncoding,
                  let value = try? String(contentsOf: f, encoding: .utf8) else { continue }
            all[key] = value
        }
        let data = (try? JSONSerialization.data(withJSONObject: all)) ?? Data("{}".utf8)
        return "window.__canvasNativeStore = \(String(data: data, encoding: .utf8) ?? "{}");"
    }
}
