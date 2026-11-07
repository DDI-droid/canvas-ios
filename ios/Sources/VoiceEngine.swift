import AVFoundation
import Speech

/// The app's one audio engine, for both directions: the microphone (into the recogniser) and
/// the voice (speech synthesis played through `player`). With Apple's voice processing on, the
/// engine's echo canceller knows exactly what it is playing and removes it from the mic, so the
/// recogniser hears the user but not the app's own voice. Talking over the voice still works;
/// the voice no longer interrupts itself. (Like a speakerphone call.)
///
/// If voice processing isn't available on the current route, the engine runs without it and
/// the page's echo filter (live.js) is the fallback.
@MainActor
final class VoiceEngine {
    static let shared = VoiceEngine()

    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let tapTarget = TapTarget()
    private(set) var echoCancelling = false
    private(set) var playFormat = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    private var configured = false
    private var tapInstalled = false
    private var idleTask: Task<Void, Never>?
    var isBusy: () -> Bool = { false } // set by the owners: recognising or speaking right now

    private init() {
        engine.attach(player)
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine,
                                               queue: .main) { [weak self] _ in
            // a route change (AirPods in or out) stops the engine: rebuild on next use
            MainActor.assumeIsolated { self?.reset() }
        }
    }

    /// Start the engine, or keep it running. False if the audio hardware couldn't start.
    func start() -> Bool {
        idleTask?.cancel()
        if engine.isRunning && tapInstalled { return true }
        guard AudioSession.shared.activate() else { return false }
        if !configured { configure(voiceProcessing: true) }
        installTap()
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            guard echoCancelling else { return false }
            // voice processing refused on this route: run plain audio instead
            reset()
            configure(voiceProcessing: false)
            installTap()
            engine.prepare()
            return (try? engine.start()) != nil
        }
    }

    /// Stop after a quiet spell (frees the mic: the orange dot goes away).
    func scheduleIdleStop(after seconds: Double = 30) {
        idleTask?.cancel()
        idleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled, let self, !self.isBusy() else { return }
            self.stop()
        }
    }

    func stop() {
        idleTask?.cancel()
        player.stop()
        if engine.isRunning { engine.stop() }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
    }

    private func reset() {
        stop()
        configured = false
    }

    private func configure(voiceProcessing: Bool) {
        echoCancelling = false
        if voiceProcessing {
            do {
                try engine.inputNode.setVoiceProcessingEnabled(true)
                echoCancelling = true
                if #available(iOS 17.0, *) {
                    // don't turn other audio down while the mic is on
                    engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration =
                        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
                }
            } catch {
                echoCancelling = false
            }
        } else {
            try? engine.inputNode.setVoiceProcessingEnabled(false)
        }
        let rate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        playFormat = AVAudioFormat(standardFormatWithSampleRate: rate > 0 ? rate : 48000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)
        configured = true
    }

    private func installTap() {
        guard !tapInstalled else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format, block: tapTarget.block)
        tapInstalled = true
    }
}

/// Where the microphone tap sends audio: the current recognition request, if any. The tap runs
/// on the audio thread, so the request is swapped under a lock.
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
