import Foundation
import XCTest
@testable import PeesutoKit

final class OutputFramesTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-frames-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: directory) }

    private func write(_ json: String) throws {
        try Data(json.utf8).write(to: directory.appendingPathComponent("settings.json"))
    }

    func testDefaultsWithoutSavedFrames() throws {
        let settings = try SettingsStore(directory: directory)
        XCTAssertEqual(settings.frame(kind: "image"), "auto")
        XCTAssertEqual(settings.frame(kind: "gif"), "1:1")
        XCTAssertEqual(settings.frame(kind: "video"), "1:1")
    }

    func testLegacyAspectMigratesToGifAndVideoOnly() throws {
        for (legacy, frame) in [("chat", "1:1"), ("doc", "16:9"), ("social", "9:16")] {
            try write(#"{"aspect":"\#(legacy)"}"#)
            let settings = try SettingsStore(directory: directory)
            XCTAssertEqual(settings.frame(kind: "image"), "auto")
            XCTAssertEqual(settings.frame(kind: "gif"), frame)
            XCTAssertEqual(settings.frame(kind: "video"), frame)
        }
        // Reading never rewrites the file.
        XCTAssertFalse(try String(contentsOf: directory.appendingPathComponent("settings.json")).contains("frame_"))
    }

    func testSavedFramesWinOverLegacyAndPersist() throws {
        try write(#"{"aspect":"social","future":1}"#)
        let settings = try SettingsStore(directory: directory)
        try settings.setFrames(["image": "4:5", "gif": "16:9", "video": "auto"])
        let reopened = try SettingsStore(directory: directory)
        XCTAssertEqual(reopened.frame(kind: "image"), "4:5")
        XCTAssertEqual(reopened.frame(kind: "gif"), "16:9")
        XCTAssertEqual(reopened.frame(kind: "video"), "1:1", "auto is image-only")
        XCTAssertEqual(reopened.values["frame_video"] as? String, "1:1")
        XCTAssertEqual(reopened.values["future"] as? Int, 1)
    }

    func testPerOutputSelectionAndNormalization() {
        XCTAssertEqual(OutputFrames.kind(output: "image"), "image")
        XCTAssertEqual(OutputFrames.kind(output: "png"), "image")
        XCTAssertEqual(OutputFrames.kind(output: "gif"), "gif")
        XCTAssertEqual(OutputFrames.kind(output: "video"), "video")
        XCTAssertEqual(OutputFrames.kind(output: "mp4"), "video")
        XCTAssertNil(OutputFrames.kind(output: "text"))
        XCTAssertEqual(OutputFrames.kind(actionID: "paste-card"), "image")
        XCTAssertEqual(OutputFrames.kind(actionID: "paste-video"), "video")
        XCTAssertNil(OutputFrames.kind(actionID: "paste-summary"))
        XCTAssertEqual(OutputFrames.options(kind: "image").first, "auto")
        XCTAssertFalse(OutputFrames.options(kind: "gif").contains("auto"))
        XCTAssertEqual(OutputFrames.normalize("doc", kind: "gif"), "16:9")
        XCTAssertEqual(OutputFrames.normalize("auto", kind: "video"), "1:1")
        XCTAssertEqual(OutputFrames.normalize("bogus", kind: "image"), "auto")
        XCTAssertEqual(OutputFrames.normalize(nil, kind: "gif"), "1:1")
    }

    func testTemplateSelectionDecodesOptionalAspect() throws {
        let base = #""id":"quote","variant":"classic","motion":"none","decisionSource":"rules","availableTemplates":["quote"]"#
        let with = try JSONDecoder().decode(CoreActionMetadata.self, from: Data(#"{"template":{\#(base),"aspect":"9:16"}}"#.utf8))
        XCTAssertEqual(with.template?.aspect, "9:16")
        let without = try JSONDecoder().decode(CoreActionMetadata.self, from: Data(#"{"template":{\#(base)}}"#.utf8))
        XCTAssertNil(without.template?.aspect)
    }
}
