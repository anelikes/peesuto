import AppKit
import XCTest
@testable import PeesutoKit

final class PinShortcutTests: XCTestCase {
    @MainActor func testPinIsUnboundByDefaultAndKeepsASavedBinding() {
        XCTAssertEqual(MediaShortcuts.resolve(saved: [:], legacyPanel: nil)[MediaShortcuts.pinID], "")
        let saved = ["panel": "Alt+Shift+V", "paste-as": "Alt+V", "pin-screen": "CmdOrCtrl+Alt+5"]
        let resolved = MediaShortcuts.resolve(saved: saved, legacyPanel: nil)
        XCTAssertEqual(resolved["pin-screen"], "CmdOrCtrl+Alt+5")
        XCTAssertNoThrow(try HotKeyGroup.validate(resolved))
        XCTAssertEqual(MediaShortcuts.glyphs("CmdOrCtrl+Alt+5"), ["⌥", "⌘", "5"])
    }

    @MainActor func testPinConflictsLikeOtherShortcuts() {
        var shortcuts = MediaShortcuts.resolve(saved: [:], legacyPanel: nil)
        shortcuts["pin-screen"] = DefaultShortcuts.chooser
        XCTAssertThrowsError(try HotKeyGroup.validate(shortcuts))
        shortcuts["pin-screen"] = "CmdOrCtrl+Alt+1"
        shortcuts["paste-card"] = "CmdOrCtrl+Alt+1"
        XCTAssertThrowsError(try HotKeyGroup.validate(shortcuts))
    }

    func testPinIsNeverAPaste() {
        XCTAssertEqual(ClipboardShortcutDelivery.of(shortcut: MediaShortcuts.pinID), .pin)
        for id in ["paste-card", "paste-gif", "paste-video", "paste-qr"] {
            XCTAssertEqual(ClipboardShortcutDelivery.of(shortcut: id), .paste)
            XCTAssertEqual(ClipboardShortcutDelivery.renderAction(shortcut: id), id)
        }
        // Pin renders text exactly like Paste as image: the image card action, image frame and timeout.
        let action = ClipboardShortcutDelivery.renderAction(shortcut: MediaShortcuts.pinID)
        XCTAssertEqual(action, "paste-card")
        XCTAssertEqual(OutputFrames.kind(actionID: action), "image")
        XCTAssertEqual(CoreClient.actionTimeout(actionID: action), CoreClient.actionTimeout(actionID: "paste-card"))
    }
}

final class PinGeometryTests: XCTestCase {
    let visible = CGRect(x: 0, y: 25, width: 1440, height: 875)

    func testNaturalSizeUsesBackingScale() {
        XCTAssertEqual(PinGeometry.naturalSize(pixelWidth: 1080, pixelHeight: 1350, scale: 2), CGSize(width: 540, height: 675))
        XCTAssertEqual(PinGeometry.naturalSize(pixelWidth: 300, pixelHeight: 200, scale: 1), CGSize(width: 300, height: 200))
    }

    func testFitOnlyScalesDown() {
        XCTAssertEqual(PinGeometry.fit(CGSize(width: 100, height: 50), within: CGSize(width: 400, height: 400)), CGSize(width: 100, height: 50))
        XCTAssertEqual(PinGeometry.fit(CGSize(width: 800, height: 400), within: CGSize(width: 400, height: 400)), CGSize(width: 400, height: 200))
    }

    func testInitialFrameFitsWithin45PercentCentredOnMouse() {
        let natural = CGSize(width: 540, height: 675)
        let frame = PinGeometry.initialFrame(natural: natural, center: CGPoint(x: 720, y: 460), visibleFrame: visible)
        XCTAssertLessThanOrEqual(frame.width, visible.width * 0.45 + 1)
        XCTAssertLessThanOrEqual(frame.height, visible.height * 0.45 + 1)
        XCTAssertEqual(frame.width / frame.height, natural.width / natural.height, accuracy: 0.01)
        XCTAssertEqual(frame.midX, 720, accuracy: 1)
        XCTAssertEqual(frame.midY, 460, accuracy: 1)
        // Small images keep their natural size.
        let small = PinGeometry.initialFrame(natural: CGSize(width: 120, height: 80), center: CGPoint(x: 700, y: 400), visibleFrame: visible)
        XCTAssertEqual(small.size, CGSize(width: 120, height: 80))
    }

    func testInitialFrameIsClampedToVisibleFrame() {
        let frame = PinGeometry.initialFrame(natural: CGSize(width: 300, height: 200), center: CGPoint(x: 5, y: 890), visibleFrame: visible)
        XCTAssertEqual(frame.minX, visible.minX)
        XCTAssertEqual(frame.maxY, visible.maxY)
        XCTAssertTrue(visible.contains(frame))
        let low = PinGeometry.clamp(CGRect(x: 1400, y: 0, width: 200, height: 100), to: visible)
        XCTAssertEqual(low.origin, CGPoint(x: 1240, y: 25))
        let huge = PinGeometry.clamp(CGRect(x: 100, y: 100, width: 2000, height: 1000), to: visible)
        XCTAssertEqual(huge.origin, CGPoint(x: 0, y: -100), "oversized frames align to the top-left")
    }

    func testZoomKeepsAnchorFixed() {
        let natural = CGSize(width: 400, height: 200)
        let frame = CGRect(x: 100, y: 100, width: 400, height: 200)
        let anchor = CGPoint(x: 200, y: 150) // 25% across, 25% up
        let zoomed = PinGeometry.zoom(frame: frame, by: 1.5, anchor: anchor, natural: natural, screen: visible.size)
        XCTAssertEqual(zoomed.size, CGSize(width: 600, height: 300))
        XCTAssertEqual(zoomed.minX + 0.25 * zoomed.width, anchor.x, accuracy: 0.001)
        XCTAssertEqual(zoomed.minY + 0.25 * zoomed.height, anchor.y, accuracy: 0.001)
    }

    func testZoomClampsToMinimumShortSide() {
        let natural = CGSize(width: 400, height: 200)
        let frame = CGRect(x: 0, y: 0, width: 400, height: 200)
        let tiny = PinGeometry.zoom(frame: frame, by: 0.01, anchor: CGPoint(x: 200, y: 100), natural: natural, screen: visible.size)
        XCTAssertEqual(tiny.height, 64, accuracy: 0.001)
        XCTAssertEqual(tiny.width, 128, accuracy: 0.001)
        XCTAssertEqual(tiny.midX, 200, accuracy: 0.001, "centre anchor stays centred")
    }

    func testZoomClampsTo400PercentOrScreen() {
        let small = CGSize(width: 100, height: 50)
        let frame = CGRect(x: 0, y: 0, width: 100, height: 50)
        let big = PinGeometry.zoom(frame: frame, by: 100, anchor: .zero, natural: small, screen: visible.size)
        XCTAssertEqual(big.size, CGSize(width: 400, height: 200))
        let card = CGSize(width: 540, height: 675)
        let screenLimited = PinGeometry.zoom(frame: CGRect(origin: .zero, size: card), by: 100, anchor: .zero, natural: card, screen: visible.size)
        XCTAssertEqual(screenLimited.height, visible.height, accuracy: 0.001)
        XCTAssertLessThanOrEqual(screenLimited.width, visible.width)
    }

    func testTinyImageLimitsNeverInvert() {
        let limits = PinGeometry.scaleLimits(natural: CGSize(width: 8, height: 8), screen: visible.size)
        XCTAssertLessThanOrEqual(limits.lowerBound, limits.upperBound)
        XCTAssertEqual(limits.upperBound, 4)
    }

    func testScrollFactorIsSmoothAndDirectional() {
        XCTAssertGreaterThan(PinGeometry.scrollZoomFactor(deltaY: 3, precise: true), 1)
        XCTAssertLessThan(PinGeometry.scrollZoomFactor(deltaY: -3, precise: true), 1)
        XCTAssertEqual(PinGeometry.scrollZoomFactor(deltaY: 0, precise: false), 1)
        XCTAssertLessThan(PinGeometry.scrollZoomFactor(deltaY: 4, precise: true), 1.1, "a small trackpad delta is a small step")
        XCTAssertEqual(PinGeometry.scrollZoomFactor(deltaY: 1000, precise: false), 2)
    }
}

final class PinImageTests: XCTestCase {
    private func png(width: Int, height: Int) -> Data {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                                      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        return bitmap.representation(using: .png, properties: [:])!
    }

    func testPNGAndTIFFBecomePNG() throws {
        let data = png(width: 20, height: 10)
        let image = try XCTUnwrap(PinImage.from(data: data, gif: false))
        XCTAssertEqual(image.format, "png")
        XCTAssertEqual(image.pixelSize?.width, 20)
        let tiff = try XCTUnwrap(NSBitmapImageRep(data: data)?.tiffRepresentation)
        let converted = try XCTUnwrap(PinImage.from(data: tiff, gif: false))
        XCTAssertEqual(converted.format, "png")
        XCTAssertTrue(converted.data.starts(with: [137, 80, 78, 71]))
        XCTAssertNil(PinImage.from(data: Data("not an image".utf8), gif: false))
    }

    func testImageFileDetection() {
        XCTAssertTrue(PinImage.isImageFile(URL(fileURLWithPath: "/tmp/a.GIF")))
        XCTAssertTrue(PinImage.isImageFile(URL(fileURLWithPath: "/tmp/a.jpeg")))
        XCTAssertFalse(PinImage.isImageFile(URL(fileURLWithPath: "/tmp/a.txt")))
        XCTAssertFalse(PinImage.isImageFile(URL(string: "https://example.com/a.png")!))
    }
}
