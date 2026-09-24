import XCTest
@testable import PeesutoKit

final class JizuraHandoffTests: XCTestCase {
    func testEditionFollowsTheInterfaceLanguage() {
        XCTAssertEqual(JizuraHandoff.url(for: .japanese).absoluteString, "https://852wa.github.io/JIZURA/")
        XCTAssertEqual(JizuraHandoff.url(for: .english).absoluteString, "https://852wa.github.io/JIZURA/en/")
        XCTAssertEqual(JizuraHandoff.url(for: .chinese).absoluteString, "https://852wa.github.io/JIZURA/en/")
    }

    func testLyricsAreCopiedAsWrittenWithTheirMarkup() {
        XCTAssertFalse(JizuraHandoff.acceptsLyricsInURL)
        XCTAssertEqual(JizuraHandoff.lyrics(from: "\n夜明けの色を/覚えてる\n*透明*な風が吹いて!\n\n"), "夜明けの色を/覚えてる\n*透明*な風が吹いて!")
        XCTAssertEqual(JizuraHandoff.templateID, "lyrics")
    }
}
