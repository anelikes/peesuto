import AppKit
import SwiftUI
import PeesutoKit

/// The "Paste as…" chooser (⌥V): a small HUD over the app the user is typing
/// in. It is a non-activating panel, so that app stays active and the final
/// ⌘V lands where the caret was; it still becomes key to read its own keys.
final class ChooserPanel: NSPanel {
    /// Returns true when the key press was handled.
    var onKey: ((NSEvent) -> Bool)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, onKey?(event) == true { return }
        super.sendEvent(event)
    }
}

/// What the chooser shows. Everything but `thumbnail`/`rendering` is fixed
/// when it opens.
@MainActor final class ChooserState: ObservableObject {
    let clipboard: ChooserClipboard
    /// The start of the copied text, shown until the card is ready.
    let excerpt: String?
    @Published var thumbnail: NSImage?
    @Published var rendering = false
    @Published var hovered: PasteChoice?

    init(clipboard: ChooserClipboard, excerpt: String?, thumbnail: NSImage?) {
        self.clipboard = clipboard; self.excerpt = excerpt; self.thumbnail = thumbnail
    }
}

@MainActor final class ChooserController: NSObject, NSWindowDelegate {
    private let model: AppState
    private let openHistory: () -> Void
    private var panel: ChooserPanel?
    private var state: ChooserState?
    private var snapshot: ChooserSnapshot?
    private var prepared: PreparedRender?
    private var mouseMonitor: Any?

    init(model: AppState, openHistory: @escaping () -> Void) {
        self.model = model; self.openHistory = openHistory
    }

    var isOpen: Bool { panel?.isVisible == true }

    /// Opens over the frontmost app. `sample` (preview builds) stands in for
    /// the clipboard and places the HUD in the upper third of the screen.
    func show(sample: ChooserSnapshot? = nil) {
        close()
        // Where to appear is read before anything of ours takes the keyboard.
        let anchor: ChooserPlacement.Anchor
        if sample == nil, let caret = ContextCapture.caretBounds(), let primary = NSScreen.screens.first {
            anchor = .caret(ChooserPlacement.appKitRect(fromAccessibility: caret, primaryScreenHeight: primary.frame.height))
        } else if sample == nil {
            anchor = .pointer(NSEvent.mouseLocation)
        } else {
            anchor = .screen
        }
        let snapshot = sample ?? model.chooserSnapshot()
        self.snapshot = snapshot
        model.trusted = PasteController.accessibilityTrusted
        let excerpt = snapshot.text.map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(280)) }
        let imageThumbnail = snapshot.clipboard == .image ? snapshot.image.flatMap { NSImage(data: $0.data) } : nil
        let state = ChooserState(clipboard: snapshot.clipboard, excerpt: excerpt, thumbnail: imageThumbnail)
        self.state = state
        if let text = snapshot.text, let render = model.startCardPreview(text: text) {
            prepared = render
            state.rendering = true
            Task { [weak state] in
                let response = try? await render.task.value
                guard let state else { return }
                state.rendering = false
                if let path = response?.result.path, let image = NSImage(contentsOfFile: path) { state.thumbnail = image }
            }
        }

        let panel = ChooserPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .utilityWindow
        panel.title = model.tr("Paste as", "粘贴为")
        panel.delegate = self
        panel.onKey = { [weak self] event in self?.handle(event) ?? false }
        let hosting = NSHostingView(rootView: ChooserView(model: model, state: state, choose: { [weak self] in self?.choose($0) }))
        if #available(macOS 13.3, *) { hosting.safeAreaRegions = [] }
        let size = hosting.fittingSize
        panel.contentView = PanelBackground.wrap(hosting)
        let point: NSPoint
        switch anchor {
        case .caret(let rect): point = NSPoint(x: rect.midX, y: rect.midY)
        case .pointer(let location): point = location
        case .screen: point = NSEvent.mouseLocation
        }
        let screen = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        panel.setFrame(ChooserPlacement.frame(size: size, anchor: anchor, visible: visible), display: false)
        self.panel = panel
        panel.makeKeyAndOrderFront(nil)
        // A click anywhere else (another app, the desktop) dismisses it.
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        mouseMonitor = nil
        guard let panel else { return }
        self.panel = nil
        panel.delegate = nil
        panel.onKey = nil
        panel.orderOut(nil)
        state = nil
    }

    private func handle(_ event: NSEvent) -> Bool {
        guard !event.isARepeat else { return true }
        switch PasteChooser.key(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers) {
        case .cancel?: close()
        case .choose(let choice)?: choose(choice)
        case nil: break
        }
        return true
    }

    private func choose(_ choice: PasteChoice) {
        guard let snapshot, PasteChooser.isEnabled(choice, clipboard: snapshot.clipboard) else { NSSound.beep(); return }
        let prepared = self.prepared
        self.prepared = nil
        // Close first: the target app keeps the keyboard, so ⌘V lands in it.
        close()
        guard let id = choice.shortcutID else { openHistory(); return }
        model.runClipboardAction(id, prepared: prepared)
    }

    func windowDidResignKey(_ notification: Notification) {
        guard (notification.object as? NSWindow) === panel else { return }
        close()
    }
}

struct ChooserView: View {
    @ObservedObject var model: AppState
    @ObservedObject var state: ChooserState
    let choose: (PasteChoice) -> Void

    static let width: CGFloat = 292

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.tr("Paste as…", "粘贴为…")).font(.system(size: 13, weight: .semibold))
                Spacer()
                HStack(spacing: 5) {
                    Text(model.tr("Cancel", "取消")).font(.system(size: 11)).foregroundColor(.secondary)
                    Keycap(label: "esc")
                }
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            preview.padding(.horizontal, 12)
            VStack(spacing: 1) {
                ForEach(PasteChooser.order, id: \.self) { choice in
                    if choice == .pin { Divider().padding(.vertical, 4).padding(.horizontal, 6) }
                    row(choice)
                }
            }
            .padding(.horizontal, 6).padding(.top, 8).padding(.bottom, 6)
            if let note {
                Text(note)
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.bottom, 12)
            }
        }
        .frame(width: Self.width)
    }

    private var preview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.045))
            if let image = state.thumbnail {
                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .padding(8)
            } else if let excerpt = state.excerpt {
                Text(excerpt)
                    .font(.system(size: 12)).foregroundColor(.secondary)
                    .lineLimit(6).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(12)
            } else {
                Image(systemName: "doc.on.clipboard").font(.system(size: 22)).foregroundColor(.secondary)
            }
            if state.rendering {
                ProgressView().controlSize(.small)
                    .padding(8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
        .frame(height: 148)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.rendering ? model.tr("Preparing the card", "正在准备卡片") : state.excerpt ?? "")
    }

    private func row(_ choice: PasteChoice) -> some View {
        let enabled = PasteChooser.isEnabled(choice, clipboard: state.clipboard)
        // Return picks the image, so it reads as the default until the pointer is on another row.
        let highlighted = enabled && (state.hovered.map { $0 == choice } ?? (choice == .image))
        return Button { choose(choice) } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol(choice)).font(.system(size: 13))
                    .foregroundColor(.secondary).frame(width: 18)
                Text(title(choice)).font(.system(size: 13))
                Spacer()
                Keycap(label: choice.keyLabel)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(highlighted ? Color.accentColor.opacity(0.14) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .onHover { inside in
            if inside { state.hovered = choice } else if state.hovered == choice { state.hovered = nil }
        }
        .accessibilityLabel(title(choice))
        .accessibilityHint(choice.keyLabel)
    }

    private var note: String? {
        switch state.clipboard {
        case .image: return model.tr("An image is on the clipboard: pin it, or copy text to make a card.", "剪贴板里是图片：可以贴到屏幕；复制文字才能生成卡片。")
        case .none: return model.tr("Copy some text first. Protected clipboard content is not used.", "请先复制文字。受保护的剪贴板内容不会使用。")
        case .text: return model.trusted ? nil
            : model.tr("Accessibility is off, so the result is copied; press ⌘V to paste it.", "未开启辅助功能，结果只会复制，请自己按 ⌘V 粘贴。")
                + "\n" + model.accessibilityResetHint
        }
    }

    private func symbol(_ choice: PasteChoice) -> String {
        switch choice {
        case .image: return "photo"
        case .gif: return "square.stack.3d.forward.dottedline"
        case .video: return "film"
        case .lyric: return "textformat.size"
        case .qr: return "qrcode"
        case .pin: return "pin"
        case .history: return "clock.arrow.circlepath"
        }
    }

    private func title(_ choice: PasteChoice) -> String {
        switch choice {
        case .image: return model.tr("Image", "图片")
        case .gif: return "GIF"
        case .video: return model.tr("Video", "视频")
        case .lyric: return model.tr("Lyric motion", "文字 PV")
        case .qr: return model.tr("QR code", "二维码")
        case .pin: return model.tr("Pin to screen", "贴到屏幕")
        case .history: return model.tr("Clipboard history", "剪贴板历史")
        }
    }
}
