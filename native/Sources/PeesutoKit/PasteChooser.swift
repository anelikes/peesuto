import CoreGraphics
import Foundation

/// One line of the "Paste as…" chooser (⌥V).
public enum PasteChoice: String, CaseIterable, Sendable {
    case image, gif, video, lyric, qr, pin, history

    /// The media shortcut this choice runs, exactly as if its own key had been
    /// pressed; nil for history, which opens the panel.
    public var shortcutID: String? {
        switch self {
        case .image: return "paste-card"
        case .gif: return "paste-gif"
        case .video: return "paste-video"
        case .lyric: return "paste-lyric"
        case .qr: return "paste-qr"
        case .pin: return MediaShortcuts.pinID
        case .history: return nil
        }
    }

    /// The single-key accelerator shown on its keycap.
    public var keyLabel: String {
        switch self {
        case .image: return "I"
        case .gif: return "G"
        case .video: return "M"
        case .lyric: return "L"
        case .qr: return "Q"
        case .pin: return "P"
        case .history: return "H"
        }
    }

    /// Whether this choice renders a card from the copied text.
    public var needsText: Bool { self != .pin && self != .history }
}

/// What the chooser found on the clipboard when it opened.
public enum ChooserClipboard: Equatable, Sendable {
    /// Usable text (not concealed, not from an excluded app).
    case text
    /// An image (or an image file) and no usable text: only pin applies.
    case image
    /// Nothing usable: empty, protected, or neither text nor image.
    case none
}

/// A key press in the chooser.
public enum ChooserKey: Equatable, Sendable {
    /// A letter accelerator: runs its row at once, wherever the highlight is.
    case choose(PasteChoice)
    /// Return or keypad Enter: runs the highlighted row.
    case activate
    /// Moves the highlight.
    case move(ChooserMove)
    case cancel
}

/// A highlight movement in the chooser.
public enum ChooserMove: Equatable, Sendable {
    /// ↑ or ⇧Tab.
    case previous
    /// ↓ or Tab.
    case next
    /// Home or Page Up.
    case first
    /// End or Page Down.
    case last
}

/// The chooser's rules, kept apart from AppKit so they can be tested.
public enum PasteChooser {
    /// Row order: the five outputs (lyric motion after video, the video it makes), then pin and history.
    public static let order: [PasteChoice] = [.image, .gif, .video, .lyric, .qr, .pin, .history]

    /// The key press to act on. Letters are matched by the character the
    /// layout types (ignoring modifiers, so a still-held ⌥ from ⌥V does not
    /// matter), and by the physical ANSI key when that is not a Latin letter
    /// (an input method or a non-Latin layout). Return and keypad Enter pick
    /// the highlighted row, the arrows (by key code, so any input method
    /// works), Tab, Home and End move the highlight, Esc cancels. Anything
    /// else is ignored.
    public static func key(keyCode: UInt16, characters: String?, shift: Bool = false) -> ChooserKey? {
        switch keyCode {
        case 53: return .cancel                          // Escape
        case 36, 76: return .activate                    // Return, keypad Enter
        case 126: return .move(.previous)                // ↑
        case 125: return .move(.next)                    // ↓
        case 48: return .move(shift ? .previous : .next) // Tab, ⇧Tab
        case 115, 116: return .move(.first)              // Home, Page Up
        case 119, 121: return .move(.last)               // End, Page Down
        default: break
        }
        if let character = characters?.lowercased(), character.count == 1,
           let scalar = character.unicodeScalars.first, scalar.isASCII, CharacterSet.letters.contains(scalar) {
            return letter(character)
        }
        let physical: [UInt16: String] = [34: "i", 5: "g", 46: "m", 37: "l", 12: "q", 35: "p", 4: "h"]
        return physical[keyCode].flatMap(letter)
    }

    private static func letter(_ character: String) -> ChooserKey? {
        switch character {
        case "i": return .choose(.image)
        case "g": return .choose(.gif)
        case "m": return .choose(.video)
        case "l": return .choose(.lyric)
        case "q": return .choose(.qr)
        case "p": return .choose(.pin)
        case "h": return .choose(.history)
        default: return nil
        }
    }

    /// Card outputs need text; pin takes text or an image; history always works.
    public static func isEnabled(_ choice: PasteChoice, clipboard: ChooserClipboard) -> Bool {
        switch choice {
        case .history: return true
        case .pin: return clipboard != .none
        default: return clipboard == .text
        }
    }

    /// The row highlighted when the chooser opens: the first enabled one, so
    /// Return means the image whenever there is text.
    public static func initialHighlight(clipboard: ChooserClipboard) -> PasteChoice? {
        order.first { isEnabled($0, clipboard: clipboard) }
    }

    /// The highlight after `move`, skipping disabled rows and stopping at the
    /// ends (like a list, no wrapping). With nothing highlighted it starts
    /// from the first enabled row.
    public static func highlight(after move: ChooserMove, from current: PasteChoice?, clipboard: ChooserClipboard) -> PasteChoice? {
        let enabled = order.filter { isEnabled($0, clipboard: clipboard) }
        guard let first = enabled.first, let last = enabled.last else { return nil }
        guard let current, let index = enabled.firstIndex(of: current) else {
            return move == .last ? last : first
        }
        switch move {
        case .first: return first
        case .last: return last
        case .previous: return enabled[max(index - 1, 0)]
        case .next: return enabled[min(index + 1, enabled.count - 1)]
        }
    }
}

/// Where the chooser appears. All rects are AppKit screen coordinates
/// (origin bottom-left, points).
public enum ChooserPlacement {
    /// Space between the caret (or pointer) and the chooser.
    public static let gap: CGFloat = 8
    /// Distance kept from the edges of the visible screen.
    public static let margin: CGFloat = 8

    public enum Anchor: Equatable, Sendable {
        /// The text caret or selection, from Accessibility.
        case caret(CGRect)
        /// The mouse pointer.
        case pointer(CGPoint)
        /// Nothing better: the upper third of the screen.
        case screen
    }

    /// Converts a rect from Accessibility's global coordinates (origin at the
    /// top-left of the primary screen, y down) to AppKit's.
    public static func appKitRect(fromAccessibility rect: CGRect, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryScreenHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// A caret rect worth trusting: finite, not all zeros (several apps
    /// answer {0,0,0,0} for "unknown"), and not absurdly large.
    public static func isUsableCaret(_ rect: CGRect) -> Bool {
        guard rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite,
              rect.width >= 0, rect.height > 0, rect.height < 400 else { return false }
        return !(rect.origin == .zero && rect.width <= 1)
    }

    /// The chooser's frame for `anchor` on the screen whose visible frame is
    /// `visible`. Below the caret, left-aligned with it; above when there is no
    /// room below. Always kept inside `visible`.
    public static func frame(size: CGSize, anchor: Anchor, visible: CGRect) -> CGRect {
        var origin: CGPoint
        switch anchor {
        case .caret(let caret):
            origin = CGPoint(x: caret.minX - 12, y: caret.minY - gap - size.height)
            if origin.y < visible.minY + margin { origin.y = caret.maxY + gap }
        case .pointer(let point):
            origin = CGPoint(x: point.x - 12, y: point.y - gap * 2 - size.height)
            if origin.y < visible.minY + margin { origin.y = point.y + gap * 2 }
        case .screen:
            origin = CGPoint(x: visible.midX - size.width / 2, y: visible.maxY - visible.height / 3 - size.height / 2)
        }
        origin.x = min(max(origin.x, visible.minX + margin), visible.maxX - margin - size.width)
        origin.y = min(max(origin.y, visible.minY + margin), visible.maxY - margin - size.height)
        return CGRect(origin: CGPoint(x: origin.x.rounded(), y: origin.y.rounded()), size: size)
    }
}
