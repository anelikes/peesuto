import XCTest
import CryptoKit
import CoreGraphics
import ImageIO
import CSQLite
@testable import PeesutoKit

final class StorageTests: XCTestCase {
    private var directory: URL!
    private let key = Data(repeating: 0, count: 32)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-storage-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    func testLegacyAES256GCMFormatWithKnownVector() throws {
        // NIST AES-256-GCM: zero key, 96-bit zero IV, 16 zero plaintext bytes.
        // Rust aes_gcm::Aead emits ciphertext + tag, with the nonce prepended by store.rs.
        let fixture = hex("000000000000000000000000cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919")
        XCTAssertEqual(try HistoryCipher.open(fixture, key: SymmetricKey(data: key)), Data(repeating: 0, count: 16))
        var corrupt = fixture; corrupt[20] ^= 1
        XCTAssertThrowsError(try HistoryCipher.open(corrupt, key: SymmetricKey(data: key)))
    }

    func testOpensExistingRustSchemaAndRejectsWrongKeyWithoutChangingRows() throws {
        let fixture = "000000000000000000000000cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919"
        try sql("""
            CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text BLOB, preview BLOB NOT NULL,
            app_bundle_id TEXT, app_name TEXT, types TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, image_path TEXT, image_w INTEGER, image_h INTEGER);
            INSERT INTO items VALUES ('legacy','text',X'\(fixture)',X'\(fixture)','com.example.editor','Editor','html,rtf',1234,1,16,NULL,NULL,NULL);
            """)
        XCTAssertThrowsError(try HistoryStore(directory: directory, key: Data(repeating: 1, count: 32))) { error in
            guard case StorageError.locked = error else { return XCTFail("Expected locked, got \(error)") }
        }
        let store = try HistoryStore(directory: directory, key: key)
        let records = try store.list()
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records[0].text, String(repeating: "\0", count: 16))
        XCTAssertEqual(records[0].sourceApp, "Editor")
        XCTAssertEqual(records[0].appBundleID, "com.example.editor")
        XCTAssertEqual(records[0].types, ["html", "rtf"])
        XCTAssertTrue(records[0].pinned)
        try store.insert(text: "Swift entry", sourceApp: "com.example.editor")
        XCTAssertEqual(try store.list().count, 2)
    }

    func testHistoryDeduplicationSearchPinsAndRetention() throws {
        let store = try HistoryStore(directory: directory, key: key)
        try store.insert(text: "  Hello   世界\nsecond line", appBundleID: "com.example.editor", appName: "Editor")
        let first = try XCTUnwrap(store.list().first)
        XCTAssertEqual(first.preview, "Hello 世界")
        try store.setPinned(id: first.id, pinned: true)
        try store.insert(text: "Another item", sourceApp: nil)
        try store.insert(text: "  Hello   世界\nsecond line", sourceApp: "com.other.editor")
        XCTAssertEqual(try store.list().count, 2)
        XCTAssertEqual(try store.list().first?.id, first.id)
        XCTAssertEqual(try store.list(query: "HELLO").first?.text, first.text)
        XCTAssertTrue(try store.list(query: "absent").isEmpty)
        try sql("UPDATE items SET created_at=1")
        try store.prune(days: 1)
        XCTAssertEqual(try store.list().map(\.id), [first.id])
        try store.setPinned(id: first.id, pinned: false)
        try store.prune(days: 0)
        XCTAssertEqual(try store.list().count, 1)
        try store.prune(days: 1)
        XCTAssertTrue(try store.list().isEmpty)
    }

    func testTextNeverAppearsInSQLiteAndCiphertextIsAuthenticated() throws {
        var store: HistoryStore? = try HistoryStore(directory: directory, key: key)
        let secret = "private clipboard content 123456 中文"
        try store?.insert(text: secret, sourceApp: nil)
        store = nil
        let bytes = try Data(contentsOf: directory.appendingPathComponent("history.sqlite"))
        XCTAssertNil(bytes.range(of: Data(secret.utf8)))
        XCTAssertThrowsError(try HistoryStore(directory: directory, key: Data(repeating: 5, count: 32)))
        let reopened = try HistoryStore(directory: directory, key: key)
        XCTAssertEqual(try reopened.list().first?.text, secret)
    }

    func testFileCopiesKeepLegacyPathsAndDeduplicateWithoutBecomingText() throws {
        let store = try HistoryStore(directory: directory, key: key)
        let urls = [URL(fileURLWithPath: "/synthetic/示例 a.txt"), URL(fileURLWithPath: "/synthetic/b.png")]
        try store.insertFiles(urls: urls, sourceApp: "com.apple.finder")
        try store.insertFiles(urls: urls, sourceApp: "com.apple.finder")
        let file = try XCTUnwrap(store.list().first)
        XCTAssertEqual(try store.list().count, 1)
        XCTAssertEqual(file.kind, "file")
        XCTAssertEqual(file.text, "/synthetic/示例 a.txt\n/synthetic/b.png")
        XCTAssertEqual(file.types, ["file-url"])
        try store.insert(text: try XCTUnwrap(file.text), sourceApp: nil)
        XCTAssertEqual(try store.list().count, 2)
        XCTAssertEqual(Set(try store.list().map(\.kind)), ["file", "text"])
        XCTAssertEqual(try HistoryStore(directory: directory, key: key).list().count, 2)
    }

    func testImageFilesAndThumbnailsUseLegacyNamesAndEncryption() throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        let fixture = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(fixture, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let png = fixture as Data
        let store = try HistoryStore(directory: directory, key: key)
        try store.insertImage(data: png, sourceApp: "com.example.image")
        let item = try XCTUnwrap(store.list().first)
        XCTAssertEqual(item.kind, "image")
        XCTAssertEqual(item.image?.width, 1)
        XCTAssertEqual(item.preview, "Image 1×1")
        let file = directory.appendingPathComponent("images/\(item.id).bin")
        let encrypted = try Data(contentsOf: file)
        XCTAssertNotEqual(encrypted.prefix(8), png.prefix(8))
        let decoded = try XCTUnwrap(store.imageData(id: item.id))
        XCTAssertEqual(Array(decoded.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        XCTAssertNotNil(try store.thumbnailData(id: item.id))
        XCTAssertThrowsError(try store.imageData(id: "../history.sqlite"))
        try store.delete(id: item.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertTrue(try store.list().isEmpty)
    }

    func testSettingsPreserveUnknownFieldsAndKeepSecretsOutOfFiles() throws {
        try Data(#"{"language":"zh-CN","retention_days":14,"future":{"enabled":true}}"#.utf8)
            .write(to: directory.appendingPathComponent("settings.json"))
        try Data(#"{"decider":{"kind":"rules"},"generator":{"kind":"openai-compatible","baseUrl":"http://localhost:11434/v1","model":"local","apiKeyRef":"pocket-paste/generator","futureOption":12},"futureRoot":"preserve"}"#.utf8)
            .write(to: directory.appendingPathComponent("providers.json"))
        let settings = try SettingsStore(directory: directory)
        XCTAssertEqual(settings.language, "zh-CN")
        XCTAssertEqual(settings.retentionDays, 14)
        try settings.set("language", value: "en")
        try settings.setProvider(track: "generator", fields: ["model": "new"])
        try settings.setOffline(true)
        let reopened = try SettingsStore(directory: directory)
        XCTAssertEqual((reopened.values["future"] as? [String: Bool])?["enabled"], true)
        XCTAssertEqual(reopened.providers["futureRoot"] as? String, "preserve")
        XCTAssertEqual((reopened.providers["generator"] as? [String: Any])?["futureOption"] as? Int, 12)
        let configured = try reopened.coreConfiguration { name in name == "pocket-paste/generator" ? "synthetic-secret" : nil }
        XCTAssertEqual((configured["secrets"] as? [String: String])?["pocket-paste/generator"], "synthetic-secret")
        XCTAssertEqual(configured["offline"] as? Bool, true)
        XCTAssertThrowsError(try settings.setProvider(track: "generator", fields: ["apiKey": "do-not-write"]))
        let contents = try String(contentsOf: directory.appendingPathComponent("providers.json"))
        XCTAssertFalse(contents.contains("synthetic-secret"))
        XCTAssertFalse(contents.contains("do-not-write"))
        XCTAssertThrowsError(try settings.set("language", value: "unsupported"))
        XCTAssertEqual(try SettingsStore(directory: directory).language, "en")
    }

    func testMalformedSettingsAreNeverOverwritten() throws {
        let file = directory.appendingPathComponent("settings.json")
        let original = Data("malformed settings".utf8)
        try original.write(to: file)
        XCTAssertThrowsError(try SettingsStore(directory: directory))
        XCTAssertEqual(try Data(contentsOf: file), original)
    }

    func testCoreConfigurationNeverReadsArbitraryKeychainReferences() throws {
        let original = Data(#"{"decider":{"kind":"proxy","url":"https://example.invalid","tokenRef":"pocket-paste/history-key","otherRef":"another-account","futureFlag":true},"generator":{"kind":"openai-compatible","model":"m","baseUrl":"https://example.invalid","apiKeyRef":"pocket-paste/history-key","futureOption":12},"futureRoot":"keep"}"#.utf8)
        let file = directory.appendingPathComponent("providers.json")
        try original.write(to: file)
        let settings = try SettingsStore(directory: directory)
        var requested: [String] = []
        let configuration = try settings.coreConfiguration { account in
            requested.append(account)
            return "canonical-credential"
        }
        XCTAssertEqual(requested, ["pocket-paste/proxy", "pocket-paste/generator"])
        let decider = try XCTUnwrap(configuration["decider"] as? [String: Any])
        let generator = try XCTUnwrap(configuration["generator"] as? [String: Any])
        XCTAssertEqual(decider["tokenRef"] as? String, "pocket-paste/proxy")
        XCTAssertNil(decider["otherRef"])
        XCTAssertEqual(decider["futureFlag"] as? Bool, true)
        XCTAssertEqual(generator["apiKeyRef"] as? String, "pocket-paste/generator")
        XCTAssertEqual(generator["futureOption"] as? Int, 12)
        XCTAssertEqual(configuration["futureRoot"] as? String, "keep")
        XCTAssertEqual(try Data(contentsOf: file), original)
        let noKeys = try settings.coreConfiguration { _ in nil }
        XCTAssertNil((noKeys["decider"] as? [String: Any])?["tokenRef"])
        XCTAssertNil((noKeys["generator"] as? [String: Any])?["apiKeyRef"])
    }

    func testCoreConfigurationRestoresCanonicalRefsAfterKindSwitchWithoutStoringCredentials() throws {
        let settings = try SettingsStore(directory: directory)
        try settings.setProvider(track: "generator", fields: ["kind": "openai-compatible", "baseUrl": "https://example.invalid", "model": "m"])
        let withKey = try settings.coreConfiguration { $0 == "pocket-paste/generator" ? "synthetic-only" : nil }
        XCTAssertEqual((withKey["generator"] as? [String: Any])?["apiKeyRef"] as? String, "pocket-paste/generator")
        try settings.setProvider(track: "generator", fields: ["kind": "none"])
        let local = try settings.coreConfiguration { _ in XCTFail("Local providers must not read Keychain"); return nil }
        XCTAssertEqual((local["secrets"] as? [String: String])?.count, 0)
        XCTAssertNil((local["generator"] as? [String: Any])?["baseUrl"])
        try settings.setProvider(track: "generator", fields: ["kind": "anthropic"])
        let missing = try settings.coreConfiguration { _ in nil }
        XCTAssertEqual((missing["generator"] as? [String: Any])?["apiKeyRef"] as? String, "pocket-paste/generator")
        XCTAssertEqual((missing["secrets"] as? [String: String])?.count, 0)
        XCTAssertFalse(try String(contentsOf: directory.appendingPathComponent("providers.json")).contains("synthetic-only"))
    }

    func testProviderMergeRemovalAndKindSwitch() throws {
        let settings = try SettingsStore(directory: directory)
        try settings.setProvider(track: "decider", fields: ["kind": "laya", "url": "http://localhost:8790", "futureFlag": true])
        try settings.setProvider(track: "decider", fields: ["url": NSNull()])
        XCTAssertNil((settings.providers["decider"] as? [String: Any])?["url"])
        XCTAssertEqual((settings.providers["decider"] as? [String: Any])?["futureFlag"] as? Bool, true)
        try settings.setProvider(track: "decider", fields: ["kind": "rules"])
        XCTAssertEqual((settings.providers["decider"] as? [String: String]), ["kind": "rules"])
    }

    private func hex(_ value: String) -> Data {
        Data(stride(from: 0, to: value.count, by: 2).map { offset in
            let start = value.index(value.startIndex, offsetBy: offset)
            return UInt8(value[start..<value.index(start, offsetBy: 2)], radix: 16)!
        })
    }
    private func sql(_ query: String) throws {
        var connection: OpaquePointer?
        guard sqlite3_open(directory.appendingPathComponent("history.sqlite").path, &connection) == SQLITE_OK else { throw StorageError.database("Test open failed") }
        defer { sqlite3_close(connection) }
        guard sqlite3_exec(connection, query, nil, nil, nil) == SQLITE_OK else { throw StorageError.database(String(cString: sqlite3_errmsg(connection))) }
    }
}
