import AppKit
import SwiftUI
import PeesutoKit

/// Feedback for shortcuts that paste where the user is typing: a small dot
/// right after the text caret while the result is being made (Esc cancels),
/// and a one-line bubble for anything worth reading. Neither takes focus nor
/// clicks; both fade out by themselves. Placement is `FeedbackPlacement`.
@MainActor final class CaretFeedback {
    private let onCancel: () -> Void
    private var indicator: NSPanel?
    private var dot: WorkingDotView?
    private var bubble: NSPanel?
    private var bubbleGeneration = 0
    private var keyMonitors: [Any] = []

    init(onCancel: @escaping () -> Void) { self.onCancel = onCancel }

    /// The caret of the frontmost app when Accessibility reports one, else the
    /// pointer. Reads positions only, never text; nil in secure fields.
    static func currentAnchor() -> ChooserPlacement.Anchor {
        FeedbackPlacement.anchor(caretAccessibility: ContextCapture.caretBounds(), pointer: NSEvent.mouseLocation,
                                 primaryScreenHeight: NSScreen.screens.first?.frame.height ?? 0)
    }

    private static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    // MARK: Working indicator

    /// Shows the working dot at `anchor` and listens for Esc until `finish`.
    func begin(at anchor: ChooserPlacement.Anchor) {
        hideBubble()
        removeIndicator()
        let size = CGSize(width: WorkingDotView.side, height: WorkingDotView.side)
        let panel = Self.overlayPanel(frame: Self.frame(for: anchor, size: size, bubble: false))
        let view = WorkingDotView(frame: NSRect(origin: .zero, size: size), animated: !Self.reduceMotion)
        panel.contentView = view
        indicator = panel
        dot = view
        Self.fadeIn(panel)
        startListening()
    }

    /// Ends the working state: a brief flash when the result landed, then gone.
    func finish(flash: Bool) {
        stopListening()
        guard let panel = indicator, let dot else { return }
        indicator = nil
        self.dot = nil
        if flash { dot.flash(reduceMotion: Self.reduceMotion) }
        Self.fadeOut(panel, duration: flash ? FeedbackTiming.flash : 0.18)
    }

    var isWorking: Bool { indicator != nil }

    // MARK: Bubble

    /// A one-line bubble at the caret (or the pointer), which fades out after
    /// a time that depends on its length. A working dot stays until `finish`.
    func show(_ text: String, isError: Bool, at anchor: ChooserPlacement.Anchor? = nil) {
        hideBubble()
        let view = FeedbackBubble.make(text: text, isError: isError)
        let panel = Self.overlayPanel(frame: Self.frame(for: anchor ?? Self.currentAnchor(), size: view.frame.size, bubble: true))
        panel.hasShadow = true
        panel.contentView = view
        bubble = panel
        bubbleGeneration += 1
        let generation = bubbleGeneration
        Self.fadeIn(panel)
        DispatchQueue.main.asyncAfter(deadline: .now() + FeedbackTiming.bubbleDuration(for: text)) { [weak self] in
            guard let self, self.bubbleGeneration == generation else { return }
            self.hideBubble()
        }
    }

    func hideAll() {
        finish(flash: false)
        hideBubble()
    }

    private func hideBubble() {
        guard let panel = bubble else { return }
        bubble = nil
        Self.fadeOut(panel, duration: 0.25)
    }

    private func removeIndicator() {
        stopListening()
        indicator?.orderOut(nil)
        indicator = nil
        dot = nil
    }

    // MARK: Esc

    /// Esc cancels while the dot is shown. The global monitor only observes
    /// (it cannot swallow or change keys, so the app in front still gets Esc);
    /// the local one passes every event on unchanged, and leaves Esc to our
    /// own key window (the history panel cancels on Esc itself).
    private func startListening() {
        stopListening()
        let handle: (NSEvent) -> Void = { [weak self] event in
            let flags = event.modifierFlags
            guard FeedbackKeys.cancels(keyCode: event.keyCode, command: flags.contains(.command),
                                       option: flags.contains(.option), control: flags.contains(.control)) else { return }
            self?.onCancel()
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { event in
            MainActor.assumeIsolated { handle(event) }
        }) { keyMonitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { event in
            MainActor.assumeIsolated { if NSApp.keyWindow == nil { handle(event) } }
            return event
        }) { keyMonitors.append(local) }
    }

    private func stopListening() {
        for monitor in keyMonitors { NSEvent.removeMonitor(monitor) }
        keyMonitors = []
    }

    // MARK: Windows

    private static func frame(for anchor: ChooserPlacement.Anchor, size: CGSize, bubble: Bool) -> CGRect {
        let screens = NSScreen.screens
        let index = FeedbackPlacement.screenIndex(containing: FeedbackPlacement.point(of: anchor), frames: screens.map(\.frame))
        let visible = index.map { screens[$0].visibleFrame } ?? NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return bubble ? FeedbackPlacement.bubbleFrame(size: size, anchor: anchor, visible: visible)
                      : FeedbackPlacement.indicatorFrame(size: size, anchor: anchor, visible: visible)
    }

    /// Borderless, transparent, never key, click-through, on every Space and
    /// over full-screen apps.
    private static func overlayPanel(frame: CGRect) -> NSPanel {
        let panel = OverlayPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle, .transient]
        panel.setAccessibilityElement(false)
        return panel
    }

    private static func fadeIn(_ panel: NSPanel) {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            panel.animator().alphaValue = 1
        }
    }

    private static func fadeOut(_ panel: NSPanel, duration: TimeInterval) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
    }
}

private final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// An accent-coloured dot that breathes, ringed in the window background
/// colour so it reads on light and dark content alike. Static when Reduce
/// Motion is on.
final class WorkingDotView: NSView {
    static let side: CGFloat = 22
    private static let diameter: CGFloat = 8
    private let halo = CAShapeLayer()
    private let dot = CAShapeLayer()
    private let animated: Bool

    init(frame: NSRect, animated: Bool) {
        self.animated = animated
        super.init(frame: frame)
        wantsLayer = true
        let center = CGPoint(x: frame.width / 2, y: frame.height / 2)
        for (layer, diameter) in [(halo, frame.width - 4), (dot, Self.diameter)] {
            layer.bounds = CGRect(x: 0, y: 0, width: diameter, height: diameter)
            layer.position = center
            layer.path = CGPath(ellipseIn: layer.bounds, transform: nil)
            self.layer?.addSublayer(layer)
        }
        dot.lineWidth = 1.5
        dot.shadowOpacity = 0.25
        dot.shadowRadius = 1.5
        dot.shadowOffset = .zero
        updateColors()
        if animated { breathe() } else { halo.opacity = 0.35 }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    private func updateColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let accent = NSColor.controlAccentColor
            dot.fillColor = accent.cgColor
            dot.strokeColor = NSColor.windowBackgroundColor.withAlphaComponent(0.9).cgColor
            halo.fillColor = accent.withAlphaComponent(0.28).cgColor
        }
    }

    private func breathe() {
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.45; scale.toValue = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.15; fade.toValue = 0.7
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.9
        group.autoreverses = true
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        halo.add(group, forKey: "breathe")
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 0.7; pulse.toValue = 1
        pulse.duration = 0.9
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        dot.add(pulse, forKey: "breathe")
    }

    /// Done: the halo swells once while the window fades (a plain fade with
    /// Reduce Motion).
    func flash(reduceMotion: Bool) {
        halo.removeAllAnimations()
        dot.removeAllAnimations()
        guard !reduceMotion else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.6; scale.toValue = 1.25
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9; fade.toValue = 0.2
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = FeedbackTiming.flash
        group.fillMode = .forwards
        group.isRemovedOnCompletion = false
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        halo.add(group, forKey: "flash")
    }
}

/// A small one- or few-line bubble: the panel's glass, 12 pt text, an orange
/// mark for errors.
enum FeedbackBubble {
    static let maxTextWidth: CGFloat = 320
    static let font = NSFont.systemFont(ofSize: 12, weight: .medium)

    static func make(text: String, isError: Bool) -> NSView {
        let single = ceil((text as NSString).size(withAttributes: [.font: font]).width) + 1
        let width = min(single, maxTextWidth)
        let hosting = NSHostingView(rootView: BubbleContent(text: text, isError: isError, textWidth: width))
        if #available(macOS 13.3, *) { hosting.safeAreaRegions = [] }
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: size)
        let background = NSVisualEffectView(frame: hosting.frame)
        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = min(size.height / 2, 12)
        background.layer?.masksToBounds = true
        hosting.autoresizingMask = [.width, .height]
        background.addSubview(hosting)
        return background
    }

    private struct BubbleContent: View {
        let text: String
        let isError: Bool
        let textWidth: CGFloat
        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if isError {
                    Image(systemName: "exclamationmark.circle.fill").foregroundColor(.orange).font(.system(size: 11, weight: .semibold))
                }
                Text(text)
                    .font(Font(FeedbackBubble.font))
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: textWidth, alignment: .leading)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
        }
    }
}
