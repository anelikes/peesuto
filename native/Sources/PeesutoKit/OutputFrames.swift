import Foundation

/// Output frames (Core's `input.aspect`): images default to "auto" (height
/// hugs the content); GIF and video always use a fixed frame and scroll.
public enum OutputFrames {
    public static let imageOptions = ["auto", "1:1", "4:5", "16:9", "9:16"]
    public static let fixedOptions = ["1:1", "4:5", "16:9", "9:16"]

    /// "image", "gif" or "video" for an action output kind or a file format;
    /// nil for text outputs, which take no frame.
    public static func kind(output: String?) -> String? {
        switch output?.lowercased() {
        case "image", "png": return "image"
        case "gif": return "gif"
        case "video", "mp4": return "video"
        default: return nil
        }
    }

    public static func kind(actionID: String) -> String? {
        switch actionID {
        case "paste-card": return "image"
        case "paste-gif": return "gif"
        case "paste-video": return "video"
        default: return nil
        }
    }

    public static func options(kind: String) -> [String] { kind == "image" ? imageOptions : fixedOptions }
    public static func defaultFrame(kind: String) -> String { kind == "image" ? "auto" : "1:1" }
    public static func settingsKey(kind: String) -> String { "frame_" + kind }

    /// Maps the pre-frame `aspect` presets.
    public static func legacy(_ aspect: String?) -> String? {
        switch aspect {
        case "chat": return "1:1"
        case "doc": return "16:9"
        case "social": return "9:16"
        default: return nil
        }
    }

    /// A valid frame for this kind: legacy names are mapped, unknown values
    /// fall back to the default, and "auto" is image-only.
    public static func normalize(_ value: String?, kind: String) -> String {
        let mapped = legacy(value) ?? value ?? ""
        return options(kind: kind).contains(mapped) ? mapped : defaultFrame(kind: kind)
    }
}

extension SettingsStore {
    /// The saved default frame for "image", "gif" or "video". Before any
    /// frame was saved, GIF and video inherit the legacy `aspect` preset.
    public func frame(kind: String) -> String {
        let key = OutputFrames.settingsKey(kind: kind)
        if let saved = values[key] as? String { return OutputFrames.normalize(saved, kind: kind) }
        if kind != "image", let migrated = OutputFrames.legacy(string("aspect")) { return migrated }
        return OutputFrames.defaultFrame(kind: kind)
    }

    public func setFrames(_ frames: [String: String]) throws {
        var updates: [String: Any] = [:]
        for (kind, value) in frames where ["image", "gif", "video"].contains(kind) {
            updates[OutputFrames.settingsKey(kind: kind)] = OutputFrames.normalize(value, kind: kind)
        }
        try setValues(updates)
    }
}
