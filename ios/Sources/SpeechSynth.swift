import AVFoundation
import WebKit

/// Native text-to-speech for the page, behind the `speechSynthesis` shim in NativeScripts.
/// Safari only lets web pages use Apple's basic voices; an app can use every installed voice,
/// including the Premium and Enhanced ones the user downloaded (Ava, Zoe, …).
///
/// The voice is rendered to audio buffers (AVSpeechSynthesizer.write) and played through
/// VoiceEngine, the same engine the microphone uses. With voice processing on, its echo
/// canceller removes the voice from the mic, so the voice doesn't hear (and interrupt) itself.
/// If the engine can't start, it falls back to plain AVSpeechSynthesizer.speak.
///
/// Page → native (canvasSynth): {op: "speak", id, text, voice, lang, rate, pitch, volume}
///                               {op: "cancel"} {op: "pause"} {op: "resume"}
/// Native → page: window.__canvasSynth.emit(id, "start" | "end")
@MainActor
final class SpeechSynth: NSObject {
    weak var webView: WKWebView?

    private let synth = AVSpeechSynthesizer()
    private let voice = VoiceEngine.shared
    private let output = SynthOutput()
    private var generation = 0                     // bumps on cancel: late audio is dropped
    private(set) var playing = 0                   // utterances started and not finished
    private var fallbackIds: [ObjectIdentifier: Int] = [:]  // speak() path, if the engine is down

    override init() {
        super.init()
        synth.delegate = self
        synth.usesApplicationAudioSession = true
    }

    /// Every installed voice (minus novelty and Personal Voice), as the page's getVoices()
    /// sees them. Quality goes into the name, e.g. "Ava (Premium)", so the page's ranking puts
    /// the best voices first. iPadOS often has it in the name already.
    static func voiceList() -> [[String: Any]] {
        let fallback = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())?.identifier
        var out: [[String: Any]] = []
        for v in AVSpeechSynthesisVoice.speechVoices() {
            if v.voiceTraits.contains(.isNoveltyVoice) || v.voiceTraits.contains(.isPersonalVoice) { continue }
            var name = v.name
            let lower = name.lowercased()
            switch v.quality {
            case .premium where !lower.contains("premium"): name += " (Premium)"
            case .enhanced where !lower.contains("enhanced"): name += " (Enhanced)"
            default: break
            }
            out.append(["name": name, "lang": v.language, "voiceURI": v.identifier,
                        "default": v.identifier == fallback])
        }
        return out
    }

    static func voiceListJSON() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: voiceList()),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    // MARK: page messages

    func receive(_ body: Any) {
        guard let m = body as? [String: Any], let op = m["op"] as? String else { return }
        switch op {
        case "speak":
            speak(m)
        case "cancel":
            cancelAll()
        case "pause":
            voice.player.pause()
            synth.pauseSpeaking(at: .word)
        case "resume":
            voice.player.play()
            synth.continueSpeaking()
        default:
            break
        }
    }

    func stopAll() {
        cancelAll()
    }

    private func cancelAll() {
        generation += 1
        output.setGeneration(generation)
        synth.stopSpeaking(at: .immediate)
        voice.player.stop()
        fallbackIds.removeAll()
        playing = 0 // the page already ended these utterances
        voice.scheduleIdleStop()
    }

    private func speak(_ m: [String: Any]) {
        let id = (m["id"] as? NSNumber)?.intValue ?? 0
        let text = (m["text"] as? String) ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            emit(id, "start") // the page's "unlock" utterance: nothing to say
            emit(id, "end")
            return
        }
        let u = AVSpeechUtterance(string: text)
        if let vid = m["voice"] as? String, !vid.isEmpty, let v = AVSpeechSynthesisVoice(identifier: vid) {
            u.voice = v
        } else if let lang = m["lang"] as? String, !lang.isEmpty, let v = AVSpeechSynthesisVoice(language: lang) {
            u.voice = v
        }
        // Web Speech rate 1 = normal; AVSpeechUtteranceDefaultSpeechRate is AVFoundation's normal.
        let rate = (m["rate"] as? NSNumber)?.floatValue ?? 1
        u.rate = min(AVSpeechUtteranceMaximumSpeechRate,
                     max(AVSpeechUtteranceMinimumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate))
        u.pitchMultiplier = min(2, max(0.5, (m["pitch"] as? NSNumber)?.floatValue ?? 1))
        u.volume = min(1, max(0, (m["volume"] as? NSNumber)?.floatValue ?? 1))
        u.prefersAssistiveTechnologySettings = false

        playing += 1
        guard voice.start() else {
            AudioSession.shared.activate()
            fallbackIds[ObjectIdentifier(u)] = id
            synth.speak(u)
            return
        }
        if !voice.player.isPlaying { voice.player.play() }
        output.setGeneration(generation)
        synth.write(u, toBufferCallback: Self.bufferCallback(owner: self, output: output, player: voice.player,
                                                             format: voice.playFormat, generation: generation, id: id))
    }

    // Built outside the main actor: the synthesizer calls this on its own thread.
    nonisolated private static func bufferCallback(owner: SpeechSynth, output: SynthOutput, player: AVAudioPlayerNode,
                                                   format: AVAudioFormat, generation: Int, id: Int)
        -> AVSpeechSynthesizer.BufferCallback {
        let started = Flag()
        return { [weak owner] buffer in
            guard output.isCurrent(generation), let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                // end of this utterance: report it once everything scheduled so far has played
                guard let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1) else { return }
                tail.frameLength = 1
                player.scheduleBuffer(tail, completionCallbackType: .dataPlayedBack) { _ in
                    Task { @MainActor in owner?.finished(id: id, generation: generation) }
                }
                return
            }
            guard let converted = output.convert(pcm, to: format) else { return }
            player.scheduleBuffer(converted, completionHandler: nil)
            if !started.on {
                started.on = true
                Task { @MainActor in owner?.started(id: id, generation: generation) }
            }
        }
    }

    fileprivate func started(id: Int, generation g: Int) {
        guard g == generation else { return }
        emit(id, "start")
    }

    fileprivate func finished(id: Int, generation g: Int) {
        guard g == generation else { return }
        playing = max(0, playing - 1)
        emit(id, "end")
        voice.scheduleIdleStop()
    }

    fileprivate func fallbackEvent(_ key: ObjectIdentifier, _ type: String, done: Bool) {
        guard let id = fallbackIds[key] else { return }
        if done {
            fallbackIds[key] = nil
            playing = max(0, playing - 1)
        }
        emit(id, type)
    }

    private func emit(_ id: Int, _ type: String) {
        webView?.evaluateJavaScript("window.__canvasSynth&&window.__canvasSynth.emit(\(id),'\(type)')",
                                    completionHandler: nil)
    }
}

// Only the fallback path (plain speak) reports through the delegate.
extension SpeechSynth: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.fallbackEvent(key, "start", done: false) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.fallbackEvent(key, "end", done: true) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.fallbackEvent(key, "end", done: true) }
    }
}

/// Converts the synthesizer's audio to the engine's format. Used on the synthesizer's thread.
final class SynthOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0
    private var converter: AVAudioConverter?

    func setGeneration(_ g: Int) {
        lock.lock()
        current = g
        lock.unlock()
    }

    func isCurrent(_ g: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return g == current
    }

    func convert(_ buf: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        if buf.format == format { return buf }
        if converter == nil || converter!.inputFormat != buf.format || converter!.outputFormat != format {
            converter = AVAudioConverter(from: buf.format, to: format)
        }
        guard let conv = converter else { return nil }
        let ratio = format.sampleRate / buf.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 256
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        let fed = Flag()
        var error: NSError?
        let status = conv.convert(to: out, error: &error) { _, inputStatus in
            if fed.on {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed.on = true
            inputStatus.pointee = .haveData
            return buf
        }
        return (status == .error || error != nil || out.frameLength == 0) ? nil : out
    }
}

/// A mutable flag a callback can capture.
final class Flag: @unchecked Sendable {
    var on = false
}
