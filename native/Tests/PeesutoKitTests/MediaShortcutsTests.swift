import XCTest
@testable import PeesutoKit

final class MediaShortcutsTests: XCTestCase {
    @MainActor func testDefaultsIncludeQRCodeOnCommandOption4() throws {
        let resolved = MediaShortcuts.resolve(saved: [:], legacyPanel: nil)
        XCTAssertEqual(resolved, ["panel": "CmdOrCtrl+Shift+V", "paste-card": "CmdOrCtrl+Alt+1", "paste-gif": "CmdOrCtrl+Alt+2",
                                  "paste-video": "CmdOrCtrl+Alt+3", "paste-qr": "CmdOrCtrl+Alt+4"])
        XCTAssertEqual(MediaShortcuts.actionIDs, ["paste-card", "paste-gif", "paste-video", "paste-qr"])
        XCTAssertNoThrow(try HotKeyGroup.validate(resolved))
    }

    func testSettingsSavedBeforeQRCodeGetItsDefault() {
        let saved = ["panel": "CmdOrCtrl+Shift+P", "paste-card": "", "paste-gif": "CmdOrCtrl+Alt+2", "paste-video": "CmdOrCtrl+Alt+9"]
        let resolved = MediaShortcuts.resolve(saved: saved, legacyPanel: "CmdOrCtrl+Shift+X")
        XCTAssertEqual(resolved["paste-qr"], "CmdOrCtrl+Alt+4")
        XCTAssertEqual(resolved["panel"], "CmdOrCtrl+Shift+P")
        XCTAssertEqual(resolved["paste-card"], "", "a disabled shortcut stays disabled")
        XCTAssertEqual(resolved["paste-video"], "CmdOrCtrl+Alt+9")
        XCTAssertEqual(MediaShortcuts.resolve(saved: [:], legacyPanel: "CmdOrCtrl+Shift+X")["panel"], "CmdOrCtrl+Shift+X")
        XCTAssertEqual(MediaShortcuts.resolve(saved: ["paste-qr": ""], legacyPanel: nil)["paste-qr"], "")
    }

    func testQRCodeActionUsesImageFrameAndTimeout() {
        XCTAssertEqual(OutputFrames.kind(actionID: "paste-qr"), "image")
        XCTAssertEqual(CoreClient.actionTimeout(actionID: "paste-qr"), 300)
    }

    func testQRTooLongMessage() {
        let failure = CoreError(kind: "compose", message: "too long", code: "qr-too-long")
        XCTAssertEqual(ComposeFailureText.message(failure, tr: { _, zh in zh }),
                       "内容太长，放不进一个二维码（大约 950 个汉字或 2900 个英文字符以内）。")
        XCTAssertTrue(ComposeFailureText.message(failure, tr: { en, _ in en }).contains("too long for one QR code"))
        let overflow = CoreError(kind: "compose", message: "overflow", code: "overflow")
        XCTAssertTrue(ComposeFailureText.message(overflow, tr: { en, _ in en }).hasPrefix("This content could not fit safely"))
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
