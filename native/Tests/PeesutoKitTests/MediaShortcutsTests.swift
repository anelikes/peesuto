import XCTest
@testable import PeesutoKit

final class MediaShortcutsTests: XCTestCase {
    @MainActor func testDefaultsAreTheChooserAndHistoryWithMediaUnbound() throws {
        let resolved = MediaShortcuts.resolve(saved: [:], legacyPanel: nil)
        XCTAssertEqual(resolved, ["paste-as": "Alt+V", "panel": "Alt+Shift+V", "paste-card": "", "paste-gif": "",
                                  "paste-video": "", "paste-qr": "", "pin-screen": ""])
        XCTAssertEqual(resolved, DefaultShortcuts.all)
        XCTAssertEqual(MediaShortcuts.actionIDs, ["paste-card", "paste-gif", "paste-video", "paste-qr", "pin-screen"])
        XCTAssertEqual(MediaShortcuts.glyphs(DefaultShortcuts.chooser), ["⌥", "V"])
        XCTAssertEqual(MediaShortcuts.glyphs(DefaultShortcuts.panel), ["⌥", "⇧", "V"])
        // Unbound shortcuts are skipped, the two bound ones parse (option alone is a valid modifier).
        XCTAssertNoThrow(try HotKeyGroup.validate(resolved))
        XCTAssertNoThrow(try HotKeyManager.parse(DefaultShortcuts.chooser))
    }

    func testSavedBindingsWinAndMissingOnesTakeTheDefault() {
        let saved = ["panel": "CmdOrCtrl+Shift+P", "paste-card": "", "paste-gif": "CmdOrCtrl+Alt+2", "paste-video": "CmdOrCtrl+Alt+9"]
        let resolved = MediaShortcuts.resolve(saved: saved, legacyPanel: "CmdOrCtrl+Shift+X")
        XCTAssertEqual(resolved["paste-as"], "Alt+V")
        XCTAssertEqual(resolved["paste-qr"], "")
        XCTAssertEqual(resolved["panel"], "CmdOrCtrl+Shift+P")
        XCTAssertEqual(resolved["paste-card"], "", "a disabled shortcut stays disabled")
        XCTAssertEqual(resolved["paste-video"], "CmdOrCtrl+Alt+9")
        XCTAssertEqual(MediaShortcuts.resolve(saved: [:], legacyPanel: "CmdOrCtrl+Shift+X")["panel"], "CmdOrCtrl+Shift+X")
        XCTAssertEqual(MediaShortcuts.resolve(saved: ["paste-as": ""], legacyPanel: nil)["paste-as"], "")
    }

    func testMigrationResetsOlderShortcutsOnce() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-shortcuts-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let old: [String: Any] = ["hotkey": "CmdOrCtrl+Shift+V", "language": "en",
                                  "native_shortcuts": ["panel": "CmdOrCtrl+Shift+V", "paste-card": "CmdOrCtrl+Alt+1", "paste-gif": "Control+G"]]
        try JSONSerialization.data(withJSONObject: old).write(to: directory.appendingPathComponent("settings.json"))
        let settings = try SettingsStore(directory: directory)
        XCTAssertTrue(MediaShortcuts.needsReset(savedVersion: settings.shortcutsVersion))
        XCTAssertTrue(try settings.migrateShortcutsIfNeeded(), "an existing setup reports the reset")
        XCTAssertEqual(settings.values["native_shortcuts"] as? [String: String], DefaultShortcuts.all, "custom bindings are not kept")
        XCTAssertEqual(settings.hotkey, DefaultShortcuts.panel)
        XCTAssertEqual(settings.shortcutsVersion, DefaultShortcuts.version)
        XCTAssertEqual(settings.language, "en", "other settings are untouched")
        // A binding changed after the migration survives the next launch.
        try settings.setValues(["native_shortcuts": DefaultShortcuts.all.merging(["paste-card": "CmdOrCtrl+Alt+1"]) { _, new in new }])
        let relaunched = try SettingsStore(directory: directory)
        XCTAssertFalse(try relaunched.migrateShortcutsIfNeeded())
        XCTAssertEqual((relaunched.values["native_shortcuts"] as? [String: String])?["paste-card"], "CmdOrCtrl+Alt+1")
    }

    func testFreshInstallGetsDefaultsWithoutAChangeNotice() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-shortcuts-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = try SettingsStore(directory: directory)
        XCTAssertFalse(try settings.migrateShortcutsIfNeeded())
        XCTAssertEqual(settings.values["native_shortcuts"] as? [String: String], DefaultShortcuts.all)
        XCTAssertFalse(MediaShortcuts.needsReset(savedVersion: settings.shortcutsVersion))
        XCTAssertTrue(MediaShortcuts.needsReset(savedVersion: DefaultShortcuts.version - 1))
    }

    func testMenuKeyEquivalents() {
        let chooser = MediaShortcuts.menuKey("Alt+V")
        XCTAssertEqual(chooser?.key, "v"); XCTAssertEqual(chooser?.option, true); XCTAssertEqual(chooser?.command, false)
        let panel = MediaShortcuts.menuKey("Alt+Shift+V")
        XCTAssertEqual(panel?.shift, true); XCTAssertEqual(panel?.option, true)
        XCTAssertEqual(MediaShortcuts.menuKey("CmdOrCtrl+Alt+1")?.key, "1")
        XCTAssertNil(MediaShortcuts.menuKey(""))
        XCTAssertNil(MediaShortcuts.menuKey("CmdOrCtrl+Space"))
    }

    func testShortcutGlyphsFollowMacOSModifierOrder() {
        XCTAssertEqual(MediaShortcuts.glyphs("CmdOrCtrl+Alt+1"), ["⌥", "⌘", "1"])
        XCTAssertEqual(MediaShortcuts.glyphs("CmdOrCtrl+Shift+V"), ["⇧", "⌘", "V"])
        XCTAssertEqual(MediaShortcuts.glyphs("Control+Option+Shift+Command+Space"), ["⌃", "⌥", "⇧", "⌘", "Space"])
        XCTAssertEqual(MediaShortcuts.glyphs(""), [])
        XCTAssertEqual(MediaShortcuts.glyphs("Hyper+V"), [])
    }

    func testQRCodeActionUsesImageFrameAndTimeout() {
        XCTAssertEqual(OutputFrames.kind(actionID: "paste-qr"), "image")
        XCTAssertEqual(CoreClient.actionTimeout(actionID: "paste-qr"), 300)
    }

    func testQRTooLongMessage() {
        let failure = CoreError(kind: "compose", message: "too long", code: "qr-too-long")
        XCTAssertEqual(ComposeFailureText.message(failure, tr: Localizer(.chinese)),
                       "内容太长，放不进一个二维码（大约 950 个汉字或 2900 个英文字符以内）。")
        XCTAssertTrue(ComposeFailureText.message(failure, tr: Localizer(.english)).contains("too long for one QR code"))
        let overflow = CoreError(kind: "compose", message: "overflow", code: "overflow")
        XCTAssertTrue(ComposeFailureText.message(overflow, tr: Localizer(.english)).hasPrefix("This content could not fit safely"))
    }
}

final class CoreLaunchArgumentsTests: XCTestCase {
    func testBunNeverAutoInstallsAtRuntime() {
        let daemon = URL(fileURLWithPath: "/App/Contents/Resources/core/daemon.ts")
        let arguments = CoreClient.launchArguments(daemon: daemon, appData: URL(fileURLWithPath: "/tmp/data"),
                                                   resources: URL(fileURLWithPath: "/App/Contents/Resources"))
        let flag = try? XCTUnwrap(arguments.firstIndex(of: "--no-install"))
        let script = try? XCTUnwrap(arguments.firstIndex(of: daemon.path))
        XCTAssertNotNil(flag); XCTAssertNotNil(script)
        if let flag, let script { XCTAssertLessThan(flag, script, "Bun flags must precede the script path") }
        XCTAssertEqual(arguments.first, "--no-install")
        XCTAssertEqual(Array(arguments.suffix(2)), ["--engine-resources", "/App/Contents/Resources"])
    }
}
