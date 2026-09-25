import CoreGraphics
import Foundation

/// Where a shortcut's feedback appears: a small working indicator right after
/// the text caret, and a one-line bubble for anything worth reading. All rects
/// are AppKit screen coordinates (origin bottom-left, points).
public enum FeedbackPlacement {
    /// Space between the caret and the indicator.
    public static let caretGap: CGFloat = 4
    /// The pointer's arrow covers about this much below-right of its hot spot.
    public static let pointerOffset = CGSize(width: 16, height: 22)
    /// Distance kept from the edges of the visible screen.
    public static let margin: CGFloat = 6

    /// The caret when Accessibility reports a usable one (converted from its
    /// top-left coordinates), otherwise the mouse pointer.
    public static func anchor(caretAccessibility: CGRect?, pointer: CGPoint, primaryScreenHeight: CGFloat) -> ChooserPlacement.Anchor {
        if let caret = caretAccessibility, ChooserPlacement.isUsableCaret(caret) {
            return .caret(ChooserPlacement.appKitRect(fromAccessibility: caret, primaryScreenHeight: primaryScreenHeight))
        }
        return .pointer(pointer)
    }

    /// The point that decides which screen the anchor is on.
    public static func point(of anchor: ChooserPlacement.Anchor) -> CGPoint? {
        switch anchor {
        case .caret(let rect): return CGPoint(x: rect.midX, y: rect.midY)
        case .pointer(let point): return point
        case .screen: return nil
        }
    }

    /// The index of the screen frame that contains `point`, else the first.
    public static func screenIndex(containing point: CGPoint?, frames: [CGRect]) -> Int? {
        guard !frames.isEmpty else { return nil }
        guard let point else { return 0 }
        return frames.firstIndex { $0.contains(point) } ?? 0
    }

    /// The indicator sits just after the caret, centred on its line; next to
    /// the pointer, below-right of the arrow, when there is no caret.
    public static func indicatorFrame(size: CGSize, anchor: ChooserPlacement.Anchor, visible: CGRect) -> CGRect {
        var origin: CGPoint
        switch anchor {
        case .caret(let caret):
            origin = CGPoint(x: caret.maxX + caretGap, y: caret.midY - size.height / 2)
        case .pointer(let point):
            origin = CGPoint(x: point.x + pointerOffset.width - size.width / 2, y: point.y - pointerOffset.height - size.height / 2)
        case .screen:
            origin = CGPoint(x: visible.midX - size.width / 2, y: visible.maxY - visible.height / 3 - size.height / 2)
        }
        return clamp(CGRect(origin: origin, size: size), in: visible)
    }

    /// The bubble goes under the caret line, starting at the caret; above it
    /// when there is no room below. Next to the pointer when there is no caret.
    public static func bubbleFrame(size: CGSize, anchor: ChooserPlacement.Anchor, visible: CGRect) -> CGRect {
        var origin: CGPoint
        switch anchor {
        case .caret(let caret):
            origin = CGPoint(x: caret.minX - 10, y: caret.minY - caretGap * 2 - size.height)
            if origin.y < visible.minY + margin { origin.y = caret.maxY + caretGap * 2 }
        case .pointer(let point):
            origin = CGPoint(x: point.x + pointerOffset.width / 2, y: point.y - pointerOffset.height - size.height)
            if origin.y < visible.minY + margin { origin.y = point.y + caretGap * 2 }
        case .screen:
            origin = CGPoint(x: visible.midX - size.width / 2, y: visible.maxY - visible.height / 3 - size.height / 2)
        }
        return clamp(CGRect(origin: origin, size: size), in: visible)
    }

    static func clamp(_ frame: CGRect, in visible: CGRect) -> CGRect {
        let x = min(max(frame.minX, visible.minX + margin), visible.maxX - margin - frame.width)
        let y = min(max(frame.minY, visible.minY + margin), visible.maxY - margin - frame.height)
        return CGRect(origin: CGPoint(x: x.rounded(), y: y.rounded()), size: frame.size)
    }
}

public enum FeedbackTiming {
    /// How long the completion flash lasts before the indicator is gone.
    public static let flash: TimeInterval = 0.25
    public static let shortestBubble: TimeInterval = 2.5
    public static let longestBubble: TimeInterval = 8

    /// A bubble stays long enough to read: a base plus a little per character,
    /// CJK characters counting double (they carry about a word each).
    public static func bubbleDuration(for text: String) -> TimeInterval {
        let weight = text.unicodeScalars.reduce(0) { total, scalar in
            total + ((0x2E80...0x9FFF).contains(scalar.value) || (0xAC00...0xD7AF).contains(scalar.value) || (0xFF00...0xFFEF).contains(scalar.value) ? 2 : 1)
        }
        return min(max(1.5 + Double(weight) * 0.045, shortestBubble), longestBubble)
    }
}

public enum FeedbackKeys {
    /// Esc on its own (Shift allowed) cancels the running shortcut; with ⌘, ⌥
    /// or ⌃ it belongs to the app the user is in.
    public static func cancels(keyCode: UInt16, command: Bool, option: Bool, control: Bool) -> Bool {
        keyCode == 53 && !command && !option && !control
    }
}
