import UIKit
import WebKit

/// Full-screen shell around the canvas web page.
/// - Loads the canvas link (saved once; set by pasting it or via canvasapp://open?url=…).
/// - Injects NativeScripts.bootstrap so the page's Web Speech code runs on Apple's native
///   recogniser (SpeechBridge) and speaks with every installed voice (SpeechSynth),
///   including the Premium voices Safari hides.
/// - Forwards Apple Pencil double-tap / squeeze to the page as DOM events.
final class CanvasViewController: UIViewController {
    private var webView: WKWebView!
    private let speech = SpeechBridge()
    private let synth = SpeechSynth()
    private let setupView = SetupView()
    private let errorView = ErrorView()
    private var loadedURL: URL?

    private static let linkKey = "canvas.link"
    private var savedLink: URL? {
        get { UserDefaults.standard.string(forKey: Self.linkKey).flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: Self.linkKey) }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    // Protect the bottom and sides from accidental system swipes while drawing; leave the top
    // free so one swipe down shows the iPadOS menu bar (Canvas › Reload, Sessions, Close…).
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { [.bottom, .left, .right] }

    // MARK: - View

    override func loadView() {
        let paper = UIColor(named: "LaunchBackground") ?? .systemBackground

        let contentController = WKUserContentController()
        let proxy = ScriptProxy(owner: self)
        contentController.add(proxy, name: "canvasNative")
        contentController.add(proxy, name: "canvasSpeech")
        contentController.add(proxy, name: "canvasSynth")
        let bootstrap = NativeScripts.bootstrap(voicesJSON: SpeechSynth.voiceListJSON())
        contentController.addUserScript(WKUserScript(source: bootstrap,
                                                     injectionTime: .atDocumentStart,
                                                     forMainFrameOnly: true))
        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.dataDetectorTypes = []
        config.websiteDataStore = .default()
        config.applicationNameForUserAgent = "Mobile/15E148 CanvasApp/1.0"

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = paper
        web.scrollView.backgroundColor = paper
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        web.navigationDelegate = self
        web.uiDelegate = self

        let pencil = UIPencilInteraction()
        pencil.delegate = self
        web.addInteraction(pencil)

        speech.webView = web
        synth.webView = web
        webView = web
        // the shared audio engine may idle-stop only when neither the mic nor the voice is in use
        VoiceEngine.shared.isBusy = { [weak self] in
            guard let self else { return false }
            return self.speech.activeId != 0 || self.synth.playing > 0
        }

        let root = UIView()
        root.backgroundColor = paper
        for sub in [web, errorView, setupView] as [UIView] {
            sub.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(sub)
            NSLayoutConstraint.activate([
                sub.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                sub.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                sub.topAnchor.constraint(equalTo: root.topAnchor),
                sub.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            ])
        }
        errorView.isHidden = true
        setupView.isHidden = true
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        setupView.onConnect = { [weak self] url in self?.connect(to: url) }
        setupView.onCancel = { [weak self] in self?.hideSetup() }
        errorView.onRetry = { [weak self] in self?.reload() }
        errorView.onChangeLink = { [weak self] in self?.showSetup(cancellable: self?.savedLink != nil) }
        if savedLink == nil {
            showSetup(cancellable: false)
        } else {
            reload()
        }
    }

    // MARK: - Loading

    private func reload() {
        guard let link = savedLink else { return showSetup(cancellable: false) }
        errorView.isHidden = true
        loadedURL = link
        webView.load(URLRequest(url: link, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 30))
    }

    private func connect(to url: URL) {
        savedLink = url
        hideSetup()
        reload()
    }

    /// canvasapp://open?url=<percent-encoded https link with ?k=…>
    func handleOpenURL(_ url: URL) {
        guard url.scheme == "canvasapp",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let raw = items.first(where: { $0.name == "url" })?.value,
              let link = LinkValidator.canvasLink(from: raw) else { return }
        connect(to: link)
    }

    // MARK: - Menu commands (AppDelegate.buildMenu)

    func reloadPage() { reload() }

    func showServerLink() { showSetup(cancellable: savedLink != nil) }

    func evaluate(_ source: String) { js(source) }

    func appDidEnterBackground() {
        speech.stopAll()
        synth.stopAll()
        VoiceEngine.shared.stop()
        AudioSession.shared.deactivate()
    }

    private func showSetup(cancellable: Bool) {
        setupView.prepare(current: savedLink, cancellable: cancellable)
        setupView.isHidden = false
        view.bringSubviewToFront(setupView)
    }

    private func hideSetup() {
        setupView.endEditing(true)
        setupView.isHidden = true
    }

    private func showError(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        errorView.show(message: ns.localizedDescription, host: loadedURL?.host ?? "")
        view.bringSubviewToFront(errorView)
    }

    fileprivate func js(_ source: String) {
        webView.evaluateJavaScript(source, completionHandler: nil)
    }

    // MARK: - Messages from the page

    fileprivate func receive(_ message: WKScriptMessage) {
        switch message.name {
        case "canvasSpeech":
            speech.receive(message.body)
        case "canvasSynth":
            synth.receive(message.body)
        case "canvasNative":
            guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
            switch cmd {
            case "settings": showSetup(cancellable: true)
            case "reload": reload()
            case "haptic": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            default: break
            }
        default:
            break
        }
    }
}

// MARK: - WKNavigationDelegate / WKUIDelegate

extension CanvasViewController: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "canvasapp" {
            handleOpenURL(url)
            return decisionHandler(.cancel)
        }
        if scheme != "http" && scheme != "https" {
            return decisionHandler(.allow) // about:, blob:, data:
        }
        if url.host == loadedURL?.host {
            return decisionHandler(.allow)
        }
        UIApplication.shared.open(url) // anything else opens in Safari
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        errorView.isHidden = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        speech.stopAll()
        synth.stopAll()
        reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

// MARK: - Apple Pencil

extension CanvasViewController: UIPencilInteractionDelegate {
    // iOS 17.0–17.4
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        sendPencilTap()
    }

    // iOS 17.5+ (the system calls this instead of pencilInteractionDidTap)
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        sendPencilTap()
    }

    // Apple Pencil Pro squeeze → the page toggles the mic.
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard squeeze.phase == .ended, UIPencilInteraction.preferredSqueezeAction != .ignore else { return }
        js("window.dispatchEvent(new CustomEvent('canvas:pencil-squeeze'))")
    }

    private func sendPencilTap() {
        let action: String
        switch UIPencilInteraction.preferredTapAction {
        case .ignore: return
        case .switchEraser: action = "switchEraser"
        case .switchPrevious: action = "switchPrevious"
        case .showColorPalette: action = "showColorPalette"
        case .showInkAttributes: action = "showInkAttributes"
        default: action = "switchEraser"
        }
        js("window.dispatchEvent(new CustomEvent('canvas:pencil-tap',{detail:{action:'\(action)'}}))")
    }
}

// MARK: - Weak script-message proxy (WKUserContentController retains its handlers)

@MainActor
private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    weak var owner: CanvasViewController?
    init(owner: CanvasViewController) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receive(message)
    }
}

// MARK: - Link validation

enum LinkValidator {
    /// Accepts a pasted canvas link: http(s), a host, and the ?k= key.
    static func canvasLink(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: trimmed),
              let scheme = comps.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = comps.host, !host.isEmpty,
              let key = comps.queryItems?.first(where: { $0.name == "k" })?.value, !key.isEmpty,
              let url = comps.url else { return nil }
        return url
    }
}
