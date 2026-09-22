import Foundation

enum Language {
    static func isChinese(_ preference: String) -> Bool {
        preference == "zh-CN" || (preference == "system" && (Locale.preferredLanguages.first ?? "en").lowercased().hasPrefix("zh"))
    }
    static func text(_ english: String, _ chinese: String, preference: String) -> String {
        isChinese(preference) ? chinese : english
    }
}
