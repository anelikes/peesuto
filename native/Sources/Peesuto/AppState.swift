import AppKit
import SwiftUI
import PeesutoKit

struct OutputPreview {
    let title: String
    let text: String?
    let url: URL?
    let sourceText: String?
    let template: CoreTemplateSelection?
    let format: String?
    /// The frame requested for this result (nil for text outputs).
    let frame: String?
    /// Core served this result from background precompose.
    let precomposed: Bool
    init(title: String, text: String?, url: URL?, sourceText: String? = nil,
         template: CoreTemplateSelection? = nil, format: String? = nil, frame: String? = nil,
         precomposed: Bool = false) {
        self.title = title; self.text = text; self.url = url
        self.sourceText = sourceText; self.template = template; self.format = format
        self.frame = frame; self.precomposed = precomposed
    }
    /// The frame Core reports it used, falling back to the requested one.
    var usedFrame: String? { template?.aspect ?? frame }
}

@MainActor final class AppState: ObservableObject {
    @Published var items: [ClipRecord] = []
    @Published var selectedID: String?
    @Published var query = "" { didSet { refresh() } }
    @Published var language = "system"
    @Published var actions: [CoreActionSpec] = []
    @Published var templates: [CoreTemplateSpec] = []
    @Published var output: OutputPreview?
    @Published var busy = false
    @Published var taskStatus = ""
    @Published var directTask = false
    @Published var error: String?
    @Published var notice: String?
    @Published var paused = false { didSet { monitor.isPaused = paused } }
    @Published var recommendedID: String?
    @Published var offline = false
    @Published var trusted = PasteController.accessibilityTrusted
    @Published var historyLocked = false
    /// The last media shortcut was copy-only because Accessibility is missing.
    @Published var needsAccessibility = false
    /// Set to open Settings at a section (0 general, 1 AI, 2 history, 3 shortcuts, 4 privacy).
    @Published var requestedSettingsSection: Int?
    /// Scrolls the requested settings section to an anchor ("prepare", "about").
    @Published var requestedSettingsAnchor: String?
    /// Bumped when another window (onboarding) saved settings the Settings window shows.
    @Published var settingsRevision = 0
    let previewMode: Bool
    let directory: URL
    var settings: SettingsStore?
    var history: HistoryStore?
    var core: CoreClient?
    let monitor = ClipboardMonitor()
    let paste = PasteController()
    let hotkeys = HotKeyGroup()
    var hidePanel: (() -> Void)?
    var settingsChanged: (() -> Void)?
    var showTaskStatus: (() -> Void)?
    var hideTaskStatus: (() -> Void)?
    /// Pinned images (pin to screen); none survive a relaunch.
    lazy var pins = PinManager(tr: { [weak self] en, zh in self?.tr(en, zh) ?? en }, copy: { [weak self] image in
        guard let self else { return false }
        return image.format == "gif" ? self.paste.copyGIF(image.data) : self.paste.copyImage(image.data)
    })
    private var task: Task<Void, Never>?
    private var openingTask: Task<Void, Never>?
    private var retentionTimer: Timer?
    private var context: [String: Any] = ["level": 0, "appBundleId": ""]
    private var panelRevision = 0
    private var actionRevision = 0
    /// Core keeps its configuration across restarts once it has been given one.
    private var coreConfiguredOnce = false
    private lazy var precomposer = PrecomposeScheduler { [weak self] text in await self?.precompose(text) }

    init(preview: Bool) {
        previewMode = preview
        directory = preview
            ? FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-native-preview-\(ProcessInfo.processInfo.processIdentifier)")
            : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("com.peesuto.desktop")
        if preview { Self.removeStalePreviewDirectories() }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let settings = try SettingsStore(directory: directory)
            self.settings = settings
            language = settings.language
            offline = settings.providers["offline"] as? Bool ?? false
            if preview {
                let history = try HistoryStore(directory: directory, key: Data(repeating: 0x42, count: 32))
                try history.insert(text: "Make room for a clearer thought.", sourceApp: "com.apple.Notes")
                try history.insert(text: "“把灵感留住，让表达更简单。”", sourceApp: "com.apple.Notes")
                try history.insert(text: "小林：这段对话可以直接变成图片吗？\n阿澈：可以，复制后按一下快捷键。\n小林：那就把时间留给表达。", sourceApp: "com.apple.Notes")
                attach(history)
            } else {
                // Keychain can block (e.g. an access prompt); read it off the main thread.
                Task { await loadHistory() }
            }
        } catch {
            self.error = tr("History is locked or unavailable. Your existing data has been preserved.", "历史记录已锁定或无法读取，原有数据已保留。")
        }
        let bundle = Bundle.main.bundleURL
        let resources = bundle.appendingPathComponent("Contents/Resources/resources")
        if FileManager.default.fileExists(atPath: resources.appendingPathComponent("core/daemon.ts").path) {
            core = CoreClient(executable: bundle.appendingPathComponent("Contents/MacOS/paste"), daemon: resources.appendingPathComponent("core/daemon.ts"), resources: resources, appData: directory)
        }
        paste.beforePaste = { [weak self] in self?.hidePanel?() }
    }

    private func loadHistory() async {
        let directory = self.directory
        let key = await Task.detached(priority: .userInitiated) { () -> Data? in
            try? KeychainSecrets.historyKey(directory: directory)
        }.value
        if let key, let store = try? HistoryStore(directory: directory, key: key) {
            attach(store)
        } else {
            useSessionHistory()
        }
    }

    /// The saved history cannot be opened (missing or mismatched key). Keep
    /// capturing into a session-only store and offer "Start fresh".
    private func useSessionHistory() {
        historyLocked = true
        error = tr("History is locked: its key is missing or does not match. New copies are kept for this session only. Use Start fresh to begin a new history; the old one is kept aside.",
                   "历史记录已锁定：密钥缺失或不匹配。新复制的内容暂时只保留在本次运行中。可选择「重新开始」创建新历史，旧历史会另行保留。")
        if let session = try? HistoryStore.memoryOnly() { attach(session, prune: false) }
    }

    private func attach(_ store: HistoryStore, prune: Bool = true) {
        history = store
        if prune, let settings { try? store.prune(days: settings.retentionDays) }
        refresh()
        startCapture()
    }

    private func startCapture() {
        guard retentionTimer == nil, let settings else { return }
        monitor.excludedApps = Set(settings.blacklist)
        monitor.onText = { [weak self] text, app in
            guard let self else { return }
            do {
                try self.history?.insert(text: text, sourceApp: app); self.refresh()
                // The monitor already dropped own writes, concealed/transient
                // types and excluded apps before calling onText.
                self.schedulePrecompose(text)
            } catch { self.error = self.tr("Could not save clipboard history.", "无法保存剪贴板历史。") }
        }
        monitor.onImage = { [weak self] data, app in
            guard let self else { return }
            do { try self.history?.insertImage(data: data, sourceApp: app); self.refresh() }
            catch { self.error = self.tr("Could not save this image.", "无法保存这张图片。") }
        }
        monitor.onFiles = { [weak self] urls, app in
            guard let self else { return }
            do { try self.history?.insertFiles(urls: urls, sourceApp: app); self.refresh() }
            catch { self.error = self.tr("Could not save these files.", "无法保存这些文件记录。") }
        }
        if !previewMode { monitor.start() }
        retentionTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pruneHistory() }
        }
    }

    /// Preview builds use a per-process temporary folder; remove the ones
    /// left behind by preview processes that are no longer running.
    private static func removeStalePreviewDirectories() {
        let prefix = "peesuto-native-preview-"
        let temporary = FileManager.default.temporaryDirectory
        guard let entries = try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.lastPathComponent.hasPrefix(prefix) {
            guard let pid = pid_t(entry.lastPathComponent.dropFirst(prefix.count)), pid > 0, pid != getpid() else { continue }
            if kill(pid, 0) == 0 || errno == EPERM { continue }
            try? FileManager.default.removeItem(at: entry)
        }
    }

    func confirmStartFresh() {
        guard historyLocked, !previewMode else { return }
        let alert = NSAlert()
        alert.messageText = tr("Start a new history?", "重新开始历史记录？")
        alert.informativeText = tr("The locked history is moved into a dated folder in the app's data folder, not deleted. A new key is created, and copies from this session are kept.",
                                   "已锁定的历史会移到应用数据目录中带日期的文件夹，不会删除。将创建新密钥，并保留本次运行中复制的内容。")
        alert.addButton(withTitle: tr("Start fresh", "重新开始"))
        alert.addButton(withTitle: tr("Cancel", "取消"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let session = history
        let directory = self.directory
        Task {
            do {
                let key = try await Task.detached(priority: .userInitiated) { () throws -> Data in
                    try HistoryStore.moveAside(directory: directory)
                    return try KeychainSecrets.replaceHistoryKey()
                }.value
                let store = try HistoryStore(directory: directory, key: key)
                if let session { try? store.importRecords(from: session) }
                history = store
                historyLocked = false
                error = nil
                notice = tr("Started a new history. The old one was kept in the app data folder.", "已开始新的历史记录，旧历史保留在应用数据目录中。")
                pruneHistory()
            } catch {
                self.error = tr("Could not start a new history. Nothing was deleted.", "无法重新开始历史记录，未删除任何数据。")
            }
        }
    }

    func confirmClearHistory() {
        guard history != nil else { return }
        let alert = NSAlert()
        alert.messageText = tr("Clear all history?", "清空全部历史记录？")
        alert.informativeText = tr("All items, including pinned items and images, are permanently removed from this Mac.",
                                   "将从本机永久删除全部记录，包括置顶内容和图片。")
        alert.alertStyle = .warning
        alert.addButton(withTitle: tr("Clear history", "清空历史"))
        alert.addButton(withTitle: tr("Cancel", "取消"))
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try history?.clear()
            selectedID = nil
            refresh()
            notice = tr("History cleared", "历史记录已清空")
        } catch { self.error = tr("Could not clear history.", "无法清空历史记录。") }
    }

    /// A user-facing Core failure, with the last Core stderr line when there
    /// is one (already truncated by `CoreLogRing`).
    func coreFailureMessage(_ failure: CoreError) -> String {
        let base = failure.kind == "timeout"
            ? tr("The action took too long and was stopped.", "动作耗时过长，已停止。")
            : tr("Core stopped before the action finished.", "核心服务在动作完成前停止。")
        guard let detail = failure.diagnostics.last else { return base }
        return base + "\n" + tr("Core: ", "核心：") + detail
    }

    func tr(_ english: String, _ chinese: String) -> String { Language.text(english, chinese, preference: language) }
    var selected: ClipRecord? { items.first { $0.id == selectedID } }
    var isChinese: Bool { Language.isChinese(language) }
    var shortcuts: [String: String] {
        MediaShortcuts.resolve(saved: settings?.values["native_shortcuts"] as? [String: String] ?? [:], legacyPanel: settings?.hotkey)
    }

    func refresh() {
        do {
            items = try history?.list(query: query, limit: 200) ?? []
            if !items.contains(where: { $0.id == selectedID }) { selectedID = items.first?.id }
        } catch { self.error = tr("Could not read history. No data was removed.", "无法读取历史，未删除任何数据。") }
    }

    func prepareToOpen() {
        panelRevision += 1
        if !previewMode { paste.rememberFrontmost(); context = ContextCapture.capture() }
        trusted = PasteController.accessibilityTrusted
        refresh()
        recommendedID = nil
        let revision = panelRevision
        let capturedContext = context
        let capturedItems = items
        if capturedContext["secure"] as? Bool == true { notice = tr("Recommendations are off in secure fields.", "密码输入框中不提供推荐。") }
        guard !busy else { return }
        // Stale panel queries are ignored, not cancelled: cancellation stops the shared Core.
        openingTask = Task {
            do {
                try await configureCore()
                guard revision == panelRevision, !busy else { return }
                if let core { actions = try await core.actions().actions }
                if let core { templates = try await core.templates().templates }
                guard settings?.bool("smart_paste", default: true) != false,
                      capturedContext["secure"] as? Bool != true, !capturedItems.isEmpty, !busy, revision == panelRevision else { return }
                let decoder = JSONDecoder()
                let ctx = try decoder.decode(CoreContext.self, from: JSONSerialization.data(withJSONObject: capturedContext))
                let candidates = try capturedItems.compactMap { item -> CoreClipItem? in
                    guard item.kind == "text" || item.kind == "html" || item.kind == "rtf" else { return nil }
                    return try decoder.decode(CoreClipItem.self, from: JSONEncoder().encode(item))
                }
                if let pick = try await core?.pick(context: ctx, candidates: candidates), revision == panelRevision {
                    recommendedID = pick.ranked.first?.item.id
                }
            } catch {
                // The panel and history remain usable when Core is unavailable.
                if actions.isEmpty { notice = tr("Actions are unavailable. History is still ready.", "动作暂不可用，历史记录仍可使用。") }
            }
        }
    }

    /// Returns false when Core is busy with an action and the configuration
    /// will be applied once it is idle.
    @discardableResult
    func configureCore() async throws -> Bool {
        guard let core else { throw NSError(domain: "Peesuto", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bundled Core is missing."]) }
        let config: [String: Any]
        if let settings {
            config = try settings.coreConfiguration(secretReader: { name in
                self.previewMode ? nil : try KeychainSecrets.read(name: name)
            })
        } else {
            config = ["decider": ["kind": "rules"], "generator": ["kind": "none"], "offline": true]
        }
        let applied = try await core.configure(config) != nil
        coreConfiguredOnce = true
        return applied
    }

    /// Debounced background rendering of a copied text (settings: precompose).
    func schedulePrecompose(_ text: String) {
        guard !previewMode, core != nil else { return }
        precomposer.schedule(text: text,
                             outputs: { [weak self] in self?.settings?.precomposeSettings.outputs ?? [] },
                             busy: { [weak self] in self?.busy ?? true })
    }

    /// Never surfaces to the user: failures go to stderr and the in-memory
    /// diagnostics ring only, without the copied text.
    private func precompose(_ text: String) async {
        guard let core, let settings else { return }
        do {
            if !coreConfiguredOnce { try await configureCore() }
            _ = try await core.precompose(text: text, frames: settings.precomposeFrames,
                                          templatePreferences: settings.templatePreferences)
        } catch {
            let kind = (error as? CoreError)?.kind ?? (error is CancellationError ? "cancelled" : "error")
            let line = "precompose: request failed (\(kind))"
            core.log.append(line: line)
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }
    }

    func actionName(_ action: CoreActionSpec) -> String {
        guard action.builtin == true else { return action.name }
        switch action.id {
        case "paste-smart": return tr("Smart paste", "智能粘贴")
        case "paste-card": return tr("Create image", "生成图片")
        case "paste-gif": return tr("Create GIF", "生成 GIF")
        case "paste-video": return tr("Create video", "生成视频")
        case "paste-qr": return tr("Paste as QR code", "粘贴为二维码")
        case "paste-translate": return tr("Translate to English", "翻译为英文")
        case "paste-summary": return tr("Summarize", "生成摘要")
        default: return action.name
        }
    }

    func run(_ action: CoreActionSpec) {
        guard !busy, let item = selected, let text = item.text, !text.isEmpty else { return }
        execute(actionID: action.id, title: actionName(action), text: text, direct: false)
    }

    func runClipboardAction(_ actionID: String) {
        guard !previewMode else { return }
        let delivery = ClipboardShortcutDelivery.of(shortcut: actionID)
        // An image on the clipboard is pinned as-is: no render, no Core, no status.
        if delivery == .pin, let image = PinImage.read(from: NSPasteboard.general) {
            if !pins.pin(image) {
                directTask = true
                error = tr("Could not read the image on the clipboard.", "无法读取剪贴板中的图片。")
                notice = nil
                showTaskStatus?()
            }
            return
        }
        guard !busy else { showTaskStatus?(); return }
        let board = NSPasteboard.general
        let changeCount = board.changeCount
        let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard ClipboardMonitor.shouldRecord(types: (board.types ?? []).map(\.rawValue), bundleID: app, excludedApps: monitor.excludedApps),
              let text = board.string(forType: .string), board.changeCount == changeCount,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            directTask = true
            error = delivery == .pin
                ? tr("Copy an image or some text first. Protected clipboard content is excluded.", "请先复制图片或文字。受保护的剪贴板内容不会使用。")
                : tr("Copy some text first. Protected clipboard content is excluded.", "请先复制文字。受保护的剪贴板内容不会用于生成。")
            notice = nil
            showTaskStatus?()
            return
        }
        let title: String
        switch actionID {
        case MediaShortcuts.pinID: title = tr("Pin to screen", "贴到屏幕")
        case "paste-card": title = tr("Create image", "生成图片")
        case "paste-gif": title = tr("Create GIF", "生成 GIF")
        case "paste-qr": title = tr("Create QR code", "生成二维码")
        default: title = tr("Create video", "生成视频")
        }
        // Pin renders exactly like ⌘⌥1 (same action, frame and template
        // preferences, so a prepared-on-copy card is a cache hit).
        execute(actionID: ClipboardShortcutDelivery.renderAction(shortcut: actionID), title: title, text: text, direct: true, delivery: delivery)
        showTaskStatus?()
    }

    func templateName(_ spec: CoreTemplateSpec) -> String { isChinese ? spec.nameZh : spec.name }
    /// A layout failure, told apart by its reason: characters the font lacks,
    /// nothing to draw, or content that really does not fit.
    func composeFailureMessage(_ failure: CoreError) -> String { ComposeFailureText.message(failure, tr: tr) }

    func variantName(_ variant: CoreTemplateVariant) -> String { isChinese ? variant.nameZh : variant.name }
    func motionName(_ motion: String) -> String {
        switch motion {
        case "typewriter": return tr("Typewriter", "打字机")
        case "reveal": return tr("Reveal", "依次呈现")
        default: return tr("Still", "静态")
        }
    }
    func frameName(_ frame: String) -> String { frame == "auto" ? tr("Auto", "自动") : frame }

    /// The saved default frame for an action, by its output kind.
    func defaultFrame(actionID: String) -> String? {
        let kind = OutputFrames.kind(output: actions.first(where: { $0.id == actionID })?.output) ?? OutputFrames.kind(actionID: actionID)
        guard let kind else { return nil }
        return settings?.frame(kind: kind) ?? OutputFrames.defaultFrame(kind: kind)
    }

    /// `frame` applies to this rerender only; the saved default is unchanged.
    func rerender(templateID: String? = nil, variant: String? = nil, motion: String? = nil, format: String? = nil, frame: String? = nil) {
        guard !busy, let output, let text = output.sourceText, let selectedTemplate = output.template else { return }
        let chosenFormat = format ?? output.format ?? "png"
        let actionID = chosenFormat == "mp4" ? "paste-video" : chosenFormat == "gif" ? "paste-gif" : "paste-card"
        let kind = OutputFrames.kind(output: chosenFormat) ?? "image"
        // Same kind keeps this result's frame; a new kind takes its saved default.
        let sameKind = OutputFrames.kind(output: output.format) == kind
        let chosenFrame = frame.map { OutputFrames.normalize($0, kind: kind) }
            ?? (sameKind ? output.frame.map { OutputFrames.normalize($0, kind: kind) } : nil)
            ?? settings?.frame(kind: kind) ?? OutputFrames.defaultFrame(kind: kind)
        let changingTemplate = templateID != nil && templateID != selectedTemplate.id
        let options = CoreTemplateOptions(id: templateID ?? selectedTemplate.id,
            variant: variant ?? (changingTemplate ? nil : selectedTemplate.variant),
            motion: motion ?? (changingTemplate || (format != nil && output.format == "png") ? nil : selectedTemplate.motion))
        execute(actionID: actionID, title: output.title, text: text, direct: false, options: options,
                frame: chosenFrame, keepPreview: true, rememberVariant: variant != nil)
    }

    private func execute(actionID: String, title: String, text: String, direct: Bool,
                         delivery: ClipboardShortcutDelivery = .paste,
                         options: CoreTemplateOptions? = nil, frame: String? = nil,
                         keepPreview: Bool = false, rememberVariant: Bool = false) {
        actionRevision += 1
        let revision = actionRevision
        error = nil; notice = nil; busy = true; needsAccessibility = false
        if !keepPreview { output = nil }
        directTask = direct
        taskStatus = tr("Preparing…", "正在准备…")
        let pendingOpening = openingTask
        panelRevision += 1
        task = Task {
            defer { busy = false; task = nil }
            do {
                // Recommendation timeouts stop the shared Core. Drain the
                // pending panel query before submitting an explicit action.
                await pendingOpening?.value
                try Task.checkCancellation()
                try await configureCore()
                try Task.checkCancellation()
                let requestedFrame = frame ?? defaultFrame(actionID: actionID)
                let input = CoreActionInput(text: text, aspect: requestedFrame,
                    template: options, templatePreferences: settings?.templatePreferences)
                taskStatus = title + "…"
                let kind = actions.first(where: { $0.id == actionID })?.output
                let timeout = CoreClient.actionTimeout(output: kind) ?? CoreClient.actionTimeout(actionID: actionID)
                guard let response = try await core?.runAction(action: actionID, input: input, timeout: timeout, onState: { [weak self] state in
                    Task { @MainActor in
                        guard let self, self.busy, self.actionRevision == revision else { return }
                        switch state {
                        case .accepted: self.taskStatus = self.tr("Accepted…", "已接收任务…")
                        case .running: self.taskStatus = title + "…"
                        case .completed: self.taskStatus = self.tr("Finishing…", "正在完成…")
                        case .failed: break
                        }
                    }
                }) else { return }
                if !Task.isCancelled {
                    output = OutputPreview(title: title, text: response.result.text,
                                           url: response.result.path.map { URL(fileURLWithPath: $0) },
                                           sourceText: text, template: response.result.meta?.template, format: response.result.format,
                                           frame: requestedFrame, precomposed: response.result.meta?.precomposed == true)
                    if templates.isEmpty, let core { templates = (try? await core.templates().templates) ?? [] }
                    try Task.checkCancellation()
                    if rememberVariant, let selected = response.result.meta?.template {
                        var preferences = settings?.values["template_styles"] as? [String: String] ?? [:]
                        preferences[selected.id] = selected.variant
                        do { try settings?.set("template_styles", value: preferences) }
                        catch { notice = tr("Created. Could not remember this style.", "已生成，但无法保存风格偏好。") }
                    }
                    if direct, let output {
                        switch delivery {
                        case .paste: deliverDirect(output)
                        case .pin:
                            if pinOutput(output) { notice = tr("Pinned to screen", "已贴到屏幕"); hideTaskStatus?() }
                        }
                    }
                }
            } catch {
                if Task.isCancelled { notice = tr("Cancelled", "已取消") }
                else if let failure = error as? CoreError, failure.message.localizedCaseInsensitiveContains("ffmpeg") {
                    self.error = tr("Video needs ffmpeg. Install it with Homebrew (brew install ffmpeg), then retry.", "视频需要 ffmpeg。通过 Homebrew 安装（brew install ffmpeg）后重试。")
                } else if let failure = error as? CoreError, failure.kind == "compose" {
                    self.error = composeFailureMessage(failure)
                } else if let failure = error as? CoreError, failure.kind == "engine", failure.message.localizedCaseInsensitiveContains("timed out") {
                    self.error = tr("Rendering took too long and was stopped. Try a shorter excerpt or a still image.", "渲染耗时过长，已停止。请缩短内容或改用静态图片。")
                } else if let failure = error as? CoreError, ["sidecar", "timeout"].contains(failure.kind) {
                    self.error = coreFailureMessage(failure)
                } else { self.error = tr("The action could not finish. Check the AI settings or try again.", "动作未能完成，请检查 AI 设置或重试。") }
            }
        }
    }

    /// Media shortcut result: paste into the app that is frontmost now.
    private func deliverDirect(_ output: OutputPreview) {
        let outcome: DirectPasteOutcome
        if let url = output.url, url.pathExtension.lowercased() == "png" {
            guard let data = try? Data(contentsOf: url) else {
                error = tr("Could not read the rendered image. Open the result to try again.", "无法读取生成的图片，请打开结果重试。"); return
            }
            outcome = paste.pasteImage(toFrontmost: data)
        } else if let url = output.url {
            outcome = paste.pasteFile(toFrontmost: url)
        } else if let text = output.text {
            outcome = paste.pasteText(toFrontmost: text)
        } else { return }
        switch outcome {
        case .pasted: notice = tr("Pasted", "已粘贴")
        case .copiedOnly(.accessibility):
            needsAccessibility = true
            notice = tr("Copied. Allow Accessibility so Peesuto can paste for you; for now, press ⌘V.",
                        "已复制。授予辅助功能权限后 Peesuto 才能替你粘贴；现在请按 ⌘V。")
        case .copiedOnly(.secureInput):
            notice = tr("Copied only: a password field is active, so Peesuto does not type into it. Press ⌘V yourself if you mean to.",
                        "仅复制：当前是密码输入状态，Peesuto 不会向其中粘贴。如确需粘贴，请自己按 ⌘V。")
        case .copiedOnly(.selfFrontmost):
            notice = tr("Copied. Switch to the app you want and press ⌘V.", "已复制。切换到目标应用后按 ⌘V。")
        case .failed:
            error = tr("Could not paste. Open the result to copy or paste it.", "未能粘贴，请打开结果后复制或粘贴。")
        }
    }

    /// Image and GIF results can be pinned; video and text cannot.
    func canPin(_ output: OutputPreview?) -> Bool {
        guard let ext = output?.url?.pathExtension.lowercased() else { return false }
        return ext == "png" || ext == "gif"
    }

    /// Shows a rendered result in a pin window. Never writes the clipboard.
    @discardableResult
    func pinOutput(_ output: OutputPreview? = nil) -> Bool {
        guard let output = output ?? self.output, canPin(output), let url = output.url,
              let image = PinImage.from(file: url), pins.pin(image) else {
            error = tr("Could not pin this result.", "无法贴到屏幕。")
            return false
        }
        return true
    }

    /// Prompts for Accessibility and opens System Settings › Privacy & Security › Accessibility.
    func openAccessibilitySettings() {
        if !previewMode { _ = PasteController.requestAccessibility() }
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    func copySelection() {
        guard !busy else { return }
        let success: Bool
        if let output {
            if let text = output.text { success = paste.copyText(text) }
            else if let url = output.url, url.pathExtension.lowercased() == "png", let data = try? Data(contentsOf: url) { success = paste.copyImage(data) }
            else if let url = output.url { success = paste.copyFile(url) }
            else { success = false }
        } else if let item = selected {
            if item.kind == "file", let text = item.text { success = paste.copyFiles(fileURLs(text)) }
            else if let text = item.text { success = paste.copyText(text) }
            else if let data = try? history?.imageData(id: item.id) { success = paste.copyImage(data) }
            else { success = false }
        } else { return }
        notice = success ? tr("Copied", "已复制") : tr("Could not copy this item.", "无法复制此项。")
    }

    func pasteSelection() {
        guard !busy else { return }
        Task {
            let result: PasteResult
            if let output {
                if let text = output.text { result = await paste.pasteText(text) }
                else if let url = output.url, url.pathExtension.lowercased() == "png", let data = try? Data(contentsOf: url) { result = await paste.pasteImage(data) }
                else if let url = output.url { result = await paste.pasteFile(url) }
                else { return }
            } else if let item = selected {
                if item.kind == "file", let text = item.text { result = await paste.pasteFiles(fileURLs(text)) }
                else if let text = item.text { result = await paste.pasteText(text) }
                else if let data = try? history?.imageData(id: item.id) { result = await paste.pasteImage(data) }
                else { return }
            } else { return }
            switch result {
            case .pasted: break
            case .copiedOnly: notice = tr("Copied. Press ⌘V in the destination app.", "已复制，请在目标应用中按 ⌘V。")
            case .failed: error = tr("Could not copy this item.", "无法复制此项。")
            }
        }
    }

    func exportOutput() {
        guard let output else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = output.url?.lastPathComponent ?? "Peesuto.txt"
        if panel.runModal() == .OK, let destination = panel.url {
            do {
                let data = try output.url.map { try Data(contentsOf: $0) } ?? Data((output.text ?? "").utf8)
                try data.write(to: destination, options: .atomic)
            } catch { self.error = tr("Could not save the result.", "无法保存结果。") }
        }
    }

    func togglePin() {
        guard let item = selected else { return }
        do { try history?.setPinned(id: item.id, pinned: !item.pinned); refresh() }
        catch { self.error = tr("Could not update this item.", "无法更新此项。") }
    }
    func deleteSelection() {
        guard let id = selectedID else { return }
        do { try history?.delete(id: id); refresh() }
        catch { self.error = tr("Could not delete this item.", "无法删除此项。") }
    }
    func setLanguage(_ value: String) {
        do { try settings?.set("language", value: value); language = value; settingsChanged?() }
        catch { self.error = tr("Could not save settings.", "无法保存设置。") }
    }
    func cancelAction() {
        task?.cancel()
        taskStatus = tr("Cancelling…", "正在取消…")
        // Also interrupts the shared startup barrier before a request has been sent.
        if let core { Task { await core.shutdown() } }
    }
    func pruneHistory() {
        do { try history?.prune(days: settings?.retentionDays ?? 30); refresh() }
        catch { self.error = tr("Could not apply history retention.", "无法执行历史保留策略。") }
    }
    private func fileURLs(_ text: String) -> [URL] {
        text.split(separator: "\n").map { value in
            let path = String(value)
            if path.hasPrefix("file://"), let url = URL(string: path) { return url }
            return URL(fileURLWithPath: path)
        }
    }
    func stop() {
        monitor.stop(); precomposer.cancel(); hotkeys.unregister(); task?.cancel(); openingTask?.cancel(); retentionTimer?.invalidate()
        if let core { Task { await core.shutdown() } }
    }
}
