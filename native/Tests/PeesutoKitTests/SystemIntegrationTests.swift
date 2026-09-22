import XCTest
import Carbon
import AppKit
@testable import PeesutoKit

final class SystemIntegrationTests: XCTestCase {
    func testDirectPasteRejectsChangedClipboardAndUnverifiableTargets() {
        XCTAssertTrue(DirectPastePolicy.canReplaceClipboard(captured: 7, current: 7))
        XCTAssertFalse(DirectPastePolicy.canReplaceClipboard(captured: 7, current: 8))
        XCTAssertFalse(DirectPastePolicy.canReplaceClipboard(captured: nil, current: 7))
        let original = DirectFocusState(processID: 12, selectionLocation: 3, selectionLength: 2,
                                        valueDigest: Data([1]), windowTitle: "Document", role: "AXTextArea")
        func allowed(_ current: DirectFocusState?, window: Bool = true, element: Bool = true,
                     trusted: Bool = true, secure: Bool = false) -> Bool {
            DirectPastePolicy.canPaste(initial: original, current: current, sameWindow: window,
                                      sameElement: element, trusted: trusted, secureInput: secure)
        }
        XCTAssertTrue(allowed(original))
        XCTAssertFalse(allowed(nil))
        XCTAssertFalse(allowed(original, window: false))
        XCTAssertFalse(allowed(original, element: false))
        XCTAssertFalse(allowed(original, trusted: false))
        XCTAssertFalse(allowed(original, secure: true))
        for changed in [
            DirectFocusState(processID: 13, selectionLocation: 3, selectionLength: 2, valueDigest: Data([1]), windowTitle: "Document", role: "AXTextArea"),
            DirectFocusState(processID: 12, selectionLocation: 4, selectionLength: 2, valueDigest: Data([1]), windowTitle: "Document", role: "AXTextArea"),
            DirectFocusState(processID: 12, selectionLocation: 3, selectionLength: 0, valueDigest: Data([1]), windowTitle: "Document", role: "AXTextArea"),
            DirectFocusState(processID: 12, selectionLocation: 3, selectionLength: 2, valueDigest: Data([2]), windowTitle: "Document", role: "AXTextArea"),
            DirectFocusState(processID: 12, selectionLocation: 3, selectionLength: 2, valueDigest: Data([1]), windowTitle: "Other conversation", role: "AXTextArea")
        ] { XCTAssertFalse(allowed(changed)) }
    }

    func testIndependentHotkeyIdentitiesCannotConsumeEachOthersEvents() async {
        await MainActor.run {
            let first = HotKeyManager(), second = HotKeyManager()
            XCTAssertNotEqual(first.eventID, second.eventID)
            XCTAssertTrue(first.matchesEvent(signature: 0x50535554, id: first.eventID))
            XCTAssertFalse(second.matchesEvent(signature: 0x50535554, id: first.eventID))
            XCTAssertFalse(first.matchesEvent(signature: 0, id: first.eventID))
        }
    }

    func testGroupSwapsRoutesWithoutReregisteringAndRejectsNormalizedDuplicates() async throws {
        try await MainActor.run {
            var registrations: [FakeHotKeyRegistration] = []
            let group = HotKeyGroup {
                let registration = FakeHotKeyRegistration()
                registrations.append(registration)
                return registration
            }
            var fired: [String] = []
            try group.register(["panel": "Cmd+Shift+V", "gif": "Cmd+Shift+G", "video": "  "]) { fired.append($0) }
            XCTAssertEqual(registrations.count, 2)
            let panel = try XCTUnwrap(registrations.first { $0.accelerator == "Cmd+Shift+V" })
            panel.handler?()
            XCTAssertEqual(fired, ["panel"])
            try group.register(["gif": "Cmd+Shift+V", "panel": "Cmd+Shift+G"]) { fired.append($0) }
            XCTAssertEqual(registrations.count, 2)
            XCTAssertTrue(registrations.allSatisfy { $0.unregisterCount == 0 })
            panel.handler?()
            XCTAssertEqual(fired.last, "gif")
            XCTAssertThrowsError(try group.register(["panel": "Command+Shift+V", "gif": "shift+cmdorctrl+v"]) { _ in XCTFail() })
            panel.handler?()
            XCTAssertEqual(fired.last, "gif")
            XCTAssertThrowsError(try HotKeyGroup.validate(["panel": "Cmd+Shift+V", "gif": "shift+cmdorctrl+v"]))
            try HotKeyGroup.validate(["panel": "Cmd+Shift+V", "gif": ""])
            group.unregister()
            XCTAssertTrue(registrations.allSatisfy { $0.unregisterCount == 1 })
            try group.register(["panel": "Cmd+Shift+V"]) { fired.append($0) }
            XCTAssertEqual(registrations.count, 3)
            group.unregister()
        }
    }

    func testGroupRegistrationFailureKeepsPreviousHandlersAndKeys() async throws {
        try await MainActor.run {
            var registrations: [FakeHotKeyRegistration] = []
            var failNew = false
            let group = HotKeyGroup {
                let registration = FakeHotKeyRegistration()
                registration.shouldFail = failNew && registrations.count == 2
                registrations.append(registration)
                return registration
            }
            var fired: [String] = []
            try group.register(["panel": "Cmd+Shift+V"]) { fired.append($0) }
            let original = registrations[0]
            failNew = true
            XCTAssertThrowsError(try group.register(["gif": "Cmd+Shift+G", "video": "Cmd+Shift+M"]) { _ in XCTFail("Replacement handler must not be installed") })
            XCTAssertEqual(original.unregisterCount, 0)
            XCTAssertEqual(registrations.count, 3)
            XCTAssertTrue(registrations.dropFirst().allSatisfy { $0.unregisterCount == 1 })
            original.handler?()
            XCTAssertEqual(fired, ["panel"])
            group.unregister()
        }
    }

    func testMultipleFilesKeepDistinctURLsAndSingleGIFPayload() async throws {
        try await MainActor.run {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let first = root.appendingPathComponent("first file.gif")
            let second = root.appendingPathComponent("第二个.txt")
            let gif = Data("GIF89a".utf8)
            try gif.write(to: first)
            try Data("text".utf8).write(to: second)
            let items = try XCTUnwrap(PasteController.fileItems([first, second]))
            XCTAssertEqual(items.count, 2)
            XCTAssertEqual(items[0].string(forType: .fileURL), first.absoluteString)
            XCTAssertEqual(items[1].string(forType: .fileURL), second.absoluteString)
            let gifType = NSPasteboard.PasteboardType("com.compuserve.gif")
            XCTAssertNil(items[0].data(forType: gifType))
            let single = try XCTUnwrap(PasteController.fileItems([first]))
            XCTAssertEqual(single[0].data(forType: gifType), gif)
            XCTAssertNil(PasteController.fileItems([]))
            XCTAssertNil(PasteController.fileItems([first, root.appendingPathComponent("missing")]))
            XCTAssertNil(PasteController.fileItems([URL(string: "https://example.com/file")!]))
        }
    }

    func testLegacyTIFFIsConvertedBeforeAdvertisingPNG() async throws {
        try await MainActor.run {
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            bitmap.setColor(.red, atX: 0, y: 0)
            let tiff = try XCTUnwrap(bitmap.tiffRepresentation)
            let png = try XCTUnwrap(PasteController.normalizedPNG(tiff))
            XCTAssertTrue(png.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]))
            XCTAssertEqual(NSBitmapImageRep(data: png)?.pixelsWide, 2)
            XCTAssertEqual(PasteController.normalizedPNG(png), png)
            XCTAssertNil(PasteController.normalizedPNG(Data("not an image".utf8)))
        }
    }

    func testCaretUsesUTF16AndExcludesSelectedText() {
        let context = ContextCapture.aroundCaret("a😀selected尾", location: 3, length: 8)
        XCTAssertEqual(context.before, "a😀")
        XCTAssertEqual(context.after, "尾")
        let clamped = ContextCapture.aroundCaret("ab", location: Int.max, length: Int.max)
        XCTAssertEqual(clamped.before, "ab")
        XCTAssertEqual(clamped.after, "")
    }

    func testCaretBoundsPayloadAndHandlesMalformedRanges() {
        let context = ContextCapture.aroundCaret(String(repeating: "中", count: 1000), location: 500, length: 0)
        XCTAssertEqual(context.before.unicodeScalars.count, 200)
        XCTAssertEqual(context.after.unicodeScalars.count, 200)
        let splitSurrogate = ContextCapture.aroundCaret("😀", location: 1, length: 0)
        XCTAssertEqual(splitSurrogate.before, "�")
        XCTAssertEqual(splitSurrogate.after, "�")
        let negative = ContextCapture.aroundCaret("abc", location: -1, length: -2)
        XCTAssertEqual(negative.before, "")
        XCTAssertEqual(negative.after, "abc")
    }

    func testSensitiveClipboardExclusionsAreAppliedBeforeContentRead() async {
        await MainActor.run {
            let excluded = ClipboardMonitor.defaultExcludedApps
            XCTAssertFalse(ClipboardMonitor.shouldRecord(types: ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"], bundleID: nil, excludedApps: excluded))
            XCTAssertFalse(ClipboardMonitor.shouldRecord(types: ["org.nspasteboard.TransientType"], bundleID: "com.apple.TextEdit", excludedApps: excluded))
            for app in excluded {
                XCTAssertFalse(ClipboardMonitor.shouldRecord(types: ["public.png"], bundleID: app, excludedApps: excluded))
            }
            XCTAssertTrue(ClipboardMonitor.shouldRecord(types: ["public.png"], bundleID: "com.apple.TextEdit", excludedApps: excluded))
            XCTAssertTrue(ClipboardMonitor.shouldRecord(types: [], bundleID: nil, excludedApps: excluded))
        }
    }

    func testAcceleratorParsingPreservesDeleteAndModifierSemantics() async throws {
        try await MainActor.run {
            let main = try HotKeyManager.parse("CmdOrCtrl+Shift+V")
            XCTAssertEqual(main.keyCode, UInt32(kVK_ANSI_V))
            XCTAssertEqual(main.modifiers, UInt32(cmdKey | shiftKey))
            XCTAssertEqual(try HotKeyManager.parse("Control+Delete").keyCode, UInt32(kVK_ForwardDelete))
            XCTAssertEqual(try HotKeyManager.parse("Command+Backspace").keyCode, UInt32(kVK_Delete))
            for invalid in ["V", "Shift+V", "Cmd++", "Hyper+V", "Command+Unknown"] {
                XCTAssertThrowsError(try HotKeyManager.parse(invalid))
            }
        }
    }
}

@MainActor
private final class FakeHotKeyRegistration: HotKeyRegistration {
    var accelerator: String?
    var handler: (() -> Void)?
    var unregisterCount = 0
    var shouldFail = false
    func register(accelerator: String, handler: @escaping () -> Void) throws {
        if shouldFail { throw HotKeyError.unavailable(-9878) }
        self.accelerator = accelerator
        self.handler = handler
    }
    func unregister() { unregisterCount += 1; handler = nil }
}
