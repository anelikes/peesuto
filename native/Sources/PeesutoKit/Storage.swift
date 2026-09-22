import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import CSQLite

public struct ClipRecord: Identifiable, Codable, Equatable {
    public let id: String
    public let kind: String
    public let text: String?
    public let preview: String
    public let sourceApp: String?
    public let createdAt: Int64
    public let pinned: Bool
    public var appBundleID: String?
    public var appName: String?
    public var bytes: Int64
    public var types: [String]
    public var image: ImageSize?

    public struct ImageSize: Codable, Equatable {
        public let width: Int
        public let height: Int
        public init(width: Int, height: Int) { self.width = width; self.height = height }
    }

    public init(id: String, kind: String, text: String?, preview: String, sourceApp: String?, createdAt: Int64, pinned: Bool,
                appBundleID: String? = nil, appName: String? = nil, bytes: Int64 = 0, types: [String] = [], image: ImageSize? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.preview = preview
        self.sourceApp = sourceApp; self.createdAt = createdAt; self.pinned = pinned
        self.appBundleID = appBundleID; self.appName = appName; self.bytes = bytes; self.types = types; self.image = image
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, text, preview, sourceApp, createdAt, pinned, appName, bytes, types, image
        case appBundleID = "appBundleId"
    }
}

public enum StorageError: LocalizedError {
    case locked, invalidKey, database(String), invalidImage, invalidIdentifier
    public var errorDescription: String? {
        switch self {
        case .locked: return "History is locked. Its encryption key is missing or does not match."
        case .invalidKey: return "The history encryption key must contain 32 bytes."
        case .database(let detail): return "History database: \(detail)"
        case .invalidImage: return "The clipboard image could not be decoded."
        case .invalidIdentifier: return "Invalid history item identifier."
        }
    }
}

/// Compatible with Rust's nonce (12 bytes) + AES-256-GCM ciphertext + tag (16 bytes).
enum HistoryCipher {
    static func seal(_ data: Data, key: SymmetricKey) throws -> Data {
        guard let combined = try AES.GCM.seal(data, using: key).combined else { throw StorageError.invalidKey }
        return combined
    }
    static func open(_ data: Data, key: SymmetricKey) throws -> Data {
        do { return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key) }
        catch { throw StorageError.locked }
    }
}

/// Serializes SQLite access. No plaintext content is stored in the database or image files.
public final class HistoryStore {
    private var db: OpaquePointer?
    private let key: SymmetricKey
    private let images: URL
    private let lock = NSRecursiveLock()
    private let columns = "id,kind,text,preview,app_bundle_id,app_name,types,created_at,pinned,bytes,image_path,image_w,image_h"
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(directory: URL, key: Data) throws {
        guard key.count == 32 else { throw StorageError.invalidKey }
        self.key = SymmetricKey(data: key)
        images = directory.appendingPathComponent("images", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("history.sqlite").path
        let exists = FileManager.default.fileExists(atPath: path)
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            let error = StorageError.database(db.map { String(cString: sqlite3_errmsg($0)) } ?? "Cannot open database")
            sqlite3_close(db); db = nil; throw error
        }
        do {
            sqlite3_busy_timeout(db, 3_000)
            // Authenticate existing data before changing the database or allowing writes.
            if exists {
                let stmt = try prepare("SELECT text,preview FROM items")
                defer { sqlite3_finalize(stmt) }
                while try step(stmt) {
                    if let text = blob(stmt, 0) { _ = try HistoryCipher.open(text, key: self.key) }
                    guard let preview = blob(stmt, 1) else { throw StorageError.locked }
                    _ = try HistoryCipher.open(preview, key: self.key)
                }
            }
            try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            try execute("""
                CREATE TABLE IF NOT EXISTS items (
                  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text BLOB, preview BLOB NOT NULL,
                  app_bundle_id TEXT, app_name TEXT, types TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
                  bytes INTEGER NOT NULL DEFAULT 0, image_path TEXT, image_w INTEGER, image_h INTEGER
                );
                CREATE INDEX IF NOT EXISTS items_created ON items(created_at DESC);
                """)
            try FileManager.default.createDirectory(at: images, withIntermediateDirectories: true)
        } catch {
            sqlite3_close(db); db = nil; throw error
        }
    }

    deinit { sqlite3_close(db) }

    public func list(query: String = "", limit: Int = 100) throws -> [ClipRecord] {
        lock.lock(); defer { lock.unlock() }
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let stmt = try prepare("SELECT \(columns) FROM items ORDER BY pinned DESC,created_at DESC LIMIT ?")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(query.isEmpty ? max(0, limit) : 500))
        var result: [ClipRecord] = []
        while try step(stmt) {
            let record = try row(stmt)
            if query.isEmpty || record.preview.localizedCaseInsensitiveContains(query) || record.text?.localizedCaseInsensitiveContains(query) == true {
                result.append(record)
            }
        }
        return Array(result.prefix(max(0, limit)))
    }

    public func insert(text: String, sourceApp: String?) throws {
        try insert(text: text, appBundleID: sourceApp, appName: nil)
    }

    public func insert(text: String, appBundleID: String?, appName: String?) throws {
        try insertText(text, kind: "text", appBundleID: appBundleID, appName: appName)
    }

    /// Legacy file items store newline-separated filesystem paths, not file:// URLs.
    public func insertFiles(urls: [URL], sourceApp: String?) throws {
        let files = urls.filter(\.isFileURL).map(\.path)
        guard !files.isEmpty else { return }
        try insertText(files.joined(separator: "\n"), kind: "file", appBundleID: sourceApp, appName: nil)
    }

    private func insertText(_ text: String, kind: String, appBundleID: String?, appName: String?) throws {
        lock.lock(); defer { lock.unlock() }
        guard !text.isEmpty else { return }
        let stmt = try prepare("SELECT id,text FROM items WHERE kind=? AND bytes=?")
        defer { sqlite3_finalize(stmt) }
        bind(kind, to: stmt, at: 1)
        sqlite3_bind_int64(stmt, 2, Int64(text.utf8.count))
        var duplicate: String?
        while try step(stmt) {
            if let data = blob(stmt, 1), try HistoryCipher.open(data, key: key) == Data(text.utf8) {
                duplicate = string(stmt, 0); break
            }
        }
        if let duplicate {
            let update = try prepare("UPDATE items SET created_at=?,app_bundle_id=COALESCE(app_bundle_id,?),app_name=COALESCE(app_name,?) WHERE id=?")
            defer { sqlite3_finalize(update) }
            sqlite3_bind_int64(update, 1, now())
            bind(appBundleID, to: update, at: 2); bind(appName, to: update, at: 3); bind(duplicate, to: update, at: 4)
            _ = try step(update)
            return
        }
        let first = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        let collapsed = first.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let preview = String(collapsed.prefix(160)) + (collapsed.count > 160 ? "…" : "")
        try add(id: newID(), kind: kind, text: text, preview: preview, appBundleID: appBundleID, appName: appName,
                bytes: text.utf8.count, width: nil, height: nil)
        try trim()
    }

    public func insertImage(data: Data, sourceApp: String?) throws {
        lock.lock(); defer { lock.unlock() }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw StorageError.invalidImage }
        let png = try pngData(image)
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                       kCGImageSourceThumbnailMaxPixelSize: 256,
                                       kCGImageSourceCreateThumbnailWithTransform: true]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw StorageError.invalidImage }
        let id = newID()
        do {
            try HistoryCipher.seal(png, key: key).write(to: imageURL(id: id), options: .atomic)
            try HistoryCipher.seal(pngData(thumbnail), key: key).write(to: imageURL(id: id, thumbnail: true), options: .atomic)
            try add(id: id, kind: "image", text: nil, preview: "Image \(image.width)×\(image.height)", appBundleID: sourceApp,
                    appName: nil, bytes: png.count, width: image.width, height: image.height)
        } catch { removeImages(id: id); throw error }
        try trim()
    }

    public func delete(id: String) throws {
        lock.lock(); defer { lock.unlock() }
        try validateID(id)
        let stmt = try prepare("DELETE FROM items WHERE id=?")
        defer { sqlite3_finalize(stmt) }
        bind(id, to: stmt, at: 1); _ = try step(stmt)
        removeImages(id: id)
    }

    public func setPinned(id: String, pinned: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        let stmt = try prepare("UPDATE items SET pinned=? WHERE id=?")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, pinned ? 1 : 0); bind(id, to: stmt, at: 2); _ = try step(stmt)
    }

    public func imageData(id: String) throws -> Data? { try readImage(id: id, thumbnail: false) }
    public func thumbnailData(id: String) throws -> Data? { try readImage(id: id, thumbnail: true) }

    public func prune(days: Int) throws {
        guard days > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        let stmt = try prepare("SELECT id FROM items WHERE pinned=0 AND created_at<?")
        defer { sqlite3_finalize(stmt) }
        let interval = Int64(min(days, 100_000)) * 86_400_000
        sqlite3_bind_int64(stmt, 1, now() - interval)
        var ids: [String] = []
        while try step(stmt) { if let id = string(stmt, 0) { ids.append(id) } }
        for id in ids { try delete(id: id) }
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        try execute("DELETE FROM items;")
        for file in try FileManager.default.contentsOfDirectory(at: images, includingPropertiesForKeys: nil) where file.pathExtension == "bin" {
            try FileManager.default.removeItem(at: file)
        }
        try execute("VACUUM;")
    }

    private func add(id: String, kind: String, text: String?, preview: String, appBundleID: String?, appName: String?, bytes: Int, width: Int?, height: Int?) throws {
        let stmt = try prepare("INSERT INTO items (\(columns)) VALUES (?,?,?,?,?,?,?, ?,0,?,?,?,?)")
        defer { sqlite3_finalize(stmt) }
        bind(id, to: stmt, at: 1); bind(kind, to: stmt, at: 2)
        try bind(text.map { try HistoryCipher.seal(Data($0.utf8), key: key) }, to: stmt, at: 3)
        try bind(HistoryCipher.seal(Data(preview.utf8), key: key), to: stmt, at: 4)
        bind(appBundleID, to: stmt, at: 5); bind(appName, to: stmt, at: 6)
        bind(kind == "image" ? "image" : kind == "file" ? "file-url" : "", to: stmt, at: 7)
        sqlite3_bind_int64(stmt, 8, now()); sqlite3_bind_int64(stmt, 9, Int64(bytes))
        bind(kind == "image" ? "\(id).bin" : nil, to: stmt, at: 10)
        if let width { sqlite3_bind_int64(stmt, 11, Int64(width)) } else { sqlite3_bind_null(stmt, 11) }
        if let height { sqlite3_bind_int64(stmt, 12, Int64(height)) } else { sqlite3_bind_null(stmt, 12) }
        _ = try step(stmt)
    }

    private func trim() throws {
        let stmt = try prepare("SELECT id FROM items WHERE pinned=0 ORDER BY created_at ASC LIMIT MAX(0,(SELECT COUNT(*) FROM items)-500)")
        defer { sqlite3_finalize(stmt) }
        var ids: [String] = []
        while try step(stmt) { if let id = string(stmt, 0) { ids.append(id) } }
        for id in ids { try delete(id: id) }
    }

    private func row(_ stmt: OpaquePointer) throws -> ClipRecord {
        func decrypted(_ index: Int32) throws -> String? {
            guard let data = blob(stmt, index) else { return nil }
            guard let text = String(data: try HistoryCipher.open(data, key: key), encoding: .utf8) else { throw StorageError.locked }
            return text
        }
        let appID = string(stmt, 4), name = string(stmt, 5)
        return try ClipRecord(id: string(stmt, 0) ?? "", kind: string(stmt, 1) ?? "text", text: decrypted(2),
                              preview: decrypted(3) ?? "", sourceApp: name ?? appID, createdAt: sqlite3_column_int64(stmt, 7),
                              pinned: sqlite3_column_int(stmt, 8) != 0, appBundleID: appID, appName: name,
                              bytes: sqlite3_column_int64(stmt, 9), types: (string(stmt, 6) ?? "").split(separator: ",").map(String.init),
                              image: sqlite3_column_type(stmt, 11) == SQLITE_NULL ? nil : .init(width: Int(sqlite3_column_int(stmt, 11)), height: Int(sqlite3_column_int(stmt, 12))))
    }

    private func pngData(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw StorageError.invalidImage }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw StorageError.invalidImage }
        return data as Data
    }
    private func readImage(id: String, thumbnail: Bool) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        try validateID(id)
        let url = imageURL(id: id, thumbnail: thumbnail)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try HistoryCipher.open(Data(contentsOf: url), key: key)
    }
    private func imageURL(id: String, thumbnail: Bool = false) -> URL { images.appendingPathComponent("\(id)\(thumbnail ? ".thumb" : "").bin") }
    private func removeImages(id: String) {
        guard (try? validateID(id)) != nil else { return }
        try? FileManager.default.removeItem(at: imageURL(id: id))
        try? FileManager.default.removeItem(at: imageURL(id: id, thumbnail: true))
    }
    private func validateID(_ id: String) throws {
        guard !id.isEmpty, id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else { throw StorageError.invalidIdentifier }
    }
    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
    private func newID() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    private func prepare(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw failure() }
        return stmt
    }
    private func execute(_ sql: String) throws { guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw failure() } }
    private func step(_ stmt: OpaquePointer) throws -> Bool {
        let status = sqlite3_step(stmt)
        if status == SQLITE_ROW { return true }
        guard status == SQLITE_DONE else { throw failure() }
        return false
    }
    private func failure() -> StorageError { .database(String(cString: sqlite3_errmsg(db))) }
    private func string(_ stmt: OpaquePointer, _ index: Int32) -> String? {
        sqlite3_column_text(stmt, index).map { String(cString: $0) }
    }
    private func blob(_ stmt: OpaquePointer, _ index: Int32) -> Data? {
        guard sqlite3_column_type(stmt, index) != SQLITE_NULL else { return nil }
        guard let bytes = sqlite3_column_blob(stmt, index) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(stmt, index)))
    }
    private func bind(_ string: String?, to stmt: OpaquePointer, at index: Int32) {
        if let string { sqlite3_bind_text(stmt, index, string, -1, transient) } else { sqlite3_bind_null(stmt, index) }
    }
    private func bind(_ data: Data?, to stmt: OpaquePointer, at index: Int32) {
        if let data { _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32($0.count), transient) } }
        else { sqlite3_bind_null(stmt, index) }
    }
}
