import Foundation

/// Actual Core lifecycle; intentionally contains no estimated percentage.
public enum CoreTaskState: String, Codable, Sendable {
    case accepted, running, completed, failed
}

public struct CoreProviders: Codable, Sendable {
    public let decider: String
    public let generator: String
    public let offline: Bool
}

public struct CoreHealth: Codable, Sendable {
    public let version: String
    public let engine: String?
    public let providers: CoreProviders
    public let uptimeMs: Double
    public let packs: [CorePack]
}

public struct CorePack: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let version: String
    public let kind: String
}

public struct CoreActionSpec: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let input: String
    public let needs: String
    public let output: String
    public let builtin: Bool?
    public let pack: String?
}

public struct CoreActionList: Codable, Sendable {
    public let actions: [CoreActionSpec]
    public let problems: [CoreActionProblem]
}

public struct CoreActionProblem: Codable, Sendable {
    public let file: String
    public let message: String
}

public struct CoreClipItem: Codable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let text: String?
    public let preview: String
    public let appBundleId: String?
    public let createdAt: Double
    public let pinned: Bool?
    public let bytes: Int?
    public let excluded: Bool?

    public init(id: String, kind: String, text: String? = nil, preview: String,
                appBundleId: String? = nil, createdAt: Double, pinned: Bool? = nil,
                bytes: Int? = nil, excluded: Bool? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.preview = preview
        self.appBundleId = appBundleId; self.createdAt = createdAt; self.pinned = pinned
        self.bytes = bytes; self.excluded = excluded
    }
}

public struct CoreContext: Codable, Sendable {
    public let level: Int
    public let appBundleId: String
    public let appName: String?
    public let windowTitle: String?
    public let role: String?
    public let label: String?
    public let before: String?
    public let after: String?
    public let secure: Bool?

    public init(level: Int = 0, appBundleId: String = "", appName: String? = nil,
                windowTitle: String? = nil, role: String? = nil, label: String? = nil,
                before: String? = nil, after: String? = nil, secure: Bool? = nil) {
        self.level = level; self.appBundleId = appBundleId; self.appName = appName
        self.windowTitle = windowTitle; self.role = role; self.label = label
        self.before = before; self.after = after; self.secure = secure
    }
}

public struct CoreRankedItem: Codable, Sendable {
    public let item: CoreClipItem
    public let score: Double
    public let reason: String
}

public struct CorePickResult: Codable, Sendable {
    public let ranked: [CoreRankedItem]
    public let shouldPaste: Double
    public let source: String
}

public struct CoreActionInput: Codable, Sendable {
    public let text: String
    public let item: CoreClipItem?
    public let context: CoreContext?
    public let aspect: String?
    public let fresh: Bool?
    public let template: CoreTemplateOptions?
    public let templatePreferences: [String: String]?
    /// Templates turned off for automatic choice (Settings › Templates).
    public let disabledTemplates: [String]?
    /// The card typeface, "maple" or "noto".
    public let templateFont: String?
    /// The card signature footer; nil or empty means none.
    public let templateSignature: String?

    public init(text: String, item: CoreClipItem? = nil, context: CoreContext? = nil,
                aspect: String? = nil, fresh: Bool? = nil, template: CoreTemplateOptions? = nil,
                templatePreferences: [String: String]? = nil, disabledTemplates: [String]? = nil, templateFont: String? = nil,
                templateSignature: String? = nil) {
        self.text = text; self.item = item; self.context = context
        self.aspect = aspect; self.fresh = fresh
        self.template = template
        self.templatePreferences = templatePreferences
        self.disabledTemplates = disabledTemplates
        self.templateFont = templateFont
        self.templateSignature = templateSignature
    }
}

public struct CoreActionResult: Codable, Sendable {
    public let output: String
    public let text: String?
    public let path: String?
    public let format: String?
    public let model: String?
    public let ms: Double
    public let meta: CoreActionMetadata?
}

public struct CoreTemplateOptions: Codable, Sendable {
    public let id: String?
    public let variant: String?
    public let motion: String?
    public init(id: String? = nil, variant: String? = nil, motion: String? = nil) {
        self.id = id; self.variant = variant; self.motion = motion
    }
}

public struct CoreTemplateSelection: Codable, Sendable {
    public let id: String
    public let variant: String
    public let motion: String
    public let decisionSource: String
    public let availableTemplates: [String]
    /// Why the model's template pick was not used, when it failed.
    public let decisionError: CoreDecisionError?
    /// The frame Core actually used, normalized (e.g. "auto", "1:1").
    public let aspect: String?
}

public struct CoreDecisionError: Codable, Sendable {
    public let kind: String
    public let message: String
}

public struct CoreActionMetadata: Codable, Sendable {
    public let template: CoreTemplateSelection?
    /// True when Core served a result rendered in the background; absent otherwise.
    public let precomposed: Bool?
    /// Set when the action made another output than it names: paste-lyric's
    /// GIF when ffmpeg is missing (`from` "video", `to` "gif", `reason` "ffmpeg").
    public let fallback: CoreRenderFallback?
}

public struct CoreRenderFallback: Codable, Sendable, Equatable {
    public let from: String
    public let to: String
    public let reason: String
}

/// A built-in privacy rule as listed by `privacy.rules`.
public struct CorePrivacyBuiltin: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let nameZh: String
    public let description: String
    public let descriptionZh: String
    public let defaultEnabled: Bool
    public let enabled: Bool
    public init(id: String, name: String, nameZh: String, description: String, descriptionZh: String,
                defaultEnabled: Bool, enabled: Bool) {
        self.id = id; self.name = name; self.nameZh = nameZh; self.description = description
        self.descriptionZh = descriptionZh; self.defaultEnabled = defaultEnabled; self.enabled = enabled
    }
}

public struct CorePrivacyRules: Codable, Sendable {
    public let builtins: [CorePrivacyBuiltin]
}

public struct CorePrivacySpan: Codable, Equatable, Sendable {
    public let start: Int
    public let end: Int
    public let ruleId: String
    public let replacement: String
}

/// `privacy.preview`: what the model would receive and what would be rendered.
public struct CorePrivacyPreview: Codable, Sendable {
    public let modelText: String
    public let outputText: String
    public let spans: [CorePrivacySpan]
    public let containsSecret: Bool
}

/// `precompose` answers at once; the rendering happens in the background.
public struct CorePrecomposeReply: Codable, Sendable {
    public let queued: Bool
    /// "off", "secret", "too-long" or "empty" when not queued.
    public let skipped: String?
}

public struct CoreTemplateVariant: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let nameZh: String
}

public struct CoreTemplateSpec: Codable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let nameZh: String
    public let variants: [CoreTemplateVariant]
    public let motions: [String]
}

public struct CoreTemplateList: Codable, Sendable {
    public let templates: [CoreTemplateSpec]
}

public struct CoreActionResponse: Codable, Sendable {
    public let result: CoreActionResult
    public let pick: CorePickResult?
}

public struct CoreError: Error, LocalizedError, Sendable {
    public let kind: String
    public let message: String
    /// Recent Core stderr lines at the time of a process failure, truncated.
    public let diagnostics: [String]
    /// The finer reason within a kind, e.g. "overflow" or "unsupported-script" for "compose".
    public let code: String?
    /// For "unsupported-script": the characters the card font cannot draw.
    public let characters: [String]
    public var errorDescription: String? { message }

    public init(kind: String, message: String, diagnostics: [String] = [], code: String? = nil, characters: [String] = []) {
        self.kind = kind; self.message = message; self.diagnostics = diagnostics; self.code = code; self.characters = characters
    }

    /// Characters as readable labels; invisible ones become their code point.
    public var characterLabels: [String] {
        characters.map { character in
            let scalars = character.unicodeScalars
            let visible = scalars.contains { !$0.properties.isWhitespace && $0.properties.generalCategory != .format && $0.properties.generalCategory != .control }
            let points = scalars.map { String(format: "U+%04X", $0.value) }.joined(separator: " ")
            return visible ? "\(character) (\(points))" : points
        }
    }
}
