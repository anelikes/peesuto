import AppKit
import SwiftUI
import PeesutoKit

struct OutputPreview {
    let title: String
    let text: String?
    let url: URL?
}

@MainActor final class AppState: ObservableObject {
    @Published var items: [ClipRecord] = []
    @Published var selectedID: String?
    @Published var query = "" { didSet { refresh() } }
    @Published var language = "system"
    @Published var actions: [CoreActionSpec] = []
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
    private var task: Task<Void, Never>?
    private var openingTask: Task<Void, Never>?
    private var retentionTimer: Timer?
    private var context: [String: Any] = ["level": 0, "appBundleId": ""]
    private var panelRevision = 0
    private var actionRevision = 0

    init(preview: Bool) {
        previewMode = preview
        directory = preview
            ? FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-native-preview-\(ProcessInfo.processInfo.processIdentifier)")
            : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("com.peesuto.desktop")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let settings = try SettingsStore(directory: directory)
            self.settings = settings
            language = settings.language
            offline = settings.providers["offline"] as? Bool ?? false
            let key = preview ? Data(repeating: 0x42, count: 32) : try KeychainSecrets.historyKey(directory: directory)
            history = try HistoryStore(directory: directory, key: key)
            if preview {
                try history?.insert(text: "Make room for a clearer thought.", sourceApp: "com.apple.Notes")
                try history?.insert(text: "把灵感留住，让表达更简单。", sourceApp: "com.apple.Safari")
                try history?.insert(text: "三个值得记录的小进展\n原生界面 · 本地历史 · 一键生成", sourceApp: "com.apple.Notes")
            }
            try history?.prune(days: settings.retentionDays)
            refresh()
            monitor.excludedApps = Set(settings.blacklist)
            monitor.onText = { [weak self] text, app in
                guard let self else { return }
                do { try self.history?.insert(text: text, sourceApp: app); self.refresh() }
                catch { self.error = self.tr("Could not save clipboard history.", "无法保存剪贴板历史。") }
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
            if !preview { monitor.start() }
            retentionTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.pruneHistory() }
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

    func tr(_ english: String, _ chinese: String) -> String { Language.text(english, chinese, preference: language) }
    var selected: ClipRecord? { items.first { $0.id == selectedID } }
    var isChinese: Bool { Language.isChinese(language) }
    var shortcuts: [String: String] {
        let saved = settings?.values["native_shortcuts"] as? [String: String] ?? [:]
        return ["panel": saved["panel"] ?? settings?.hotkey ?? "CmdOrCtrl+Shift+V",
                "paste-card": saved["paste-card"] ?? "CmdOrCtrl+Alt+1",
                "paste-gif": saved["paste-gif"] ?? "CmdOrCtrl+Alt+2",
                "paste-video": saved["paste-video"] ?? "CmdOrCtrl+Alt+3"]
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

    func configureCore() async throws {
        guard let core else { throw NSError(domain: "Peesuto", code: 1, userInfo: [NSLocalizedDescriptionKey: "Bundled Core is missing."]) }
        let config: [String: Any]
        if let settings {
            config = try settings.coreConfiguration(secretReader: { name in
                self.previewMode ? nil : try KeychainSecrets.read(name: name)
            })
        } else {
            config = ["decider": ["kind": "rules"], "generator": ["kind": "none"], "offline": true]
        }
        _ = try await core.configure(config)
    }

    func actionName(_ action: CoreActionSpec) -> String {
        guard action.builtin == true else { return action.name }
        switch action.id {
        case "paste-smart": return tr("Smart paste", "智能粘贴")
        case "paste-card": return tr("Create image", "生成图片")
        case "paste-gif": return tr("Create GIF", "生成 GIF")
        case "paste-video": return tr("Create video", "生成视频")
        case "paste-translate": return tr("Translate to English", "翻译为英文")
        case "paste-summary": return tr("Summarize", "生成摘要")
        default: return action.name
        }
    }

    func run(_ action: CoreActionSpec) {
        guard !busy, let item = selected, let text = item.text, !text.isEmpty else { return }
        execute(actionID: action.id, title: actionName(action), text: text, target: nil)
    }

    func runClipboardAction(_ actionID: String) {
        guard !previewMode else { return }
        guard !busy else { showTaskStatus?(); return }
        let board = NSPasteboard.general
        let changeCount = board.changeCount
        let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard ClipboardMonitor.shouldRecord(types: (board.types ?? []).map(\.rawValue), bundleID: app, excludedApps: monitor.excludedApps),
              let text = board.string(forType: .string), board.changeCount == changeCount,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            directTask = true
            error = tr("Copy some text first. Protected clipboard content is excluded.", "请先复制文字。受保护的剪贴板内容不会用于生成。")
            notice = nil
            showTaskStatus?()
            return
        }
        let target = paste.captureDirectTarget()
        guard ContextCapture.capture()["secure"] as? Bool != true, board.changeCount == changeCount else {
            directTask = true
            error = tr("Clipboard or input changed. Try the shortcut again.", "剪贴板或输入状态已变化，请重新按快捷键。")
            notice = nil; showTaskStatus?(); return
        }
        let title = actionID == "paste-card" ? tr("Create image", "生成图片") : actionID == "paste-gif" ? tr("Create GIF", "生成 GIF") : tr("Create video", "生成视频")
        execute(actionID: actionID, title: title, text: text, target: target)
        showTaskStatus?()
    }

    private func execute(actionID: String, title: String, text: String, target: DirectPasteTarget?) {
        actionRevision += 1
        let revision = actionRevision
        error = nil; notice = nil; busy = true
        output = nil
        directTask = target != nil
        taskStatus = tr("Preparing…", "正在准备…")
        task = Task {
            defer { busy = false; task = nil }
            do {
                try await configureCore()
                try Task.checkCancellation()
                let input = CoreActionInput(text: text, aspect: settings?.string("aspect", default: "chat") ?? "chat")
                taskStatus = title + "…"
                guard let response = try await core?.runAction(action: actionID, input: input, onState: { [weak self] state in
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
                                           url: response.result.path.map { URL(fileURLWithPath: $0) })
                    if let target, let output {
                        let result: PasteResult
                        if let url = output.url, url.pathExtension.lowercased() == "png" {
                            result = paste.pasteImage(try Data(contentsOf: url), ifUnchanged: target)
                        } else if let url = output.url {
                            result = paste.pasteFile(url, ifUnchanged: target)
                        } else if let text = output.text {
                            result = paste.pasteText(text, ifUnchanged: target)
                        } else { return }
                        switch result {
                        case .pasted: notice = tr("Pasted", "已粘贴")
                        case .copiedOnly: notice = tr("Copied. Press ⌘V where you want to paste.", "已复制，请在需要的位置按 ⌘V。")
                        case .failed: notice = tr("Ready. Clipboard unchanged; open the result to copy or paste.", "已生成，剪贴板未改动；打开结果后可复制或粘贴。")
                        }
                    }
                }
            } catch {
                if Task.isCancelled { notice = tr("Cancelled", "已取消") }
                else if let failure = error as? CoreError, failure.message.localizedCaseInsensitiveContains("ffmpeg") {
                    self.error = tr("Video needs ffmpeg. Install it with Homebrew (brew install ffmpeg), then retry.", "视频需要 ffmpeg。通过 Homebrew 安装（brew install ffmpeg）后重试。")
                } else { self.error = tr("The action could not finish. Check the AI settings or try again.", "动作未能完成，请检查 AI 设置或重试。") }
            }
        }
    }

    func copySelection() {
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
        monitor.stop(); hotkeys.unregister(); task?.cancel(); openingTask?.cancel(); retentionTimer?.invalidate()
        if let core { Task { await core.shutdown() } }
    }
}
