import Foundation

/// "Open in JIZURA" for lyric results. JIZURA (https://github.com/852wa/JIZURA,
/// MIT) is a browser lyric-video maker that Peesuto's lyrics template takes its
/// vocabulary from; Peesuto makes the quick version and hands the lyrics over
/// for a full video. Its web app takes no lyrics in the URL (it starts from
/// what it saved in the browser, checked 2026-09-24 in src/12_ui.js), so the
/// hand-off copies the lyrics as written (markup included: JIZURA reads the
/// same `/`, `*`, `|` and LRC syntax) and opens the app for the user to paste.
public enum JizuraHandoff {
    /// The template the action belongs to.
    public static let templateID = "lyrics"
    /// Whether the app can receive lyrics in its URL. If a future JIZURA
    /// accepts them, build the URL here and stop copying.
    public static let acceptsLyricsInURL = false

    /// The Japanese edition for a Japanese interface, the English one otherwise
    /// (there is no Chinese edition; it auto-detects Chinese lyrics).
    public static func url(for language: UILanguage) -> URL {
        URL(string: language == .japanese ? "https://852wa.github.io/JIZURA/" : "https://852wa.github.io/JIZURA/en/")!
    }

    /// What is copied for JIZURA: the source text exactly, surrounding blank lines aside.
    public static func lyrics(from source: String) -> String {
        source.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
