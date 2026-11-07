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
/// The microphone engine keeps running between sessions (the page's live mode restarts its
/// session after every answer): a new session just swaps in a fresh recognition request, so
/// no words are lost to a restart. The engine stops after 30 s without a session, or when the
/// app goes to the background.
@MainActor
final class SpeechBridge: NSObject {
    weak var webView: WKWebView?

    private let engine = AVAudioEngine()
    private let target = TapTarget()
    private var tapInstalled = false
    private var recognizers: [String: SFSpeechRecognizer] = [:]
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var activeId = 0      // session currently recognising (0 = none)
    private var pendingId = 0     // session waiting on permission prompts
    private var lastText = ""
    private var pauseTask: Task<Void, Never>?
    private var endTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(audioInterrupted(_:)),
                                               name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(engineChanged(_:)),
                                               name: .AVAudioEngineConfigurationChange, object: engine)
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

    /// App went to the background, or the page died: end everything and free the mic.
    func stopAll() {
        pendingId = 0
        if activeId != 0 { finish(graceful: false) }
        stopEngine()
    }

    @objc nonisolated private func audioInterrupted(_ note: Notification) {
        Task { @MainActor [weak self] in self?.stopAll() }
    }

    // A route change (AirPods in or out) reconfigures the engine and stops it.
    @objc nonisolated private func engineChanged(_ note: Notification) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.tearDownTap()
            if self.activeId != 0 { self.finish(graceful: false) } // the page starts a new session
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
        guard startEngine() else { return fail(id, "audio-capture") }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        req.addsPunctuation = true

        idleTask?.cancel()
        request = req
        activeId = id
        lastText = ""
        target.set(req)
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
            target.set(nil)
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
        scheduleIdleStop()
    }

    /// Ends the recognition session; the microphone keeps running for the next one.
    private func endSession() {
        pauseTask?.cancel()
        endTask?.cancel()
        target.set(nil)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        activeId = 0
        lastText = ""
        scheduleIdleStop()
    }

    // MARK: microphone engine

    private func startEngine() -> Bool {
        if engine.isRunning && tapInstalled { return true }
        guard AudioSession.shared.activate() else { return false }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        if !tapInstalled {
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format, block: target.block)
            tapInstalled = true
        }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            tearDownTap()
            return false
        }
    }

    private func scheduleIdleStop() {
        idleTask?.cancel()
        idleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled, let self, self.activeId == 0, self.pendingId == 0 else { return }
            self.stopEngine()
        }
    }

    private func stopEngine() {
        idleTask?.cancel()
        tearDownTap()
    }

    private func tearDownTap() {
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
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

/// Where the microphone tap sends audio: the current recognition request, if any. The tap
/// runs on the audio thread, so the request is swapped under a lock.
final class TapTarget: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ req: SFSpeechAudioBufferRecognitionRequest?) {
        lock.lock()
        request = req
        lock.unlock()
    }

    var block: AVAudioNodeTapBlock {
        return { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock()
            let req = self.request
            self.lock.unlock()
            req?.append(buffer)
        }
    }
}
