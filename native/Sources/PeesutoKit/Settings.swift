import Foundation
import Security

public enum SettingsError: LocalizedError {
    case invalidFile(String), invalidLanguage, secretInConfiguration, keychain(OSStatus), invalidSecretName
    public var errorDescription: String? {
        switch self {
        case .invalidFile(let name): return "Cannot read \(name). Existing settings have been preserved."
        case .invalidLanguage: return "Unsupported interface language."
        case .secretInConfiguration: return "Provider credentials must be stored in Keychain."
        case .keychain(let status): return "Keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))"
        case .invalidSecretName: return "Invalid credential name."
        }
    }
}

/// Shares the legacy JSON files while preserving fields this version does not edit.
/// Read-only construction does not create or rewrite either file.
public final class SettingsStore {
    public static let defaultBlacklist = ["com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.apple.keychainaccess"]
    public let directory: URL
    public private(set) var values: [String: Any]
    public private(set) var providers: [String: Any]
    private let lock = NSRecursiveLock()

    public init(directory: URL) throws {
        self.directory = directory
        values = try Self.read(directory.appendingPathComponent("settings.json"))
        providers = try Self.read(directory.appendingPathComponent("providers.json"))
        Self.providerDefaults(&providers)
    }

    public var language: String { string("language", default: "system") }
    public var hotkey: String { string("hotkey", default: "CmdOrCtrl+Shift+V") }
    public var retentionDays: Int { max(0, integer("retention_days", default: 30)) }
    public var blacklist: [String] { values["blacklist"] as? [String] ?? Self.defaultBlacklist }

    public func string(_ key: String, default fallback: String = "") -> String {
        lock.lock(); defer { lock.unlock() }
        return values[key] as? String ?? fallback
    }
    public func bool(_ key: String, default fallback: Bool = false) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return values[key] as? Bool ?? fallback
    }
    public func integer(_ key: String, default fallback: Int = 0) -> Int {
        lock.lock(); defer { lock.unlock() }
        return values[key] as? Int ?? fallback
    }

    public func set(_ key: String, value: Any) throws {
        try setValues([key: value])
    }

    /// Saves related settings together so shortcut bindings cannot be partially persisted.
    public func setValues(_ updates: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        if let language = updates["language"], !["system", "en", "zh-CN"].contains(language as? String ?? "") { throw SettingsError.invalidLanguage }
        let url = directory.appendingPathComponent("settings.json")
        var next = try Self.read(url)
        for (key, value) in updates { next[key] = value }
        try save(next, to: url)
        values = next
    }

    /// Merges fields within a track, retaining unknown protocol extensions.
    /// Passing NSNull removes an optional field. Changing kind resets the old track's fields.
    public func setProvider(track: String, fields: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        guard ["decider", "generator"].contains(track) else { throw SettingsError.invalidFile("provider track") }
        let url = directory.appendingPathComponent("providers.json")
        var next = try Self.read(url)
        Self.providerDefaults(&next)
        var existing = next[track] as? [String: Any] ?? [:]
        if let kind = fields["kind"] as? String, kind != existing["kind"] as? String { existing = [:] }
        for (key, value) in fields {
            if value is NSNull { existing.removeValue(forKey: key) } else { existing[key] = value }
        }
        next[track] = existing
        try Self.validateNoSecrets(next)
        try save(next, to: url)
        providers = next
    }

    public func setOffline(_ offline: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        let url = directory.appendingPathComponent("providers.json")
        var next = try Self.read(url)
        Self.providerDefaults(&next)
        next["offline"] = offline
        try Self.validateNoSecrets(next)
        try save(next, to: url)
        providers = next
    }

    public func reload() throws {
        lock.lock(); defer { lock.unlock() }
        let nextValues = try Self.read(directory.appendingPathComponent("settings.json"))
        var nextProviders = try Self.read(directory.appendingPathComponent("providers.json"))
        Self.providerDefaults(&nextProviders)
        values = nextValues; providers = nextProviders
    }

    /// Normalizes credential references exactly as the legacy desktop layer did.
    /// Arbitrary account names from a settings file never reach Keychain, and
    /// credentials are returned only in memory for Core's config.set request.
    public func coreConfiguration(secretReader: (String) throws -> String? = { try KeychainSecrets.read(name: $0) }) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var secrets: [String: String] = [:]
        var normalized = providers
        for track in ["decider", "generator"] {
            var config = providers[track] as? [String: Any] ?? ["kind": track == "decider" ? "rules" : "none"]
            let kind = config["kind"] as? String ?? "none"
            // Preserve future noncredential options, but never forward a raw
            // credential or an unrecognized reference to a Keychain account.
            config = config.filter { key, _ in
                !key.hasSuffix("Ref") && !["token", "apikey", "api_key", "secret", "secrets", "password"].contains(key.lowercased())
            }
            let credential: (field: String, account: String, required: Bool)?
            switch (track, kind) {
            case ("decider", "proxy"):
                credential = ("tokenRef", KeychainSecrets.proxyTokenName, false)
            case ("decider", "cloudflare"):
                credential = ("tokenRef", KeychainSecrets.cloudflareTokenName, true)
            case (_, "hosted"):
                credential = ("tokenRef", KeychainSecrets.hostedTokenName, true)
            case ("generator", "openai-compatible"):
                credential = ("apiKeyRef", KeychainSecrets.generatorKeyName, false)
            case ("generator", "anthropic"):
                credential = ("apiKeyRef", KeychainSecrets.generatorKeyName, true)
            default: credential = nil
            }
            if let credential {
                if let secret = try (secrets[credential.account] ?? secretReader(credential.account)), !secret.isEmpty {
                    secrets[credential.account] = secret
                    config[credential.field] = credential.account
                } else if credential.required {
                    // Core reports the missing required credential itself.
                    config[credential.field] = credential.account
                }
            }
            normalized[track] = config
        }
        // Privacy rules and precompose travel with every configuration so a
        // restarted Core never runs with defaults the user turned off.
        normalized["privacy"] = PrivacySettings(json: values["privacy"]).payload
        normalized["precompose"] = PrecomposeSettings(json: values["precompose"]).payload
        normalized["cmd"] = "config.set"
        normalized["secrets"] = secrets
        normalized["egressLog"] = directory.appendingPathComponent("egress.log").path
        return normalized
    }

    private static func providerDefaults(_ dictionary: inout [String: Any]) {
        if dictionary["decider"] == nil { dictionary["decider"] = ["kind": "rules"] }
        if dictionary["generator"] == nil { dictionary["generator"] = ["kind": "none"] }
        if dictionary["offline"] == nil { dictionary["offline"] = false }
    }
    private static func read(_ url: URL) throws -> [String: Any] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        do {
            guard let dictionary = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw SettingsError.invalidFile(url.lastPathComponent) }
            return dictionary
        } catch { throw SettingsError.invalidFile(url.lastPathComponent) }
    }
    private func save(_ dictionary: [String: Any], to url: URL) throws {
        guard JSONSerialization.isValidJSONObject(dictionary) else { throw SettingsError.invalidFile(url.lastPathComponent) }
        let data = try JSONSerialization.data(withJSONObject: dictionary, options: [.prettyPrinted, .sortedKeys])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private static func validateNoSecrets(_ object: Any) throws {
        if let dictionary = object as? [String: Any] {
            for (key, value) in dictionary {
                guard !["token", "apikey", "api_key", "secret", "secrets", "password"].contains(key.lowercased()) else { throw SettingsError.secretInConfiguration }
                try validateNoSecrets(value)
            }
        } else if let array = object as? [Any] { for value in array { try validateNoSecrets(value) } }
    }
}

public enum KeychainSecrets {
    public static let service = "com.peesuto.desktop"
    public static let historyKeyName = "pocket-paste/history-key"
    public static let generatorKeyName = "pocket-paste/generator"
    public static let proxyTokenName = "pocket-paste/proxy"
    public static let cloudflareTokenName = "pocket-paste/cloudflare"
    public static let hostedTokenName = "pocket-paste/hosted"

    private static func query(name: String) throws -> [String: Any] {
        guard !name.isEmpty, name.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45, 46, 47, 95].contains($0) }) else {
            throw SettingsError.invalidSecretName
        }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    public static func read(name: String) throws -> String? {
        var query = try query(name: name)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SettingsError.keychain(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw SettingsError.keychain(errSecDecode) }
        return value
    }

    /// Matches legacy semantics: an empty credential removes the item.
    public static func write(name: String, value: String) throws {
        let query = try query(name: name)
        if value.isEmpty {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw SettingsError.keychain(status) }
            return
        }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SettingsError.keychain(status) }
    }

    /// Explicit "Start fresh" only: replaces the history key after the locked
    /// history was moved aside. Never called automatically.
    public static func replaceHistoryKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw SettingsError.keychain(status) }
        let key = Data(bytes)
        try write(name: historyKeyName, value: key.base64EncodedString())
        return key
    }

    /// A missing or invalid key with existing history is always a locked state, never a reset.
    public static func historyKey(directory: URL) throws -> Data {
        if let encoded = try read(name: historyKeyName) {
            guard let key = Data(base64Encoded: encoded), key.count == 32 else { throw StorageError.locked }
            return key
        }
        guard !FileManager.default.fileExists(atPath: directory.appendingPathComponent("history.sqlite").path) else { throw StorageError.locked }
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw SettingsError.keychain(status) }
        let key = Data(bytes)
        // Add only: never overwrite a key concurrently created by another app process.
        var attributes = try query(name: historyKeyName)
        attributes[kSecValueData as String] = Data(key.base64EncodedString().utf8)
        let added = SecItemAdd(attributes as CFDictionary, nil)
        if added == errSecDuplicateItem {
            guard let encoded = try read(name: historyKeyName), let existing = Data(base64Encoded: encoded), existing.count == 32 else { throw StorageError.locked }
            return existing
        }
        guard added == errSecSuccess else { throw SettingsError.keychain(added) }
        return key
    }
}
