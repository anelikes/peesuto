import XCTest
@testable import PeesutoKit

final class LocalizationTests: XCTestCase {
    func testLanguageResolution() {
        XCTAssertEqual(UILanguage.resolve("en", preferredLanguages: ["ja-JP"]), .english)
        XCTAssertEqual(UILanguage.resolve("zh-CN", preferredLanguages: ["en-US"]), .chinese)
        XCTAssertEqual(UILanguage.resolve("ja", preferredLanguages: ["zh-Hans-CN"]), .japanese)
        XCTAssertEqual(UILanguage.resolve("system", preferredLanguages: ["ja-JP", "en-US"]), .japanese)
        XCTAssertEqual(UILanguage.resolve("system", preferredLanguages: ["ja"]), .japanese)
        XCTAssertEqual(UILanguage.resolve("system", preferredLanguages: ["zh-Hant-TW"]), .chinese)
        XCTAssertEqual(UILanguage.resolve("system", preferredLanguages: ["fr-FR", "ja-JP"]), .english, "only the first preferred language counts")
        XCTAssertEqual(UILanguage.resolve("system", preferredLanguages: []), .english)
    }

    func testJapaneseLooksUpEnglishAndFallsBackToEnglish() {
        let ja = Localizer(.japanese)
        XCTAssertEqual(ja("Cancel", "取消"), "キャンセル")
        XCTAssertEqual(ja("A string nobody translated", "没有翻译"), "A string nobody translated", "never Chinese")
        XCTAssertEqual(ja("\(3) items", "\(3) 项", ja: "\(3) 件"), "3 件")
        XCTAssertEqual(Localizer(.chinese)("Cancel", "取消"), "取消")
        XCTAssertEqual(Localizer(.english)("Cancel", "取消", ja: "キャンセル"), "Cancel")
    }

    func testSettingAcceptsJapanese() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-l10n-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = try SettingsStore(directory: directory)
        try settings.set("language", value: "ja")
        XCTAssertEqual(try SettingsStore(directory: directory).language, "ja")
        XCTAssertThrowsError(try settings.set("language", value: "ja-JP"))
        XCTAssertEqual(UILanguage.resolve(try SettingsStore(directory: directory).language), .japanese)
    }

    /// Every English string written next to its Chinese one in the Swift
    /// sources, and every template, style and privacy rule name Core sends,
    /// has a Japanese entry; interpolated strings pass `ja:` instead. No entry
    /// is left unused.
    func testJapaneseTableCoversEveryString() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sources = root.appendingPathComponent("Sources")
        let literal = #""((?:[^"\\\n]|\\.)*)""#
        let pair = try NSRegularExpression(pattern: literal + #"\s*,\s*"# + literal + #"(\s*,\s*ja:)?"#)
        let call = try NSRegularExpression(pattern: #"\btr\(\s*""#)
        let cjk = try NSRegularExpression(pattern: #"[\x{3000}-\x{9FFF}\x{FF00}-\x{FFEF}]"#)
        var used = Set<String>(), missing: [String] = [], interpolatedWithoutJapanese: [String] = [], unparsed: [String] = []
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)!
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" && $0.lastPathComponent != "JapaneseStrings.swift" }
        XCTAssertFalse(files.isEmpty)
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let ns = text as NSString
            var position = 0
            // Overlapping: in ("paste-card", "Paste as image", "粘贴为图片") the pair starts at the second literal.
            while let match = pair.firstMatch(in: text, range: NSRange(location: position, length: ns.length - position)) {
                let english = ns.substring(with: match.range(at: 1)), chinese = ns.substring(with: match.range(at: 2))
                guard cjk.firstMatch(in: chinese, range: NSRange(location: 0, length: (chinese as NSString).length)) != nil,
                      cjk.firstMatch(in: english, range: NSRange(location: 0, length: (english as NSString).length)) == nil else {
                    position = match.range(at: 2).location - 1
                    continue
                }
                position = match.range.location + match.range.length
                if english.contains("\\(") {
                    if match.range(at: 3).location == NSNotFound { interpolatedWithoutJapanese.append(english) }
                    continue
                }
                let key = Self.unescape(english)
                used.insert(key)
                if JapaneseStrings.table[key] == nil { missing.append(key) }
            }
            // A tr("…") call the pair pattern cannot read would escape the check.
            for match in call.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let start = match.range.location + match.range.length - 1
                let rest = ns.substring(from: start)
                if let found = pair.firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length)), found.range.location == 0 { continue }
                unparsed.append("\(file.lastPathComponent): " + String(rest.prefix(60)))
            }
        }
        // Names Core sends with English and Chinese only.
        let core = root.deletingLastPathComponent().appendingPathComponent("core/src")
        let coreName = try NSRegularExpression(pattern: #"\b(?:name|description): "((?:[^"\\\n]|\\.)*)""#)
        for path in ["templates/registry.ts", "privacy/rules.ts"] {
            let text = try String(contentsOf: core.appendingPathComponent(path), encoding: .utf8)
            let ns = text as NSString
            let before = used.count
            for match in coreName.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
                let key = Self.unescape(ns.substring(with: match.range(at: 1)))
                used.insert(key)
                if JapaneseStrings.table[key] == nil { missing.append(key) }
            }
            XCTAssertGreaterThan(used.count, before, "no names found in \(path)")
        }
        XCTAssertEqual(missing.sorted(), [], "English strings without Japanese (add them to JapaneseStrings.swift)")
        XCTAssertEqual(interpolatedWithoutJapanese, [], "interpolated strings need tr(_:_:ja:)")
        XCTAssertEqual(unparsed, [], "tr calls the check cannot read")
        XCTAssertEqual(Set(JapaneseStrings.table.keys).subtracting(used).sorted(), [], "unused Japanese entries")
    }

    /// The escapes UI strings use, as the compiler reads them.
    private static func unescape(_ source: String) -> String {
        source.replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\")
    }
}
