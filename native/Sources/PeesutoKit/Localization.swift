import Foundation

/// The interface language, resolved from the `language` setting.
public enum UILanguage: String, Sendable, CaseIterable {
    case english = "en", chinese = "zh-CN", japanese = "ja"

    /// Values the `language` setting accepts.
    public static let settingValues = ["system", "en", "zh-CN", "ja"]

    /// "system" follows the first preferred language: Chinese for zh*, Japanese for ja*, English otherwise.
    public static func resolve(_ preference: String, preferredLanguages: [String] = Locale.preferredLanguages) -> UILanguage {
        if let explicit = UILanguage(rawValue: preference) { return explicit }
        let first = (preferredLanguages.first ?? "en").lowercased()
        if first.hasPrefix("zh") { return .chinese }
        if first.hasPrefix("ja") { return .japanese }
        return .english
    }
}

/// Every UI string is written in English and Chinese at its call site
/// (`tr(english, chinese)`); Japanese is looked up by the English text in
/// `JapaneseStrings.table`. A missing entry falls back to English, never to
/// Chinese; LocalizationTests fails on any missing entry. Strings built by
/// interpolation cannot be looked up, so their call sites pass `ja:` too.
public struct Localizer: Sendable {
    public let language: UILanguage

    public init(_ language: UILanguage) { self.language = language }
    public init(preference: String) { language = UILanguage.resolve(preference) }

    public func callAsFunction(_ english: String, _ chinese: String) -> String {
        switch language {
        case .english: return english
        case .chinese: return chinese
        case .japanese: return JapaneseStrings.table[english] ?? english
        }
    }

    public func callAsFunction(_ english: String, _ chinese: String, ja japanese: String) -> String {
        switch language {
        case .english: return english
        case .chinese: return chinese
        case .japanese: return japanese
        }
    }
}
