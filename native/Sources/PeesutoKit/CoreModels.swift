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

    public init(text: String, item: CoreClipItem? = nil, context: CoreContext? = nil,
                aspect: String? = nil, fresh: Bool? = nil, template: CoreTemplateOptions? = nil,
                templatePreferences: [String: String]? = nil) {
        self.text = text; self.item = item; self.context = context
        self.aspect = aspect; self.fresh = fresh
        self.template = template
        self.templatePreferences = templatePreferences
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
}

public struct CoreActionMetadata: Codable, Sendable {
    public let template: CoreTemplateSelection?
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
    public var errorDescription: String? { message }

    public init(kind: String, message: String) {
        self.kind = kind; self.message = message
    }
}
