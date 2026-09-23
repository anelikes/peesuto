import AppKit
import UniformTypeIdentifiers
import PeesutoKit

/// Keeps the pinned images on screen. Pins live only for this run.
@MainActor final class PinManager {
    private(set) var pins: [PinWindow] = []
    private let tr: (String, String) -> String
    private let copy: (PinImage) -> Bool

    init(tr: @escaping (String, String) -> String, copy: @escaping (PinImage) -> Bool) {
        self.tr = tr; self.copy = copy
    }

    /// Shows `image` centred on `center` (default: the mouse). Returns false
    /// when the bytes cannot be decoded.
    @discardableResult
    func pin(_ image: PinImage, center: NSPoint? = nil) -> Bool {
        guard let nsImage = NSImage(data: image.data), let pixels = image.pixelSize else { return false }
        let point = center ?? NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) }) ?? NSScreen.main
        guard let screen else { return false }
        let natural = PinGeometry.naturalSize(pixelWidth: pixels.width, pixelHeight: pixels.height, scale: screen.backingScaleFactor)
        let frame = PinGeometry.initialFrame(natural: natural, center: point, visibleFrame: screen.visibleFrame)
        let window = PinWindow(image: image, nsImage: nsImage, natural: natural, frame: frame, manager: self)
        pins.append(window)
        window.alphaValue = 0
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            window.animator().alphaValue = 1
        }
        return true
    }

    func close(_ window: PinWindow, animated: Bool = true) {
        guard pins.contains(where: { $0 === window }) else { return }
        pins.removeAll { $0 === window }
        guard animated else { window.orderOut(nil); return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.15
            window.animator().alphaValue = 0
        }, completionHandler: { window.orderOut(nil) })
    }

    func closeAll() { for window in pins { close(window) } }

    fileprivate func text(_ en: String, _ zh: String) -> String { tr(en, zh) }
    fileprivate func copyImage(_ image: PinImage) { _ = copy(image) }

    fileprivate func save(_ image: PinImage) {
        let panel = NSSavePanel()
        let gif = image.format == "gif"
        panel.allowedContentTypes = [gif ? .gif : .png]
        panel.nameFieldStringValue = "Peesuto." + (gif ? "gif" : "png")
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try image.data.write(to: url, options: .atomic) }
        catch {
            let alert = NSAlert()
            alert.messageText = tr("Could not save the image.", "无法保存图片。")
            alert.runModal()
        }
    }
}

/// A borderless, non-activating floating window showing one pinned image.
/// It takes mouse events (drag, zoom, double-click, context menu) but never
/// becomes key, so the frontmost app keeps keyboard focus.
@MainActor final class PinWindow: NSPanel {
    let image: PinImage
    let natural: CGSize
    private weak var manager: PinManager?

    init(image: PinImage, nsImage: NSImage, natural: CGSize, frame: NSRect, manager: PinManager) {
        self.image = image
        self.natural = natural
        self.manager = manager
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isReleasedWhenClosed = false
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hasShadow = true
        isOpaque = false
        backgroundColor = .clear
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isMovable = false
        title = "Peesuto Pin"
        contentView = PinContentView(image: nsImage, window: self)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    fileprivate func zoom(by factor: CGFloat) {
        guard factor.isFinite, factor > 0 else { return }
        let screenSize = (screen ?? NSScreen.main)?.visibleFrame.size ?? frame.size
        let next = PinGeometry.zoom(frame: frame, by: factor, anchor: NSEvent.mouseLocation, natural: natural, screen: screenSize)
        guard next != frame else { return }
        setFrame(next, display: true)
        invalidateShadow()
    }

    fileprivate func closePin() { manager?.close(self) }

    fileprivate func contextMenu() -> NSMenu {
        let menu = NSMenu()
        let tr = { (en: String, zh: String) in self.manager?.text(en, zh) ?? en }
        menu.addItem(PinMenuItem(tr("Copy image", "复制图片")) { [weak self] in
            guard let self else { return }; self.manager?.copyImage(self.image)
        })
        menu.addItem(PinMenuItem(tr("Save as…", "另存为…")) { [weak self] in
            guard let self else { return }; self.manager?.save(self.image)
        })
        menu.addItem(.separator())
        menu.addItem(PinMenuItem(tr("Close", "关闭")) { [weak self] in self?.closePin() })
        menu.addItem(PinMenuItem(tr("Close all pins", "关闭全部贴图")) { [weak self] in self?.manager?.closeAll() })
        return menu
    }
}

private final class PinMenuItem: NSMenuItem {
    private let handler: () -> Void
    init(_ title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }
    required init(coder: NSCoder) { fatalError("not used") }
    @objc private func run() { handler() }
}

/// Rounded, clipped image view that handles the pin's mouse interaction.
private final class PinContentView: NSView {
    private let imageView: NSImageView
    private weak var pin: PinWindow?
    private var dragStart: (mouse: NSPoint, origin: NSPoint)?

    init(image: NSImage, window: PinWindow) {
        imageView = NSImageView()
        pin = window
        super.init(frame: NSRect(origin: .zero, size: window.frame.size))
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.masksToBounds = true
        layer?.borderWidth = 0.5
        layer?.borderColor = NSColor.black.withAlphaComponent(0.12).cgColor
        autoresizingMask = [.width, .height]
        imageView.image = image
        imageView.imageScaling = .scaleAxesIndependently
        imageView.animates = true
        imageView.imageFrameStyle = .none
        imageView.isEditable = false
        imageView.frame = bounds
        imageView.autoresizingMask = [.width, .height]
        addSubview(imageView)
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    // Every click lands here, not on the image view.
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 { dragStart = nil; pin?.closePin(); return }
        guard let pin else { return }
        dragStart = (NSEvent.mouseLocation, pin.frame.origin)
    }
    override func mouseDragged(with event: NSEvent) {
        guard let pin, let start = dragStart else { return }
        let mouse = NSEvent.mouseLocation
        pin.setFrameOrigin(NSPoint(x: start.origin.x + mouse.x - start.mouse.x, y: start.origin.y + mouse.y - start.mouse.y))
    }
    override func mouseUp(with event: NSEvent) { dragStart = nil }

    override func scrollWheel(with event: NSEvent) {
        let delta = event.scrollingDeltaY
        guard delta != 0 else { return }
        pin?.zoom(by: PinGeometry.scrollZoomFactor(deltaY: delta, precise: event.hasPreciseScrollingDeltas))
    }
    override func magnify(with event: NSEvent) { pin?.zoom(by: 1 + event.magnification) }

    override func menu(for event: NSEvent) -> NSMenu? { pin?.contextMenu() }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = pin?.contextMenu() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}
