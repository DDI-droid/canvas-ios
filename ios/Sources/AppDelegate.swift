import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }

    // MARK: - Menu bar (iPadOS 26 shows it when you swipe down from the top)

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .main else { return }
        builder.remove(menu: .format)
        let canvas = UIMenu(title: "Canvas", identifier: UIMenu.Identifier("com.canvasboard.canvas.menu"), children: [
            UIKeyCommand(title: "Reload", action: #selector(menuReload), input: "r", modifierFlags: .command),
            UIKeyCommand(title: "Sessions…", action: #selector(menuSessions), input: "k", modifierFlags: .command),
            UIKeyCommand(title: "Voice Mode", action: #selector(menuVoice), input: "v", modifierFlags: [.command, .shift]),
            UICommand(title: "Server Link…", action: #selector(menuServerLink)),
            UIMenu(title: "", options: .displayInline, children: [
                UICommand(title: "Close Canvas", action: #selector(menuClose)),
            ]),
        ])
        builder.insertSibling(canvas, afterMenu: .application)
    }

    // The responder chain always ends here, so the commands work whatever has focus.
    private var canvas: CanvasViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return ((scene as? UIWindowScene)?.delegate as? SceneDelegate)?.canvasController
    }

    @objc func menuReload() { canvas?.reloadPage() }
    @objc func menuSessions() { canvas?.evaluate("document.querySelector('#btnSession')&&document.querySelector('#btnSession').click()") }
    @objc func menuVoice() { canvas?.evaluate("window.dispatchEvent(new CustomEvent('canvas:pencil-squeeze'))") }
    @objc func menuServerLink() { canvas?.showServerLink() }

    /// Close the app's window; the next launch loads a fresh page.
    @objc func menuClose() {
        canvas?.appDidEnterBackground()
        guard let session = UIApplication.shared.openSessions.first else { exit(0) }
        UIApplication.shared.requestSceneSessionDestruction(session, options: nil) { _ in
            exit(0) // single-window apps may not support closing the scene: just quit
        }
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private let canvas = CanvasViewController()
    var canvasController: CanvasViewController { canvas }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = canvas
        window.makeKeyAndVisible()
        self.window = window
        if let url = connectionOptions.urlContexts.first?.url {
            canvas.handleOpenURL(url)
        }
    }

    // canvasapp://open?url=<percent-encoded canvas link>
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url {
            canvas.handleOpenURL(url)
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        canvas.appDidEnterBackground()
    }
}
