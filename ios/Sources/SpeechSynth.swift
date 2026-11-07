import AVFoundation
import WebKit

/// Native text-to-speech for the page, behind the `speechSynthesis` shim in NativeScripts.
/// Safari only lets web pages use Apple's basic voices; an app can use every installed
/// voice, including the Premium and Enhanced ones the user downloaded (Ava, Zoe, …).
///
/// Page → native (canvasSynth): {op: "speak", id, text, voice, lang, rate, pitch, volume}
///                               {op: "cancel"} {op: "pause"} {op: "resume"}
/// Native → page: window.__canvasSynth.emit(id, "start" | "end")
@MainActor
final class SpeechSynth: NSObject {
    weak var webView: WKWebView?

    private let synth = AVSpeechSynthesizer()
    private var ids: [ObjectIdentifier: Int] = [:]

    override init() {
        super.init()
        synth.delegate = self
        synth.usesApplicationAudioSession = true
    }

    /// Every installed voice (minus novelty and Personal Voice), as the page's getVoices()
    /// sees them. Quality goes into the name, e.g. "Ava (Premium)", like Safari on macOS,
    /// so the page's ranking puts the best voices first.
    static func voiceList() -> [[String: Any]] {
        let fallback = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())?.identifier
        var out: [[String: Any]] = []
        for v in AVSpeechSynthesisVoice.speechVoices() {
            if v.voiceTraits.contains(.isNoveltyVoice) || v.voiceTraits.contains(.isPersonalVoice) { continue }
            var name = v.name // iPadOS often names them "Ava (Premium)" already
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
            synth.stopSpeaking(at: .immediate)
            ids.removeAll() // the page already ended these utterances
        case "pause":
            synth.pauseSpeaking(at: .word)
        case "resume":
            synth.continueSpeaking()
        default:
            break
        }
    }

    func stopAll() {
        synth.stopSpeaking(at: .immediate)
        ids.removeAll()
    }

    private func speak(_ m: [String: Any]) {
        let id = (m["id"] as? NSNumber)?.intValue ?? 0
        let text = (m["text"] as? String) ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            emit(id, "start") // the page's "unlock" utterance: nothing to say
            emit(id, "end")
            return
        }
        AudioSession.shared.activate()
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
        ids[ObjectIdentifier(u)] = id
        synth.speak(u)
    }

    fileprivate func event(_ key: ObjectIdentifier, _ type: String, done: Bool) {
        guard let id = ids[key] else { return }
        if done { ids[key] = nil }
        emit(id, type)
    }

    private func emit(_ id: Int, _ type: String) {
        webView?.evaluateJavaScript("window.__canvasSynth&&window.__canvasSynth.emit(\(id),'\(type)')",
                                    completionHandler: nil)
    }
}

extension SpeechSynth: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.event(key, "start", done: false) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.event(key, "end", done: true) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let key = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.event(key, "end", done: true) }
    }
}
