import AppKit
import SwiftUI
import PeesutoKit

@main struct PeesutoApplication {
    static func main() {
        let app = NSApplication.shared
        let delegate = ApplicationDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

final class ClipboardPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var model: AppState!
    private var panel: ClipboardPanel!
    private var settingsWindow: NSWindow?
    private var statusItem: NSStatusItem!
    private var taskPanel: NSPanel?
    private var onboardingWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let preview = CommandLine.arguments.contains("--preview") || Bundle.main.object(forInfoDictionaryKey: "PeesutoPreview") as? Bool == true
        if !preview, NSRunningApplication.runningApplications(withBundleIdentifier: "com.peesuto.desktop").contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            let alert = NSAlert()
            alert.messageText = "Peesuto is already running / Peesuto 已在运行"
            alert.informativeText = "Quit the other version before opening this build. 两个版本不能同时使用同一历史记录。"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        model = AppState(preview: preview)
        model.hidePanel = { [weak self] in self?.panel.orderOut(nil) }
        model.settingsChanged = { [weak self] in self?.rebuildMenus() }
        model.showTaskStatus = { [weak self] in self?.showTaskStatus() }
        model.hideTaskStatus = { [weak self] in self?.taskPanel?.orderOut(nil) }
        panel = ClipboardPanel(contentRect: NSRect(x: 0, y: 0, width: 790, height: 530), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = preview ? "Peesuto Preview" : "Peesuto"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 760, height: 530)
        panel.contentView = NSHostingView(rootView: PanelView(model: model, openSettings: { [weak self] in self?.showSettings() }))
        panel.center()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "square.on.square", accessibilityDescription: "Peesuto")
        rebuildMenus()
        if !preview {
            do { try registerShortcuts(model.shortcuts) }
            catch {
                try? registerShortcuts(["panel": model.shortcuts["panel"] ?? ""])
                model.notice = model.tr("Some shortcuts are unavailable. Check Settings → Shortcuts.", "部分快捷键不可用，请检查「设置 → 快捷键」。")
            }
        }
        // Preview-only launch arguments for screenshots: --onboarding-step N, --settings-section N [--settings-anchor id], --pin-sample.
        let arguments = CommandLine.arguments
        func argument(_ name: String) -> Int? {
            guard preview, let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
            return Int(arguments[index + 1])
        }
        if preview, arguments.contains("--pin-sample") {
            pinSamples()
        } else if let section = argument("--settings-section") {
            model.requestedSettingsSection = section
            if let index = arguments.firstIndex(of: "--settings-anchor"), index + 1 < arguments.count {
                model.requestedSettingsAnchor = arguments[index + 1]
            }
            showSettings()
        } else if let step = argument("--onboarding-step") {
            showOnboarding(step: step)
        } else if !preview, model.settings?.shouldShowOnboarding == true {
            showOnboarding(step: 0)
        } else {
            showPanel()
        }
    }

    /// Preview screenshots: two onboarding samples pinned at a fixed spot on the main screen.
    private func pinSamples() {
        guard let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame else { return }
        for (name, dx) in [("sample-text", 0.3), ("sample-chat", 0.7)] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Onboarding"),
                  let image = PinImage.from(file: url) else { continue }
            model.pins.pin(image, center: NSPoint(x: visible.minX + visible.width * dx, y: visible.midY))
        }
    }

    func showOnboarding(step: Int) {
        onboardingWindow?.close()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 540),
                              styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.title = model.tr("Welcome to Peesuto", "欢迎使用 Peesuto")
        window.delegate = self
        let hosting = NSHostingView(rootView: OnboardingView(
            model: model, initialStep: step,
            openAISettings: { [weak self] in
                self?.model.requestedSettingsSection = 1
                self?.showSettings()
            },
            finish: { [weak window] in window?.close() }))
        // The SwiftUI root has a fixed size; do not let it resize the window to add the title bar.
        hosting.sizingOptions = []
        window.contentView = hosting
        // The content runs under the transparent title bar: 760×540 overall.
        window.setFrame(NSRect(x: 0, y: 0, width: 760, height: 540), display: false)
        window.center()
        onboardingWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === onboardingWindow else { return }
        // Seen once it has been shown and closed, however it was closed.
        if !model.previewMode { try? model.settings?.markOnboardingSeen() }
        onboardingWindow = nil
    }

    func rebuildMenus() {
        let menu = NSMenu()
        menu.addItem(withTitle: model.tr("Open Peesuto", "打开 Peesuto"), action: #selector(showPanel), keyEquivalent: "")
        let media = NSMenuItem(title: model.tr("Paste as", "粘贴为"), action: nil, keyEquivalent: "")
        let mediaMenu = NSMenu()
        mediaMenu.autoenablesItems = false
        for (id, en, zh) in [("paste-card", "Image", "图片"), ("paste-gif", "GIF", "GIF"), ("paste-video", "Video", "视频"), ("paste-qr", "QR code", "二维码")] {
            let item = mediaMenu.addItem(withTitle: model.tr(en, zh), action: #selector(runMedia(_:)), keyEquivalent: "")
            item.representedObject = id
            item.target = self
            item.isEnabled = !model.previewMode
        }
        mediaMenu.addItem(.separator())
        let pin = mediaMenu.addItem(withTitle: model.tr("Pin to screen", "贴到屏幕"), action: #selector(runMedia(_:)), keyEquivalent: "")
        pin.representedObject = MediaShortcuts.pinID
        pin.target = self
        pin.isEnabled = !model.previewMode
        media.submenu = mediaMenu
        menu.addItem(media)
        menu.addItem(withTitle: model.tr("Settings…", "设置…"), action: #selector(showSettings), keyEquivalent: ",")
        menu.addItem(.separator())
        menu.addItem(withTitle: model.paused ? model.tr("Resume history", "继续记录") : model.tr("Pause history", "暂停记录"), action: #selector(togglePause), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: model.tr("Quit Peesuto", "退出 Peesuto"), action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: model.tr("Settings…", "设置…"), action: #selector(showSettings), keyEquivalent: ",").target = self
        appMenu.addItem(withTitle: model.tr("Quit Peesuto", "退出 Peesuto"), action: #selector(quit), keyEquivalent: "q").target = self
        appItem.submenu = appMenu; main.addItem(appItem)
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        for (title, selector, key) in [(model.tr("Cut", "剪切"), #selector(NSText.cut(_:)), "x"), (model.tr("Copy", "复制"), #selector(NSText.copy(_:)), "c"), (model.tr("Paste", "粘贴"), #selector(NSText.paste(_:)), "v"), (model.tr("Select All", "全选"), #selector(NSText.selectAll(_:)), "a")] {
            edit.addItem(withTitle: title, action: selector, keyEquivalent: key)
        }
        editItem.submenu = edit; main.addItem(editItem)
        NSApp.mainMenu = main
        settingsWindow?.title = model.tr("Settings", "设置")
    }

    @objc func showPanel() {
        model.prepareToOpen()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }
    @objc func showSettings() {
        if !model.previewMode { model.paste.rememberFrontmost() }
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 520), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(model: model, registerShortcuts: { [weak self] shortcuts in
                try self?.registerShortcuts(shortcuts)
            }, recordingChanged: { [weak self] recording in
                guard let self, !self.model.previewMode else { return }
                if recording { self.model.hotkeys.unregister() }
                else {
                    do { try self.registerShortcuts(self.model.shortcuts) }
                    catch {
                        try? self.registerShortcuts(["panel": self.model.shortcuts["panel"] ?? ""])
                        self.model.error = self.model.tr("Could not restore all shortcuts. Check settings.", "无法恢复全部快捷键，请检查设置。")
                    }
                }
            }, showOnboarding: { [weak self] in self?.showOnboarding(step: 0) }))
            window.title = model.tr("Settings", "设置")
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }
    @objc func togglePause() { model.paused.toggle(); rebuildMenus() }
    @objc func runMedia(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { model.runClipboardAction(id) }
    }
    private func registerShortcuts(_ shortcuts: [String: String]) throws {
        // Preview checks syntax and duplicates without claiming system shortcuts.
        try HotKeyGroup.validate(shortcuts)
        guard !model.previewMode else { return }
        try model.hotkeys.register(shortcuts) { [weak self] id in
            guard let self else { return }
            if id == "panel" { self.showPanel() }
            else { self.model.runClipboardAction(id) }
        }
    }
    private func showTaskStatus() {
        if taskPanel == nil {
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 120), styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView], backing: .buffered, defer: false)
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.level = .floating
            window.isReleasedWhenClosed = false
            window.hidesOnDeactivate = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.contentView = NSHostingView(rootView: TaskStatusView(model: model, openResult: { [weak self] in
                self?.taskPanel?.orderOut(nil)
                self?.showPanel()
            }, dismiss: { [weak self] in self?.taskPanel?.orderOut(nil) }))
            taskPanel = window
        }
        let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main
        if let frame = screen?.visibleFrame { taskPanel?.setFrameOrigin(NSPoint(x: frame.maxX - 380, y: frame.maxY - 140)) }
        taskPanel?.orderFrontRegardless()
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationDidBecomeActive(_ notification: Notification) {
        model?.trusted = PeesutoKit.PasteController.accessibilityTrusted
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        model?.stop()
        guard let core = model?.core else { return .terminateNow }
        Task { await core.shutdown(); NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
