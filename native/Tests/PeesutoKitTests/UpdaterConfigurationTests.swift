import XCTest
@testable import PeesutoKit

final class UpdaterConfigurationTests: XCTestCase {
    private let release: [String: Any] = [
        "CFBundleIdentifier": "com.peesuto.desktop",
        "PeesutoPreview": false,
        "SUFeedURL": "https://peesuto.com/appcast.xml",
        "SUPublicEDKey": "3mrnJuKG6QU3x2WO2ZtM2mGrIMxHeHmycaHvwpqBwao=",
    ]

    func testReleaseBundleEnablesUpdater() {
        XCTAssertTrue(UpdaterConfiguration.isEnabled(info: release))
    }

    func testPreviewBuildsNeverCheck() {
        var marked = release; marked["PeesutoPreview"] = true
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: marked))
        var previewID = release; previewID["CFBundleIdentifier"] = "com.peesuto.desktop.preview"
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: previewID))
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: release, arguments: ["Peesuto", "--preview"]))
    }

    func testMissingOrInsecureFeedDisablesUpdater() {
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: [:]))
        var noKey = release; noKey["SUPublicEDKey"] = nil
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: noKey))
        var http = release; http["SUFeedURL"] = "http://peesuto.com/appcast.xml"
        XCTAssertFalse(UpdaterConfiguration.isEnabled(info: http))
    }
}
