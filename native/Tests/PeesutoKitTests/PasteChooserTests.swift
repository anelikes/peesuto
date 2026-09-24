import XCTest
@testable import PeesutoKit

final class PasteChooserTests: XCTestCase {
    func testAcceleratorsMapToChoices() {
        XCTAssertEqual(PasteChooser.key(keyCode: 36, characters: "\r"), .activate)
        XCTAssertEqual(PasteChooser.key(keyCode: 76, characters: "\u{3}"), .activate, "keypad Enter")
        XCTAssertEqual(PasteChooser.key(keyCode: 5, characters: "g"), .choose(.gif))
        XCTAssertEqual(PasteChooser.key(keyCode: 46, characters: "m"), .choose(.video))
        XCTAssertEqual(PasteChooser.key(keyCode: 12, characters: "Q"), .choose(.qr), "shift does not matter")
        XCTAssertEqual(PasteChooser.key(keyCode: 37, characters: "l"), .choose(.lyric))
        XCTAssertEqual(PasteChooser.key(keyCode: 37, characters: "L"), .choose(.lyric))
        XCTAssertEqual(PasteChooser.key(keyCode: 35, characters: "p"), .choose(.pin))
        XCTAssertEqual(PasteChooser.key(keyCode: 4, characters: "h"), .choose(.history))
        XCTAssertEqual(PasteChooser.key(keyCode: 53, characters: "\u{1b}"), .cancel)
        XCTAssertNil(PasteChooser.key(keyCode: 0, characters: "a"))
        XCTAssertNil(PasteChooser.key(keyCode: 49, characters: " "))
    }

    func testLayoutCharacterWinsOverThePhysicalKey() {
        // Dvorak: the key typing "g" is ANSI "I" (34); ANSI "G" (5) types "i".
        XCTAssertEqual(PasteChooser.key(keyCode: 34, characters: "g"), .choose(.gif))
        XCTAssertNil(PasteChooser.key(keyCode: 5, characters: "i"))
        // A non-Latin layout falls back to the physical key.
        XCTAssertEqual(PasteChooser.key(keyCode: 5, characters: "п"), .choose(.gif))
        XCTAssertEqual(PasteChooser.key(keyCode: 35, characters: nil), .choose(.pin))
        XCTAssertEqual(PasteChooser.key(keyCode: 37, characters: "д"), .choose(.lyric))
    }

    func testNavigationKeysMoveTheHighlight() {
        // Arrows by key code, whatever the input method types for them.
        XCTAssertEqual(PasteChooser.key(keyCode: 126, characters: "\u{F700}"), .move(.previous))
        XCTAssertEqual(PasteChooser.key(keyCode: 125, characters: "\u{F701}"), .move(.next))
        XCTAssertEqual(PasteChooser.key(keyCode: 125, characters: nil), .move(.next))
        XCTAssertEqual(PasteChooser.key(keyCode: 48, characters: "\t"), .move(.next))
        XCTAssertEqual(PasteChooser.key(keyCode: 48, characters: "\t", shift: true), .move(.previous))
        XCTAssertEqual(PasteChooser.key(keyCode: 115, characters: nil), .move(.first))
        XCTAssertEqual(PasteChooser.key(keyCode: 119, characters: nil), .move(.last))
    }

    func testHighlightStartsOnTheFirstEnabledRow() {
        XCTAssertEqual(PasteChooser.initialHighlight(clipboard: .text), .image, "Return still means the image")
        XCTAssertEqual(PasteChooser.initialHighlight(clipboard: .image), .pin, "only pin and history apply to an image")
        XCTAssertEqual(PasteChooser.initialHighlight(clipboard: .none), .history)
    }

    func testHighlightMovesOverEnabledRowsAndStopsAtTheEnds() {
        func step(_ move: ChooserMove, _ from: PasteChoice?, _ clipboard: ChooserClipboard = .text) -> PasteChoice? {
            PasteChooser.highlight(after: move, from: from, clipboard: clipboard)
        }
        // Down walks the rows in order.
        var walked: [PasteChoice] = [.image]
        while let next = step(.next, walked.last), next != walked.last { walked.append(next) }
        XCTAssertEqual(walked, PasteChooser.order)
        // Clamped, no wrap.
        XCTAssertEqual(step(.next, .history), .history)
        XCTAssertEqual(step(.previous, .image), .image)
        XCTAssertEqual(step(.previous, .gif), .image)
        XCTAssertEqual(step(.first, .qr), .image)
        XCTAssertEqual(step(.last, .gif), .history)
        // Disabled rows are skipped: an image on the clipboard leaves pin and history.
        XCTAssertEqual(step(.next, .pin, .image), .history)
        XCTAssertEqual(step(.next, .history, .image), .history)
        XCTAssertEqual(step(.previous, .history, .image), .pin)
        XCTAssertEqual(step(.previous, .pin, .image), .pin)
        // A highlight on a row that is not enabled (or none) restarts from the enabled rows.
        XCTAssertEqual(step(.next, .image, .image), .pin)
        XCTAssertEqual(step(.next, nil, .image), .pin)
        XCTAssertEqual(step(.last, nil, .image), .history)
        // Only history.
        XCTAssertEqual(step(.previous, .history, .none), .history)
        XCTAssertEqual(step(.next, .history, .none), .history)
    }

    func testChoicesRunTheMediaShortcuts() {
        XCTAssertEqual(PasteChooser.order.map(\.shortcutID), ["paste-card", "paste-gif", "paste-video", "paste-lyric", "paste-qr", "pin-screen", nil])
        XCTAssertEqual(PasteChooser.order.map(\.keyLabel), ["↩", "G", "M", "L", "Q", "P", "H"])
        // Every chooser output is a media shortcut Settings can bind.
        for choice in PasteChooser.order { if let id = choice.shortcutID { XCTAssertTrue(MediaShortcuts.actionIDs.contains(id), id) } }
        XCTAssertEqual(ClipboardShortcutDelivery.of(shortcut: PasteChoice.pin.shortcutID!), .pin)
        XCTAssertEqual(ClipboardShortcutDelivery.renderAction(shortcut: PasteChoice.pin.shortcutID!), PasteChoice.image.shortcutID)
    }

    func testEnabledChoicesFollowTheClipboard() {
        for choice in PasteChooser.order { XCTAssertTrue(PasteChooser.isEnabled(choice, clipboard: .text), "\(choice)") }
        XCTAssertEqual(PasteChooser.order.filter { PasteChooser.isEnabled($0, clipboard: .image) }, [.pin, .history])
        XCTAssertFalse(PasteChooser.isEnabled(.lyric, clipboard: .image), "lyric motion needs text")
        XCTAssertEqual(PasteChooser.order.filter { PasteChooser.isEnabled($0, clipboard: .none) }, [.history])
    }

    func testPlacementBelowTheCaretAndInsideTheScreen() {
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let size = CGSize(width: 300, height: 380)
        let caret = CGRect(x: 400, y: 600, width: 0, height: 18)
        let below = ChooserPlacement.frame(size: size, anchor: .caret(caret), visible: visible)
        XCTAssertEqual(below.maxY, caret.minY - ChooserPlacement.gap)
        XCTAssertEqual(below.minX, 388)
        // No room below: above the caret.
        let low = CGRect(x: 400, y: 120, width: 0, height: 18)
        XCTAssertEqual(ChooserPlacement.frame(size: size, anchor: .caret(low), visible: visible).minY, low.maxY + ChooserPlacement.gap)
        // Near the right edge: pulled in.
        let edge = ChooserPlacement.frame(size: size, anchor: .caret(CGRect(x: 1430, y: 600, width: 0, height: 18)), visible: visible)
        XCTAssertEqual(edge.maxX, visible.maxX - ChooserPlacement.margin)
        // Upper third, centred.
        let centred = ChooserPlacement.frame(size: size, anchor: .screen, visible: visible)
        XCTAssertEqual(centred.midX, visible.midX)
        XCTAssertGreaterThan(centred.midY, visible.midY)
        // Pointer: below it, on the pointer's screen.
        let pointer = ChooserPlacement.frame(size: size, anchor: .pointer(CGPoint(x: 700, y: 500)), visible: visible)
        XCTAssertLessThan(pointer.maxY, 500)
        XCTAssertTrue(visible.contains(pointer))
    }

    func testAccessibilityRectsFlipToAppKit() {
        let rect = ChooserPlacement.appKitRect(fromAccessibility: CGRect(x: 100, y: 200, width: 2, height: 20), primaryScreenHeight: 900)
        XCTAssertEqual(rect, CGRect(x: 100, y: 680, width: 2, height: 20))
        XCTAssertFalse(ChooserPlacement.isUsableCaret(.zero))
        XCTAssertFalse(ChooserPlacement.isUsableCaret(CGRect(x: 10, y: 10, width: 5, height: 0)))
        XCTAssertTrue(ChooserPlacement.isUsableCaret(CGRect(x: 10, y: 10, width: 0, height: 18)))
    }
}
