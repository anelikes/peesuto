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

/// A render the chooser started for its preview, reusable by the shortcut it previews.
struct PreparedRender {
    let text: String
    let actionID: String
    let task: Task<CoreActionResponse, Error>
}

/// The clipboard as the chooser found it.
struct ChooserSnapshot {
    let clipboard: ChooserClipboard
    let text: String?
    let image: PinImage?
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
    /// A pinned panel stays open when another window takes focus; otherwise it hides at once.
    @Published var panelPinned = false { didSet { if oldValue != panelPinned { try? settings?.set("panel_pinned", value: panelPinned) } } }
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
            // Preview only, for screenshots: --language en|zh-CN|ja (not saved).
            if preview, let index = CommandLine.arguments.firstIndex(of: "--language"), index + 1 < CommandLine.arguments.count,
               UILanguage(rawValue: CommandLine.arguments[index + 1]) != nil {
                language = CommandLine.arguments[index + 1]
            }
            offline = settings.providers["offline"] as? Bool ?? false
            panelPinned = settings.bool("panel_pinned")
            // Once per shortcut model: every binding goes back to the defaults (⌥V chooser, ⇧⌥V history).
            if (try? settings.migrateShortcutsIfNeeded()) == true, !preview {
                let chooser = Self.keys(DefaultShortcuts.chooser), panel = Self.keys(DefaultShortcuts.panel)
                notice = tr("Shortcuts changed: \(chooser) opens Paste as…, \(panel) opens clipboard history.",
                            "快捷键已更新：\(chooser) 打开「粘贴为…」，\(panel) 打开剪贴板历史。",
                            ja: "ショートカットが変わりました：\(chooser) で「形式を選んでペースト…」、\(panel) でクリップボード履歴を開きます。")
            }
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

    var localizer: Localizer { Localizer(preference: language) }
    func tr(_ english: String, _ chinese: String) -> String { localizer(english, chinese) }
    /// For text built by interpolation, which the Japanese table cannot look up.
    func tr(_ english: String, _ chinese: String, ja japanese: String) -> String { localizer(english, chinese, ja: japanese) }
    var selected: ClipRecord? { items.first { $0.id == selectedID } }
    /// An accelerator as glyphs, "⌥V"; empty when unbound.
    static func keys(_ accelerator: String) -> String { MediaShortcuts.glyphs(accelerator).joined() }
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
                                          templatePreferences: settings.templatePreferences,
                                          disabledTemplates: settings.disabledTemplates,
                                          templateFont: settings.templateFont,
                                          templateSignature: settings.templateSignature)
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
        case "paste-lyric": return tr("Paste as lyric motion", "粘贴为文字 PV")
        case "paste-translate": return tr("Translate to English", "翻译为英文")
        case "paste-summary": return tr("Summarize", "生成摘要")
        default: return action.name
        }
    }

    func run(_ action: CoreActionSpec) {
        guard !busy, let item = selected, let text = item.text, !text.isEmpty else { return }
        execute(actionID: action.id, title: actionName(action), text: text, direct: false)
    }

    /// Runs a media shortcut on the clipboard. `prepared` is the chooser's
    /// preview render (same action and input as this shortcut would send);
    /// it is used instead of a second request when it was made for the text
    /// that is on the clipboard now.
    func runClipboardAction(_ actionID: String, prepared: PreparedRender? = nil) {
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
        case "paste-lyric": title = tr("Create lyric motion", "生成文字 PV")
        default: title = tr("Create video", "生成视频")
        }
        // Pin renders exactly like Paste as image (same action, frame and template
        // preferences, so a prepared-on-copy card is a cache hit).
        let renderAction = ClipboardShortcutDelivery.renderAction(shortcut: actionID)
        let reuse = prepared.flatMap { $0.text == text && $0.actionID == renderAction ? $0.task : nil }
        execute(actionID: renderAction, title: title, text: text, direct: true, delivery: delivery, prepared: reuse)
        showTaskStatus?()
    }

    /// What the "Paste as…" chooser can work with right now, read the same
    /// way the media shortcuts read it: text only when it may be used (not
    /// concealed, not from an excluded app), an image for pin.
    func chooserSnapshot() -> ChooserSnapshot {
        let board = NSPasteboard.general
        let changeCount = board.changeCount
        let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        var text: String?
        if ClipboardMonitor.shouldRecord(types: (board.types ?? []).map(\.rawValue), bundleID: app, excludedApps: monitor.excludedApps),
           let value = board.string(forType: .string), board.changeCount == changeCount,
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text = value
        }
        let image = PinImage.read(from: board)
        return ChooserSnapshot(clipboard: text != nil ? .text : image != nil ? .image : .none, text: text, image: image)
    }

    /// Renders the image card for `text` exactly as Paste as image would
    /// (same action, frame, template preferences, disabled templates, font
    /// and signature), so a card prepared on copy comes back at once. Never
    /// cancelled: cancelling a Core request stops the shared Core.
    func startCardPreview(text: String) -> PreparedRender? {
        guard !busy, let core else { return nil }
        let actionID = "paste-card"
        let input = mediaInput(actionID: actionID, text: text, frame: nil, options: nil)
        let task = Task { () throws -> CoreActionResponse in
            try await self.configureCore()
            let kind = self.actions.first(where: { $0.id == actionID })?.output
            let timeout = CoreClient.actionTimeout(output: kind) ?? CoreClient.actionTimeout(actionID: actionID)
            return try await core.runAction(action: actionID, input: input, timeout: timeout)
        }
        return PreparedRender(text: text, actionID: actionID, task: task)
    }

    /// The input every media render sends for `actionID`.
    private func mediaInput(actionID: String, text: String, frame: String?, options: CoreTemplateOptions?) -> CoreActionInput {
        CoreActionInput(text: text, aspect: frame ?? defaultFrame(actionID: actionID),
            template: options, templatePreferences: settings?.templatePreferences,
            disabledTemplates: settings?.disabledTemplates, templateFont: settings?.templateFont,
            templateSignature: settings?.templateSignature,
            output: actionID == "paste-lyric" ? lyricOutput.rawValue : nil)
    }

    /// Lyric motion's default output (Settings › Templates).
    var lyricOutput: LyricOutput { settings?.lyricOutput ?? LyricOutput.defaultValue }
    func lyricOutputName(_ output: LyricOutput) -> String {
        switch output {
        case .gif: return "GIF"
        case .video: return tr("Video", "视频")
        case .image: return tr("Poster", "海报")
        }
    }

    /// What a render action will make: its declared output, or for paste-lyric the chosen one.
    func requestOutput(actionID: String) -> String? {
        actionID == "paste-lyric" ? lyricOutput.rawValue : actions.first(where: { $0.id == actionID })?.output
    }

    func templateName(_ spec: CoreTemplateSpec) -> String { tr(spec.name, spec.nameZh) }
    /// The template list for Settings, from Core when it has not been fetched yet; false when Core cannot answer.
    @discardableResult func loadTemplates() async -> Bool {
        if !templates.isEmpty { return true }
        guard let core, let list = try? await core.templates().templates else { return false }
        templates = list
        return true
    }
    /// A layout failure, told apart by its reason: characters the font lacks,
    /// nothing to draw, or content that really does not fit.
    func composeFailureMessage(_ failure: CoreError) -> String { ComposeFailureText.message(failure, tr: localizer) }

    func variantName(_ variant: CoreTemplateVariant) -> String { tr(variant.name, variant.nameZh) }
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
        let kind = OutputFrames.kind(output: requestOutput(actionID: actionID)) ?? OutputFrames.kind(actionID: actionID)
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
                         keepPreview: Bool = false, rememberVariant: Bool = false,
                         prepared: Task<CoreActionResponse, Error>? = nil) {
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
                let input = mediaInput(actionID: actionID, text: text, frame: requestedFrame, options: options)
                taskStatus = title + "…"
                let kind = requestOutput(actionID: actionID)
                let timeout = CoreClient.actionTimeout(output: kind) ?? CoreClient.actionTimeout(actionID: actionID)
                let response: CoreActionResponse
                if let prepared {
                    // The chooser already asked for this exact render.
                    response = try await prepared.value
                } else {
                    guard let answer = try await core?.runAction(action: actionID, input: input, timeout: timeout, onState: { [weak self] state in
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
                    response = answer
                }
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
                    // Lyric motion as video with no MP4 encoder at all (not in a normal install): say that it is a GIF.
                    if response.result.meta?.fallback?.to == "gif" {
                        let why = tr("A GIF instead of a video: the video encoder is unavailable.", "已改为 GIF：视频编码器不可用。")
                        notice = [notice, why].compactMap { $0 }.joined(separator: " ")
                    }
                }
            } catch {
                if Task.isCancelled { notice = tr("Cancelled", "已取消") }
                else if let failure = error as? CoreError, failure.kind == "action:needs", failure.message.contains("MP4") || failure.message.contains("video encoder") {
                    self.error = tr("Video could not be made: Peesuto's video encoder is missing. Reinstall Peesuto; PNG and GIF still work.", "无法生成视频：Peesuto 的视频编码器缺失。请重新安装 Peesuto；图片和 GIF 仍可使用。")
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

    /// Shown under every "Accessibility is missing" message. macOS ties the grant to the code signature
    /// that was approved, so after an update or re-sign the toggle can stay on while AXIsProcessTrusted() is false.
    var accessibilityResetHint: String {
        tr("Already on in System Settings? Remove Peesuto from the list with −, then add it again.",
           "系统设置里已经打开却无效？在列表中用「−」移除 Peesuto，再重新添加。")
    }

    /// Prompts for Accessibility and opens System Settings › Privacy & Security › Accessibility.
    func openAccessibilitySettings() {
        if !previewMode { _ = PasteController.requestAccessibility() }
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    /// Lyric-motion results: hand the text to JIZURA for a full lyric video. Its web
    /// app takes no lyrics in the URL, so they are copied (as written, markup
    /// included) and the app opens for the user to paste.
    func openInJizura() {
        guard !busy, let source = output?.sourceText ?? selected?.text else { return }
        let lyrics = JizuraHandoff.lyrics(from: source)
        guard !lyrics.isEmpty, paste.copyText(lyrics) else { error = tr("Could not copy this item.", "无法复制此项。"); return }
        NSWorkspace.shared.open(JizuraHandoff.url(for: localizer.language))
        notice = tr("Text copied — paste it in JIZURA", "文字已复制——在 JIZURA 中粘贴")
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
