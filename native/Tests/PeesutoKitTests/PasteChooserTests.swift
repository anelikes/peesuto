import XCTest
@testable import PeesutoKit

final class PasteChooserTests: XCTestCase {
    func testAcceleratorsMapToChoices() {
        XCTAssertEqual(PasteChooser.key(keyCode: 36, characters: "\r"), .choose(.image))
        XCTAssertEqual(PasteChooser.key(keyCode: 76, characters: "\u{3}"), .choose(.image), "keypad Enter")
        XCTAssertEqual(PasteChooser.key(keyCode: 5, characters: "g"), .choose(.gif))
        XCTAssertEqual(PasteChooser.key(keyCode: 46, characters: "m"), .choose(.video))
        XCTAssertEqual(PasteChooser.key(keyCode: 12, characters: "Q"), .choose(.qr), "shift does not matter")
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
    }

    func testChoicesRunTheMediaShortcuts() {
        XCTAssertEqual(PasteChooser.order.map(\.shortcutID), ["paste-card", "paste-gif", "paste-video", "paste-qr", "pin-screen", nil])
        XCTAssertEqual(PasteChooser.order.map(\.keyLabel), ["↩", "G", "M", "Q", "P", "H"])
        XCTAssertEqual(ClipboardShortcutDelivery.of(shortcut: PasteChoice.pin.shortcutID!), .pin)
        XCTAssertEqual(ClipboardShortcutDelivery.renderAction(shortcut: PasteChoice.pin.shortcutID!), PasteChoice.image.shortcutID)
    }

    func testEnabledChoicesFollowTheClipboard() {
        for choice in PasteChooser.order { XCTAssertTrue(PasteChooser.isEnabled(choice, clipboard: .text), "\(choice)") }
        XCTAssertEqual(PasteChooser.order.filter { PasteChooser.isEnabled($0, clipboard: .image) }, [.pin, .history])
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
