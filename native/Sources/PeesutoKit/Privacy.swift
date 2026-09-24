import Foundation

// Model-content privacy rules and background precompose (core ⇄ native
// contract "precompose + model-content privacy rules").
//
// settings.json keys (both optional; absent = defaults):
//   "privacy":    { "modelContent": "raw" | "redacted" | "structure",
//                   "builtins": { "<ruleId>": Bool },
//                   "rules": [ { "id", "name", "match": "text" | "keywords" | "regex",
//                                "pattern", "replacement", "caseSensitive", "wholeWord",
//                                "alsoInOutput", "enabled" } ] }
//   "precompose": { "outputs": ["image" | "gif" | "video"], "useModel": Bool, "skipSecrets": Bool }
// Both are stored in exactly the shape `config.set` takes, and forwarded as is.

/// A user-defined replacement rule. `keywords` patterns hold one keyword per line.
public struct PrivacyRule: Codable, Identifiable, Equatable, Sendable {
    public static let matchKinds = ["text", "keywords", "regex"]
    public static let maxRules = 100
    public static let maxPatternLength = 500
    public static let maxReplacementLength = 100

    public var id: String
    public var name: String
    public var match: String
    public var pattern: String
    public var replacement: String
    public var caseSensitive: Bool
    public var wholeWord: Bool
    public var alsoInOutput: Bool
    public var enabled: Bool

    public init(id: String = UUID().uuidString.lowercased(), name: String = "", match: String = "text",
                pattern: String = "", replacement: String = "", caseSensitive: Bool = false,
                wholeWord: Bool = false, alsoInOutput: Bool = false, enabled: Bool = true) {
        self.id = id; self.name = name; self.match = match; self.pattern = pattern
        self.replacement = replacement; self.caseSensitive = caseSensitive; self.wholeWord = wholeWord
        self.alsoInOutput = alsoInOutput; self.enabled = enabled
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        let kind = try c.decodeIfPresent(String.self, forKey: .match) ?? "text"
        match = Self.matchKinds.contains(kind) ? kind : "text"
        pattern = try c.decodeIfPresent(String.self, forKey: .pattern) ?? ""
        replacement = try c.decodeIfPresent(String.self, forKey: .replacement) ?? ""
        caseSensitive = try c.decodeIfPresent(Bool.self, forKey: .caseSensitive) ?? false
        wholeWord = try c.decodeIfPresent(Bool.self, forKey: .wholeWord) ?? false
        alsoInOutput = try c.decodeIfPresent(Bool.self, forKey: .alsoInOutput) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    public enum ValidationProblem: Equatable, Sendable {
        case emptyPattern, patternTooLong, replacementTooLong, invalidRegex
    }

    /// Local checks mirroring Core's limits. A regex that Foundation rejects
    /// is refused here so an invalid rule never reaches `config.set` (a
    /// rejected configuration would keep Core from starting).
    public var problem: ValidationProblem? {
        if pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .emptyPattern }
        if pattern.count > Self.maxPatternLength { return .patternTooLong }
        if replacement.count > Self.maxReplacementLength { return .replacementTooLong }
        if match == "regex", (try? NSRegularExpression(pattern: pattern)) == nil { return .invalidRegex }
        return nil
    }

    var payload: [String: Any] {
        ["id": id, "name": name, "match": match, "pattern": pattern, "replacement": replacement,
         "caseSensitive": caseSensitive, "wholeWord": wholeWord, "alsoInOutput": alsoInOutput, "enabled": enabled]
    }
}

public struct PrivacySettings: Equatable, Sendable {
    public static let modelContentModes = ["raw", "redacted", "structure"]
    public var modelContent: String
    public var builtins: [String: Bool]
    public var rules: [PrivacyRule]

    public init(modelContent: String = "redacted", builtins: [String: Bool] = [:], rules: [PrivacyRule] = []) {
        self.modelContent = modelContent; self.builtins = builtins; self.rules = rules
    }

    public init(json: Any?) {
        let dictionary = json as? [String: Any] ?? [:]
        let mode = dictionary["modelContent"] as? String ?? "redacted"
        modelContent = Self.modelContentModes.contains(mode) ? mode : "redacted"
        builtins = dictionary["builtins"] as? [String: Bool] ?? [:]
        let raw = dictionary["rules"] as? [Any] ?? []
        rules = raw.compactMap { entry in
            guard JSONSerialization.isValidJSONObject(entry),
                  let data = try? JSONSerialization.data(withJSONObject: entry) else { return nil }
            return try? JSONDecoder().decode(PrivacyRule.self, from: data)
        }
    }

    /// The `privacy` object of `config.set`, also what settings.json stores.
    public var payload: [String: Any] {
        ["modelContent": modelContent, "builtins": builtins, "rules": rules.map(\.payload)]
    }

    public func isEnabled(builtin id: String) -> Bool {
        builtins[id] ?? PrivacyBuiltins.defaultEnabled(id)
    }
}

public struct PrecomposeSettings: Equatable, Sendable {
    public static let outputKinds = ["image", "gif", "video"]
    public var outputs: [String]
    public var useModel: Bool
    public var skipSecrets: Bool

    public init(outputs: [String] = [], useModel: Bool = false, skipSecrets: Bool = true) {
        self.outputs = Self.outputKinds.filter(outputs.contains); self.useModel = useModel; self.skipSecrets = skipSecrets
    }

    /// Fresh installs (no `precompose` key yet) prepare images on copy with
    /// local rules. A saved value, even an empty one, is always kept as is.
    public static let freshInstall = PrecomposeSettings(outputs: ["image"], useModel: false)

    public init(json: Any?) {
        guard let dictionary = json as? [String: Any] else { self = Self.freshInstall; return }
        self.init(outputs: dictionary["outputs"] as? [String] ?? [],
                  useModel: dictionary["useModel"] as? Bool ?? false,
                  skipSecrets: dictionary["skipSecrets"] as? Bool ?? true)
    }

    public var payload: [String: Any] { ["outputs": outputs, "useModel": useModel, "skipSecrets": skipSecrets] }
    public var isOn: Bool { !outputs.isEmpty }
}

/// Built-in rule ids and defaults, used when Core cannot list them.
public enum PrivacyBuiltins {
    public static let defaults: [(id: String, enabled: Bool)] = [
        ("api-keys", true), ("private-keys", true), ("jwt", true), ("bearer-tokens", true),
        ("connection-strings", true), ("secret-assignments", true), ("random-tokens", true),
        ("email", false), ("phone", false), ("id-card", false), ("bank-card", false)
    ]
    public static func defaultEnabled(_ id: String) -> Bool {
        defaults.first { $0.id == id }?.enabled ?? false
    }
    /// Placeholder entries (the id as name) for when Core is unreachable.
    public static var fallback: [CorePrivacyBuiltin] {
        defaults.map { CorePrivacyBuiltin(id: $0.id, name: $0.id, nameZh: $0.id, description: "", descriptionZh: "",
                                          defaultEnabled: $0.enabled, enabled: $0.enabled) }
    }
}

extension SettingsStore {
    public var privacySettings: PrivacySettings {
        PrivacySettings(json: values["privacy"])
    }
    public var precomposeSettings: PrecomposeSettings {
        PrecomposeSettings(json: values["precompose"])
    }
    public func setPrivacy(_ privacy: PrivacySettings, precompose: PrecomposeSettings) throws {
        try setValues(["privacy": privacy.payload, "precompose": precompose.payload])
    }
    /// Changes only which outputs are prepared on copy, keeping the other
    /// precompose options (the Shortcuts page and onboarding share this).
    public func setPrecomposeOutputs(_ outputs: [String]) throws {
        var next = precomposeSettings
        next = PrecomposeSettings(outputs: outputs, useModel: next.useModel, skipSecrets: next.skipSecrets)
        try setValues(["precompose": next.payload])
    }
    public var onboardingVersion: Int? { values["onboarding_version"] as? Int }
    public var shouldShowOnboarding: Bool { Onboarding.shouldShow(savedVersion: onboardingVersion) }
    public func markOnboardingSeen() throws { try set("onboarding_version", value: Onboarding.currentVersion) }
    /// The per-kind frames sent with a `precompose` request.
    public var precomposeFrames: [String: String] {
        Dictionary(uniqueKeysWithValues: PrecomposeSettings.outputKinds.map { ($0, frame(kind: $0)) })
    }
    public var templatePreferences: [String: String]? {
        values["template_styles"] as? [String: String]
    }
    /// The card typeface: "maple" (Maple Mono, the default) or "noto" (Noto Sans SC). Code is always Maple Mono.
    public var templateFont: String {
        let value = values["template_font"] as? String
        return value == "noto" ? "noto" : "maple"
    }
    public func setTemplateFont(_ font: String) throws { try set("template_font", value: font == "noto" ? "noto" : "maple") }
    /// The longest card signature, in characters (Core enforces the same, in graphemes).
    public static let templateSignatureMaxLength = 40
    /// A signature as it is stored and sent: one line (whitespace runs become
    /// one space), trimmed, at most `templateSignatureMaxLength` characters.
    public static func normalizedTemplateSignature(_ value: String) -> String {
        let line = value.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return String(line.prefix(templateSignatureMaxLength)).trimmingCharacters(in: .whitespaces)
    }
    /// The line drawn at the foot of every card but QR ("@nya · peesuto.com"); empty means none (the default).
    public var templateSignature: String {
        Self.normalizedTemplateSignature(values["template_signature"] as? String ?? "")
    }
    public func setTemplateSignature(_ signature: String) throws {
        try set("template_signature", value: Self.normalizedTemplateSignature(signature))
    }
    /// Templates the user turned off for automatic choice, sorted; empty when none.
    public var disabledTemplates: [String] {
        Set(values["templates_disabled"] as? [String] ?? []).sorted()
    }
    public func setTemplateEnabled(_ id: String, _ enabled: Bool) throws {
        var off = Set(disabledTemplates)
        if enabled { off.remove(id) } else { off.insert(id) }
        try set("templates_disabled", value: off.sorted())
    }
    public func setTemplateStyle(_ id: String, variant: String?) throws {
        var styles = templatePreferences ?? [:]
        styles[id] = variant
        try set("template_styles", value: styles)
    }
    /// Every template on, no remembered styles, the default font, no signature.
    public func resetTemplates() throws {
        try set("template_font", value: "maple")
        try set("template_signature", value: "")
        try set("templates_disabled", value: [String]())
        try set("template_styles", value: [String: String]())
    }
}

/// First-run onboarding gate. Bump `currentVersion` when the onboarding
/// changes enough that existing users should see it again.
public enum Onboarding {
    public static let currentVersion = 1
    public static func shouldShow(savedVersion: Int?) -> Bool {
        guard let savedVersion else { return true }
        return savedVersion < currentVersion
    }
}

// MARK: - Background precompose scheduling

/// Power and thermal state, injectable for tests.
public protocol PowerStateProviding: Sendable {
    var isLowPowerModeEnabled: Bool { get }
    var thermalState: ProcessInfo.ThermalState { get }
}

public struct SystemPowerState: PowerStateProviding {
    public init() {}
    public var isLowPowerModeEnabled: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }
    public var thermalState: ProcessInfo.ThermalState { ProcessInfo.processInfo.thermalState }
}

/// A sleep source, injectable for tests.
public protocol PrecomposeClock: Sendable {
    func sleep(seconds: TimeInterval) async throws
}

public struct SystemPrecomposeClock: PrecomposeClock {
    public init() {}
    public func sleep(seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

public enum PrecomposeSkip: Equatable, Sendable {
    case off, empty, lowPower, thermal, busy
}

/// Debounces copied texts and hands the latest one to `perform` once things
/// settle. A newer copy resets the delay; nothing runs while power or
/// thermal state asks us to hold back. Never throws to the caller.
@MainActor public final class PrecomposeScheduler {
    public let delay: TimeInterval
    private let clock: PrecomposeClock
    private let power: PowerStateProviding
    private let perform: @MainActor (String) async -> Void
    private var pending: Task<Void, Never>?
    private var generation = 0
    /// The most recent reason a text was not precomposed (diagnostics/tests).
    public private(set) var lastSkip: PrecomposeSkip?

    public init(delay: TimeInterval = 0.5, clock: PrecomposeClock = SystemPrecomposeClock(),
                power: PowerStateProviding = SystemPowerState(),
                perform: @escaping @MainActor (String) async -> Void) {
        self.delay = delay; self.clock = clock; self.power = power; self.perform = perform
    }

    public static func skipReason(text: String, outputs: [String], power: PowerStateProviding, busy: Bool = false) -> PrecomposeSkip? {
        if outputs.isEmpty { return .off }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
        if power.isLowPowerModeEnabled { return .lowPower }
        if power.thermalState == .serious || power.thermalState == .critical { return .thermal }
        if busy { return .busy }
        return nil
    }

    /// `outputs` and `busy` are read when the delay ends, so settings saved
    /// or an action started in between are respected.
    public func schedule(text: String, outputs: @escaping @MainActor () -> [String],
                         busy: @escaping @MainActor () -> Bool = { false }) {
        pending?.cancel()
        generation += 1
        let token = generation
        if let skip = Self.skipReason(text: text, outputs: outputs(), power: power) {
            // Off or empty: nothing to wait for. Power state is rechecked later.
            if skip == .off || skip == .empty { lastSkip = skip; pending = nil; return }
        }
        pending = Task { [weak self, clock, delay] in
            do { try await clock.sleep(seconds: delay) } catch { return }
            guard let self, !Task.isCancelled, self.generation == token else { return }
            self.pending = nil
            if let skip = Self.skipReason(text: text, outputs: outputs(), power: self.power, busy: busy()) {
                self.lastSkip = skip
                return
            }
            self.lastSkip = nil
            await self.perform(text)
        }
    }

    public func cancel() { pending?.cancel(); pending = nil; generation += 1 }
}
