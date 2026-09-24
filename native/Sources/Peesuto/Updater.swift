import AppKit
import Sparkle
import PeesutoKit

/// Sparkle's standard updater, or nothing in a preview build (see `UpdaterConfiguration`).
/// The feed, public key and daily schedule live in Info.plist, written by scripts/build-native.ts.
@MainActor final class AppUpdater: ObservableObject {
    static let shared = AppUpdater()
    let isEnabled: Bool
    @Published private(set) var canCheck = false
    private let controller: SPUStandardUpdaterController?
    private var observation: NSKeyValueObservation?

    private init() {
        isEnabled = UpdaterConfiguration.isEnabled(info: Bundle.main.infoDictionary ?? [:], arguments: CommandLine.arguments)
        guard isEnabled else { controller = nil; return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        self.controller = controller
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            let value = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheck = value }
        }
    }

    var automaticallyChecks: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set { objectWillChange.send(); controller?.updater.automaticallyChecksForUpdates = newValue }
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }
}

extension ApplicationDelegate: NSMenuItemValidation {
    @objc func checkForUpdates() { AppUpdater.shared.checkForUpdates() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        item.action == #selector(checkForUpdates) ? AppUpdater.shared.canCheck : true
    }
}
