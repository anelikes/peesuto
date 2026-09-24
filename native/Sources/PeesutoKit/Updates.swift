import Foundation

/// Whether this build may run Sparkle's updater. Kept out of the app target so it is testable.
public enum UpdaterConfiguration {
    public static let previewBundleIdentifier = "com.peesuto.desktop.preview"

    /// True only for a release bundle that carries an https feed and a public EdDSA key.
    /// Preview builds (flag, Info.plist marker or bundle id) never check for updates, and
    /// neither does a bare `swift run` binary, which has no feed in its Info.plist.
    public static func isEnabled(info: [String: Any], arguments: [String] = []) -> Bool {
        if arguments.contains("--preview") { return false }
        if info["PeesutoPreview"] as? Bool == true { return false }
        if (info["CFBundleIdentifier"] as? String) == previewBundleIdentifier { return false }
        guard let feed = info["SUFeedURL"] as? String, let url = URL(string: feed), url.scheme == "https", url.host != nil else { return false }
        guard let key = info["SUPublicEDKey"] as? String, !key.isEmpty else { return false }
        return true
    }
}
