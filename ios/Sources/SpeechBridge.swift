import AVFoundation
import Speech
import WebKit

/// Native speech recognition for the page, behind the Web Speech API shim in NativeScripts.
///
/// Page → native (canvasSpeech):
///   {op: "start", id, lang, interim}   {op: "stop", id}   {op: "abort", id}
/// Native → page (window.__canvasSpeech.emit(id, msg)):
///   {type: "start"} {type: "partial", text} {type: "pause"} {type: "final", text}
///   {type: "error", error, message} {type: "end"}
/// `text` is the cumulative transcript of the session; the shim splits it into results at
/// each "pause" (no new words for ~1.1 s).
///
/// Audio comes from VoiceEngine, which keeps running between sessions (the page's live mode
/// restarts its session after every answer): a new session just swaps in a fresh recognition
/// request, so no words are lost to a restart. With voice processing on, the app's own voice
/// is cancelled out of the mic before it gets here.
@MainActor
final class SpeechBridge: NSObject {
    weak var webView: WKWebView?

    private let voice = VoiceEngine.shared
    private var recognizers: [String: SFSpeechRecognizer] = [:]
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private(set) var activeId = 0  // session currently recognising (0 = none)
    private var pendingId = 0      // session waiting on permission prompts
    private var lastText = ""
    private var pauseTask: Task<Void, Never>?
    private var endTask: Task<Void, Never>?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(audioInterrupted(_:)),
                                               name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(engineChanged(_:)),
                                               name: .AVAudioEngineConfigurationChange, object: voice.engine)
    }

    // MARK: page messages

    func receive(_ body: Any) {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return }
        let id = (m["id"] as? NSNumber)?.intValue ?? 0
        switch op {
        case "start":
            start(id: id, lang: (m["lang"] as? String) ?? "en-US")
        case "stop":
            if id == pendingId { pendingId = 0; emit(id, ["type": "end"]) }
            if id == activeId { finish(graceful: true) }
        case "abort":
            if id == pendingId { pendingId = 0; emit(id, ["type": "end"]) }
            if id == activeId { finish(graceful: false) }
        default:
            break
        }
    }

    /// App went to the background, or the page died: end the session.
    func stopAll() {
        pendingId = 0
        if activeId != 0 { finish(graceful: false) }
    }

    @objc nonisolated private func audioInterrupted(_ note: Notification) {
        Task { @MainActor [weak self] in self?.stopAll() }
    }

    // A route change (AirPods in or out) stops the engine: end the session, the page starts a new one.
    @objc nonisolated private func engineChanged(_ note: Notification) {
        Task { @MainActor [weak self] in
            guard let self, self.activeId != 0 else { return }
            self.finish(graceful: false)
        }
    }

    // MARK: sessions

    private func start(id: Int, lang: String) {
        if activeId != 0 { finish(graceful: false) }
        pendingId = id
        authorize { [weak self] ok in
            guard let self, self.pendingId == id else { return } // stopped while the prompts were up
            self.pendingId = 0
            guard ok else {
                self.emit(id, ["type": "error", "error": "not-allowed"])
                self.emit(id, ["type": "end"])
                return
            }
            self.begin(id: id, lang: lang)
        }
    }

    private func authorize(_ done: @escaping @MainActor (Bool) -> Void) {
        let askMic = {
            AVAudioApplication.requestRecordPermission { granted in
                Task { @MainActor in done(granted) }
            }
        }
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            askMic()
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { status in
                Task { @MainActor in
                    if status == .authorized { askMic() } else { done(false) }
                }
            }
        default:
            done(false)
        }
    }

    private func recognizer(for lang: String) -> SFSpeechRecognizer? {
        if let r = recognizers[lang] { return r }
        let r = SFSpeechRecognizer(locale: Locale(identifier: lang))
        recognizers[lang] = r
        return r
    }

    private func begin(id: Int, lang: String) {
        guard let rec = recognizer(for: lang) else { return fail(id, "language-not-supported") }
        guard rec.isAvailable else { return fail(id, "network") }
        guard voice.start() else { return fail(id, "audio-capture") }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        req.addsPunctuation = true

        request = req
        activeId = id
        lastText = ""
        voice.tapTarget.set(req)
        // tell the page whether the app's own voice is cancelled out of the mic (live.js
        // then lets the user cut in with fewer words)
        webView?.evaluateJavaScript("window.__canvasEchoCancel=\(voice.echoCancelling)", completionHandler: nil)
        emit(id, ["type": "start"])
        task = rec.recognitionTask(with: req, resultHandler: Self.resultHandler(bridge: self, id: id))
    }

    // Built outside the main actor: this closure runs on a Speech framework thread.
    nonisolated private static func resultHandler(bridge: SpeechBridge, id: Int)
        -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
        return { [weak bridge] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let ns = error.map { $0 as NSError }
            let code = ns?.code
            let message = ns?.localizedDescription
            Task { @MainActor in
                bridge?.onTask(id: id, text: text, isFinal: isFinal, errorCode: code, errorMessage: message)
            }
        }
    }

    private func onTask(id: Int, text: String?, isFinal: Bool, errorCode: Int?, errorMessage: String?) {
        guard id == activeId else { return }
        if let text {
            if isFinal {
                emit(id, ["type": "final", "text": text])
                endSession()
                emit(id, ["type": "end"])
                return
            }
            if text != lastText {
                lastText = text
                emit(id, ["type": "partial", "text": text])
                schedulePause(id)
            }
        }
        if let errorCode {
            // 1110: no speech detected; 203/209/216/301: cancelled or retry
            let kind: String
            switch errorCode {
            case 1110: kind = "no-speech"
            case 203, 209, 216, 301: kind = "aborted"
            default: kind = "network"
            }
            if kind != "aborted" {
                emit(id, ["type": "error", "error": kind, "message": errorMessage ?? ""])
            }
            endSession()
            emit(id, ["type": "end"])
        }
    }

    private func schedulePause(_ id: Int) {
        pauseTask?.cancel()
        pauseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_100_000_000)
            guard !Task.isCancelled, let self, self.activeId == id else { return }
            self.emit(id, ["type": "pause"])
        }
    }

    private func finish(graceful: Bool) {
        let id = activeId
        guard id != 0 else { return }
        if graceful {
            // stop feeding audio, let the recogniser deliver its final result, then end
            voice.tapTarget.set(nil)
            request?.endAudio()
            task?.finish()
            endTask?.cancel()
            endTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let self, self.activeId == id else { return }
                self.endSession()
                self.emit(id, ["type": "end"])
            }
        } else {
            task?.cancel()
            endSession()
            emit(id, ["type": "end"])
        }
    }

    private func fail(_ id: Int, _ error: String) {
        emit(id, ["type": "error", "error": error])
        emit(id, ["type": "end"])
        voice.scheduleIdleStop()
    }

    /// Ends the recognition session; the engine keeps running for the next one (or the voice).
    private func endSession() {
        pauseTask?.cancel()
        endTask?.cancel()
        voice.tapTarget.set(nil)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        activeId = 0
        lastText = ""
        voice.scheduleIdleStop()
    }

    // MARK: native → page

    private func emit(_ id: Int, _ msg: [String: Any]) {
        guard let webView,
              let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__canvasSpeech&&window.__canvasSpeech.emit(\(id),\(json))",
                                   completionHandler: nil)
    }
}
