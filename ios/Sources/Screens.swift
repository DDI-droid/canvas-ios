import UIKit

extension UIColor {
    static let canvasAccent = UIColor(red: 0xD2 / 255, green: 0x69 / 255, blue: 0x3F / 255, alpha: 1)
}

@MainActor
private func makeCard() -> UIView {
    let card = UIView()
    card.backgroundColor = .secondarySystemGroupedBackground
    card.layer.cornerRadius = 26
    card.layer.cornerCurve = .continuous
    card.layer.shadowColor = UIColor.black.cgColor
    card.layer.shadowOpacity = 0.10
    card.layer.shadowRadius = 30
    card.layer.shadowOffset = CGSize(width: 0, height: 12)
    card.translatesAutoresizingMaskIntoConstraints = false
    return card
}

@MainActor
private func makeLabel(_ text: String, size: CGFloat, weight: UIFont.Weight, color: UIColor) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = .systemFont(ofSize: size, weight: weight)
    label.textColor = color
    label.numberOfLines = 0
    return label
}

@MainActor
private func makeButton(_ title: String, style: UIButton.Configuration) -> UIButton {
    var config = style
    config.title = title
    config.cornerStyle = .large
    config.buttonSize = .large
    let button = UIButton(configuration: config)
    button.tintColor = .canvasAccent
    return button
}

@MainActor
private func place(_ card: UIView, in view: UIView) {
    view.addSubview(card)
    NSLayoutConstraint.activate([
        card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        card.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -40),
        card.widthAnchor.constraint(lessThanOrEqualToConstant: 540),
        card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
        card.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
    ])
    let preferred = card.widthAnchor.constraint(equalToConstant: 540)
    preferred.priority = .defaultHigh
    preferred.isActive = true
}

@MainActor
private func fill(_ card: UIView, with stack: UIStackView) {
    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(stack)
    NSLayoutConstraint.activate([
        stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 32),
        stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -32),
        stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 32),
        stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -28),
    ])
}

/// First-run / "Server link…" screen: paste the canvas link.
final class SetupView: UIView, UITextFieldDelegate {
    var onConnect: ((URL) -> Void)?
    var onCancel: (() -> Void)?

    private let field = UITextField()
    private let problem: UILabel
    private let cancelButton: UIButton

    override init(frame: CGRect) {
        problem = makeLabel("", size: 14, weight: .medium, color: .systemRed)
        cancelButton = makeButton("Cancel", style: .plain())
        super.init(frame: frame)
        backgroundColor = UIColor(named: "LaunchBackground") ?? .systemBackground

        let card = makeCard()
        place(card, in: self)

        let title = makeLabel("Connect your canvas", size: 28, weight: .bold, color: .label)
        let body = makeLabel(
            "Paste the canvas link Claude sent you. It ends in ?k=…\n\nOr open that link in Safari and choose ☰ → Open in Canvas app.",
            size: 16, weight: .regular, color: .secondaryLabel)

        field.placeholder = "https://….trycloudflare.com/?k=…"
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .go
        field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        field.backgroundColor = .tertiarySystemFill
        field.layer.cornerRadius = 12
        field.layer.cornerCurve = .continuous
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.delegate = self
        field.heightAnchor.constraint(equalToConstant: 50).isActive = true

        problem.isHidden = true

        let paste = makeButton("Paste", style: .gray())
        let connect = makeButton("Connect", style: .filled())
        paste.addAction(UIAction { [weak self] _ in self?.pasteLink() }, for: .touchUpInside)
        connect.addAction(UIAction { [weak self] _ in self?.submit() }, for: .touchUpInside)
        cancelButton.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [cancelButton, UIView(), paste, connect])
        buttons.axis = .horizontal
        buttons.spacing = 10

        let stack = UIStackView(arrangedSubviews: [title, body, field, problem, buttons])
        stack.setCustomSpacing(22, after: body)
        stack.setCustomSpacing(20, after: problem)
        fill(card, with: stack)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func prepare(current: URL?, cancellable: Bool) {
        field.text = current?.absoluteString
        cancelButton.isHidden = !cancellable
        problem.isHidden = true
    }

    private func pasteLink() {
        guard let text = UIPasteboard.general.string else { return }
        field.text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        submit()
    }

    private func submit() {
        guard let url = LinkValidator.canvasLink(from: field.text ?? "") else {
            problem.text = "That doesn’t look like a canvas link. It should start with https:// and contain ?k=."
            problem.isHidden = false
            return
        }
        problem.isHidden = true
        endEditing(true)
        onConnect?(url)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        submit()
        return false
    }
}

/// Shown when the page can't load (server off, or the tunnel link changed).
final class ErrorView: UIView {
    var onRetry: (() -> Void)?
    var onChangeLink: (() -> Void)?

    private let detail: UILabel

    override init(frame: CGRect) {
        detail = makeLabel("", size: 16, weight: .regular, color: .secondaryLabel)
        super.init(frame: frame)
        backgroundColor = UIColor(named: "LaunchBackground") ?? .systemBackground

        let card = makeCard()
        place(card, in: self)

        let title = makeLabel("Can’t reach the canvas", size: 28, weight: .bold, color: .label)
        let retry = makeButton("Try again", style: .filled())
        let change = makeButton("Change link", style: .gray())
        retry.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)
        change.addAction(UIAction { [weak self] _ in self?.onChangeLink?() }, for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [UIView(), change, retry])
        buttons.axis = .horizontal
        buttons.spacing = 10

        let stack = UIStackView(arrangedSubviews: [title, detail, buttons])
        stack.setCustomSpacing(24, after: detail)
        fill(card, with: stack)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(message: String, host: String) {
        detail.text = """
        \(message)

        Is the canvas server running on your PC? If Claude restarted the tunnel, the link has changed: \
        open the new link in Safari and choose ☰ → Open in Canvas app.
        """
        isHidden = false
    }
}
