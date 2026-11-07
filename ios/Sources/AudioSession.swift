import AVFoundation

/// One audio session for both directions: the mic (SpeechBridge) and the voice (SpeechSynth).
/// It stays active while the app is in front, so stopping the mic never cuts off speech that
/// is playing, and starting it never waits on a session switch.
@MainActor
final class AudioSession {
    static let shared = AudioSession()

    private init() {}

    /// Safe to call often: re-applies the category, which also recovers after an interruption
    /// (a call, Siri) deactivated the session.
    @discardableResult
    func activate() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            // playAndRecord: listen and speak at once (talking over the voice works).
            // defaultToSpeaker: the voice comes out of the speaker, not the earpiece.
            // allowBluetoothA2DP: AirPods play the voice in full quality (the mic stays the
            // iPad's own, which also keeps the voice out of the mic).
            try session.setCategory(.playAndRecord, mode: .default,
                                    options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }

    func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
