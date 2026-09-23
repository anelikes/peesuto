import SwiftUI
import AppKit
import ServiceManagement
import PeesutoKit

/// The hosted service (api.peesuto.com) is not live: its option is offered only
/// to a configuration that already selects it, so nobody picks a dead endpoint.
private let hostedServiceAvailable = false

struct SettingsView: View {
    @ObservedObject var model: AppState
    var registerShortcuts: ([String: String]) throws -> Void
    var recordingChanged: (Bool) -> Void
    var showOnboarding: () -> Void = {}
    @State private var section = 0
    /// Bumped after keys are saved so the "key saved" hints re-read Keychain.
    @State private var keyRevision = 0
    @State private var shortcuts: [String: String] = [:]
    @State private var frames = ["image": "auto", "gif": "1:1", "video": "1:1"]
    @State private var retention = 30
    @State private var smart = true
    @State private var blacklist = ""
    @State private var generator = "none"
    @State private var baseURL = "http://localhost:11434/v1"
    @State private var modelName = ""
    @State private var apiKey = ""
    @State private var decider = "rules"
    @State private var deciderURL = ""
    @State private var accountID = ""
    @State private var deciderKey = ""
    @State private var offline = false
    @State private var feedback: String?
    @State private var failed = false
    @State private var loginStatus = SMAppService.Status.notRegistered
    @State private var diagnostics: [String] = []
    @StateObject private var privacyState = PrivacySettingsModel()

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Peesuto").font(.system(size: 19, weight: .semibold, design: .rounded)).padding(.horizontal, 12).padding(.bottom, 22)
                category(0, "General", "通用", "slider.horizontal.3")
                category(3, "Shortcuts", "快捷键", "keyboard")
                category(1, "AI & actions", "AI 与动作", "sparkles")
                category(2, "History & privacy", "历史与隐私", "lock.shield")
                category(4, "Privacy & precompose", "隐私与预合成", "eye.slash")
                category(5, "Templates", "模板", "square.grid.2x2")
                Spacer()
                Text(model.tr("Native preview", "原生预览版")).font(.system(size: 10)).foregroundColor(.secondary).padding(12)
            }.padding(14).frame(width: 166).background(Color(NSColor.controlBackgroundColor))
            Divider()
            VStack(alignment: .leading, spacing: 20) {
                Text(section == 0 ? model.tr("General", "通用") : section == 1 ? model.tr("AI & actions", "AI 与动作") : section == 3 ? model.tr("Shortcuts", "快捷键") : section == 4 ? model.tr("Privacy & precompose", "隐私与预合成") : section == 5 ? model.tr("Templates", "模板") : model.tr("History & privacy", "历史与隐私"))
                    .font(.system(size: 22, weight: .semibold))
                ScrollViewReader { scroller in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            if section == 0 { general }
                            if section == 1 { ai }
                            if section == 2 { privacy }
                            if section == 3 { shortcutSettings }
                            if section == 4 { PrivacySettingsView(model: model, state: privacyState) }
                            if section == 5 { TemplatesSettingsView(model: model) }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 4)
                    }
                    .onReceive(model.$requestedSettingsAnchor) { anchor in
                        guard let anchor else { return }
                        DispatchQueue.main.async { scroller.scrollTo(anchor, anchor: .top) }
                        model.requestedSettingsAnchor = nil
                    }
                }
                HStack {
                    if let feedback { Text(feedback).font(.system(size: 11)).foregroundColor(failed ? .orange : .secondary).fixedSize(horizontal: false, vertical: true) }
                    Spacer()
                    if section == 5 {
                        Text(model.tr("Changes apply immediately", "更改即时生效")).font(.system(size: 11)).foregroundColor(.secondary)
                    } else {
                        Button(model.tr("Save changes", "保存更改"), action: save).buttonStyle(.borderedProminent)
                    }
                }
            }.padding(28).frame(maxWidth: .infinity)
        }.frame(width: 650, height: 520).onAppear(perform: load)
            .onReceive(model.$requestedSettingsSection) { requested in
                guard let requested else { return }
                section = requested; feedback = nil
                model.requestedSettingsSection = nil
            }
            .onChange(of: model.settingsRevision) { _ in
                // Onboarding saved prepare-on-copy or the decider; show the saved values.
                if let settings = model.settings {
                    privacyState.outputs = Set(settings.precomposeSettings.outputs)
                    decider = (settings.providers["decider"] as? [String: Any])?["kind"] as? String ?? "rules"
                }
            }
            .onChange(of: generator) { kind in
                apiKey = ""
                let existing = model.settings?.providers["generator"] as? [String: Any] ?? [:]
                if existing["kind"] as? String == kind {
                    baseURL = existing["baseUrl"] as? String ?? existing["url"] as? String ?? (kind == "hosted" ? "https://api.peesuto.com" : "http://localhost:11434/v1")
                    modelName = existing["model"] as? String ?? ""
                } else {
                    baseURL = kind == "hosted" ? "https://api.peesuto.com" : "http://localhost:11434/v1"
                    modelName = ""
                }
            }
            .onChange(of: decider) { kind in
                deciderKey = ""
                let existing = model.settings?.providers["decider"] as? [String: Any] ?? [:]
                if existing["kind"] as? String == kind {
                    deciderURL = existing["url"] as? String ?? ""
                    accountID = existing["accountId"] as? String ?? ""
                } else {
                    deciderURL = kind == "laya" ? "http://127.0.0.1:8790/" : kind == "hosted" ? "https://api.peesuto.com" : "http://localhost:8787/"
                    accountID = ""
                }
            }
    }

    private func category(_ id: Int, _ en: String, _ zh: String, _ symbol: String) -> some View {
        Button { section = id; feedback = nil } label: {
            Label(model.tr(en, zh), systemImage: symbol).font(.system(size: 12, weight: .medium))
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 7).fill(section == id ? Color.accentColor.opacity(0.12) : .clear))
                // A plain button only hit-tests what it draws; the whole row must respond.
                .contentShape(RoundedRectangle(cornerRadius: 7))
        }.buttonStyle(.plain)
    }
    private var general: some View {
        VStack(alignment: .leading, spacing: 20) {
            field(model.tr("Language", "语言")) {
                Picker("", selection: Binding(get: { model.language }, set: { model.setLanguage($0) })) {
                    Text(model.tr("Follow system", "跟随系统")).tag("system")
                    Text("简体中文").tag("zh-CN")
                    Text("English").tag("en")
                }.labelsHidden().accessibilityLabel(model.tr("Language", "语言"))
            }
            Toggle(model.tr("Suggest relevant history", "推荐相关历史记录"), isOn: $smart)
            VStack(alignment: .leading, spacing: 6) {
                Toggle(model.tr("Open at login", "登录时打开"), isOn: Binding(get: { loginStatus == .enabled || loginStatus == .requiresApproval }, set: setOpenAtLogin))
                    .disabled(model.previewMode)
                if model.previewMode {
                    Text(model.tr("Not available in the preview build.", "预览版不可用。")).font(.system(size: 11)).foregroundColor(.secondary)
                } else if loginStatus == .requiresApproval {
                    HStack {
                        Text(model.tr("Allow Peesuto in System Settings → Login Items.", "请在「系统设置 → 登录项」中允许 Peesuto。")).font(.system(size: 11)).foregroundColor(.secondary)
                        Button(model.tr("Open Login Items", "打开登录项")) { SMAppService.openSystemSettingsLoginItems() }.controlSize(.small)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 9) {
                Label(model.tr("Paste into other apps", "粘贴到其他应用"), systemImage: "keyboard")
                    .font(.system(size: 13, weight: .medium))
                Text(model.tr("Accessibility allows Peesuto to restore focus and paste. Copy works without it.", "辅助功能权限用于恢复焦点和粘贴。未授权时仍可复制。"))
                    .font(.system(size: 12)).foregroundColor(.secondary)
                HStack {
                    Text(model.tr(model.trusted ? "Access granted" : "Access not granted", model.trusted ? "已授权" : "尚未授权")).font(.system(size: 12)).foregroundColor(.secondary)
                    Spacer()
                    Button(model.tr("Open permissions", "前往授权")) {
                        if !model.previewMode { _ = PasteController.requestAccessibility() }
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label(model.tr("Core diagnostics", "核心服务诊断"), systemImage: "stethoscope").font(.system(size: 13, weight: .medium))
                    Spacer()
                    Button(model.tr("Refresh", "刷新")) { diagnostics = model.core?.recentDiagnostics ?? [] }.controlSize(.small)
                }
                Text(model.tr("Recent Core error output, kept in memory only (last 20 lines).", "最近的核心服务错误输出，仅保存在内存中（最后 20 行）。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
                ScrollView {
                    Text(diagnostics.isEmpty ? model.tr("No messages.", "暂无消息。") : diagnostics.joined(separator: "\n"))
                        .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }.frame(height: 90).overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.25)))
            }
            Divider()
            about.id("about")
        }
    }
    private var about: some View {
        HStack(spacing: 12) {
            if let icon = NSImage(named: NSImage.applicationIconName) {
                Image(nsImage: icon).resizable().frame(width: 34, height: 34)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(model.tr("About Peesuto", "关于 Peesuto")).font(.system(size: 13, weight: .medium))
                Text(model.tr("Version ", "版本 ") + Self.version).font(.system(size: 11)).foregroundColor(.secondary)
            }
            Spacer()
            Button(model.tr("Show welcome guide", "重新查看欢迎引导"), action: showOnboarding).buttonStyle(.link)
        }
    }
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "dev"
        if let build = info["CFBundleVersion"] as? String, !build.isEmpty { return "\(short) (\(build))" }
        return short
    }
    private func setOpenAtLogin(_ enabled: Bool) {
        guard !model.previewMode else { return }
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            feedback = nil; failed = false
        } catch {
            feedback = model.tr("Could not change the login item. Check System Settings → Login Items.", "无法更改登录项，请检查「系统设置 → 登录项」。")
            failed = true
        }
        loginStatus = SMAppService.mainApp.status
    }
    private var shortcutSettings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(model.tr("Copy text, then use a shortcut to create and paste it.", "复制文字后，按快捷键即可生成并粘贴。"))
                .font(.system(size: 12)).foregroundColor(.secondary)
            shortcutRow("panel", "Open clipboard", "打开剪贴板")
            Divider()
            shortcutRow("paste-card", "Paste as image", "粘贴为图片")
            shortcutRow("paste-gif", "Paste as GIF", "粘贴为 GIF")
            shortcutRow("paste-video", "Paste as video", "粘贴为视频")
            VStack(alignment: .leading, spacing: 4) {
                shortcutRow("paste-qr", "Paste as QR code", "粘贴为二维码", symbol: "qrcode")
                Text(model.tr("Any content can become a QR code, so it never takes part in automatic template choice. Use this shortcut or the result window's template menu.",
                              "任何内容都能转成二维码，所以它不参与自动选模板，只用这个快捷键或结果窗的模板菜单。"))
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(.top, 6)
            VStack(alignment: .leading, spacing: 4) {
                shortcutRow(MediaShortcuts.pinID, "Pin to screen", "贴到屏幕", symbol: "pin")
                Text(model.tr("Pins a copied image, or the image card of copied text, in a floating window. Nothing is pasted and the clipboard is left alone.",
                              "把复制的图片（或复制文字生成的图片卡片）贴在屏幕上的浮动窗口里。不会粘贴，也不改动剪贴板。"))
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            prepareOnCopy.id("prepare")
            Divider()
            Text(model.tr("Click a shortcut and press your keys. Clear it to disable. Changes apply after saving.", "点击快捷键后直接按键录入，清除即可停用。保存后生效。"))
                .font(.system(size: 11)).foregroundColor(.secondary)
            Text(model.tr("The result is pasted into the app in front and stays on the clipboard. Without Accessibility, or in a password field, it is only copied. Video requires ffmpeg.", "结果会粘贴到当前最前面的应用，并保留在剪贴板中。未授予辅助功能权限或在密码输入框中时只复制。视频需要 ffmpeg。"))
                .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.previewMode {
                Text(model.tr("Preview checks bindings but does not register global shortcuts.", "预览版仅检查配置，不注册全局快捷键。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            Divider()
            frameRow("image", "Image frame", "图片画幅")
            frameRow("gif", "GIF frame", "GIF 画幅")
            frameRow("video", "Video frame", "视频画幅")
            Text(model.tr("Images fit their content by default. GIF and video keep a fixed frame and scroll long content.", "图片默认贴合内容；GIF 与视频保持固定画幅，长内容会滚动呈现。"))
                .font(.system(size: 11)).foregroundColor(.secondary)
        }
    }
    /// Bound to the same state as 「隐私与预合成」 (`privacyState.outputs`).
    private var prepareOnCopy: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(model.tr("Prepare on copy", "复制后预先生成"), systemImage: "bolt").font(.system(size: 13, weight: .medium))
            HStack(spacing: 18) {
                prepareToggle("image", "Image", "图片")
                prepareToggle("gif", "GIF", "GIF")
                prepareToggle("video", "Video", "视频")
            }
            Text(model.tr("Copying renders in the background with local rules, so the shortcut pastes instantly. Pauses in Low Power Mode.",
                          "复制时用本地规则在后台提前生成，按快捷键即可立即粘贴。低电量模式下暂停。"))
                .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func prepareToggle(_ kind: String, _ en: String, _ zh: String) -> some View {
        Toggle(model.tr(en, zh), isOn: Binding(
            get: { privacyState.outputs.contains(kind) },
            set: { if $0 { privacyState.outputs.insert(kind) } else { privacyState.outputs.remove(kind) } }))
            .toggleStyle(.checkbox)
    }
    private func frameRow(_ kind: String, _ en: String, _ zh: String) -> some View {
        HStack {
            Text(model.tr(en, zh)).font(.system(size: 12, weight: .medium))
            Spacer()
            Picker("", selection: Binding(get: { frames[kind] ?? OutputFrames.defaultFrame(kind: kind) }, set: { frames[kind] = $0 })) {
                ForEach(OutputFrames.options(kind: kind), id: \.self) { Text(model.frameName($0)).tag($0) }
            }.labelsHidden().pickerStyle(.segmented).frame(width: kind == "image" ? 260 : 210)
                .accessibilityLabel(model.tr(en, zh))
        }
    }
    private func shortcutRow(_ id: String, _ en: String, _ zh: String, symbol: String? = nil) -> some View {
        HStack {
            if let symbol { Label(model.tr(en, zh), systemImage: symbol).font(.system(size: 12, weight: .medium)) }
            else { Text(model.tr(en, zh)).font(.system(size: 12, weight: .medium)) }
            Spacer()
            ShortcutRecorder(value: Binding(get: { shortcuts[id] ?? "" }, set: { shortcuts[id] = $0 }),
                             emptyTitle: model.tr("Disabled", "未启用"), recordingTitle: model.tr("Press shortcut…", "请按快捷键…"),
                             recordingChanged: recordingChanged).frame(width: 155, height: 28)
                .accessibilityLabel(model.tr(en, zh))
            Button { shortcuts[id] = "" } label: { Image(systemName: "xmark.circle.fill").foregroundColor(.secondary) }
                .buttonStyle(.plain).help(model.tr("Disable shortcut", "停用快捷键"))
        }
    }
    private var ai: some View {
        VStack(alignment: .leading, spacing: 16) {
            Toggle(model.tr("Offline mode", "离线模式"), isOn: $offline)
            Text(model.tr("Cards and GIFs render locally. Text actions use the provider you choose.", "图片与 GIF 在本机生成。文本动作使用你选择的模型服务。"))
                .font(.system(size: 12)).foregroundColor(.secondary)
            field(model.tr("Text generation", "文本生成")) {
                Picker("", selection: $generator) {
                    Text(model.tr("Not configured", "暂不配置")).tag("none")
                    Text("OpenAI compatible / Ollama").tag("openai-compatible")
                    Text("Anthropic").tag("anthropic")
                    ForEach(JevService.allCases.filter(\.hasGenerator)) { Text($0.label).tag($0.rawValue) }
                    if hostedServiceAvailable || generator == "hosted" { Text(model.tr("Hosted", "托管服务")).tag("hosted") }
                }.labelsHidden()
            }
            if generator == "openai-compatible" || generator == "hosted" {
                TextField(model.tr("Endpoint URL", "服务地址"), text: $baseURL).textFieldStyle(.roundedBorder)
            }
            if generator == "openai-compatible" || generator == "anthropic" {
                TextField(model.tr("Model", "模型名称"), text: $modelName).textFieldStyle(.roundedBorder)
            }
            if let service = JevService(rawValue: generator) {
                TextField(model.tr("Model, e.g. anthropic/claude-sonnet-5", "模型，例如 anthropic/claude-sonnet-5"), text: $modelName).textFieldStyle(.roundedBorder)
                serviceKey(service, text: $apiKey)
            } else if generator != "none" {
                SecureField(model.tr("New key (leave blank to keep existing)", "新密钥（留空保留现有密钥）"), text: $apiKey).textFieldStyle(.roundedBorder)
            }
            Divider()
            field(model.tr("Recommendations & card style", "推荐与卡片样式")) {
                Picker("", selection: $decider) {
                    Text(model.tr("Local rules", "本地规则")).tag("rules")
                    Text(model.tr("Basic fallback", "基础回退")).tag("none")
                    Text("Laya").tag("laya")
                    Text(model.tr("Compatible endpoint", "兼容端点")).tag("proxy")
                    Text("Jev · Cloudflare").tag("cloudflare")
                    ForEach(JevService.allCases) { Text("Jev · \($0.label)").tag($0.rawValue) }
                    if hostedServiceAvailable || decider == "hosted" { Text(model.tr("Hosted", "托管服务")).tag("hosted") }
                }.labelsHidden()
            }
            if ["laya", "proxy", "hosted"].contains(decider) {
                TextField(model.tr("Endpoint URL", "服务地址"), text: $deciderURL).textFieldStyle(.roundedBorder)
            }
            if decider == "cloudflare" { TextField("Account ID", text: $accountID).textFieldStyle(.roundedBorder) }
            if ["proxy", "hosted", "cloudflare"].contains(decider) {
                SecureField(model.tr("New token (leave blank to keep existing)", "新令牌（留空保留现有令牌）"), text: $deciderKey).textFieldStyle(.roundedBorder)
            }
            if let service = JevService(rawValue: decider) { serviceKey(service, text: $deciderKey) }
        }
    }
    /// A Jev service's key: one Keychain item shared by its decider and its text models.
    private func serviceKey(_ service: JevService, text: Binding<String>) -> some View {
        let saved = keyRevision >= 0 && KeychainSecrets.has(name: service.keychainName)
        return VStack(alignment: .leading, spacing: 5) {
            SecureField(saved ? model.tr("\(service.label) key saved (enter a new one to replace it)", "已保存 \(service.label) 密钥（输入新密钥可替换）")
                              : model.tr("\(service.label) API key", "\(service.label) API 密钥"), text: text).textFieldStyle(.roundedBorder)
            HStack(spacing: 4) {
                Text(service.hasGenerator ? model.tr("The same key serves Jev and text generation.", "同一个密钥可同时用于 Jev 和文本生成。")
                                          : model.tr("Used for Jev only.", "仅用于 Jev。"))
                Link(model.tr("Get a key", "获取密钥"), destination: service.keyURL)
            }.font(.system(size: 11)).foregroundColor(.secondary)
        }
    }
    private var privacy: some View {
        VStack(alignment: .leading, spacing: 18) {
            field(model.tr("Keep history", "保留历史")) {
                Picker("", selection: $retention) {
                    Text(model.tr("7 days", "7 天")).tag(7)
                    Text(model.tr("30 days", "30 天")).tag(30)
                    Text(model.tr("90 days", "90 天")).tag(90)
                    Text(model.tr("Forever", "永久")).tag(0)
                    if ![0, 7, 30, 90].contains(retention) { Text("\(retention)").tag(retention) }
                }.labelsHidden()
            }
            Text(model.tr("Pinned items are kept. History and images are encrypted on this Mac.", "置顶内容会保留。历史与图片在本机加密存储。"))
                .font(.system(size: 12)).foregroundColor(.secondary)
            field(model.tr("Excluded apps · one bundle ID per line", "排除的应用 · 每行一个应用标识")) {
                TextEditor(text: $blacklist).font(.system(size: 11, design: .monospaced)).frame(height: 105)
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.25)))
            }
            Text(model.tr("Password and transient clipboard types are always excluded. Provider credentials stay in Keychain.", "密码和临时剪贴板类型始终排除。模型凭证保存在钥匙串。"))
                .font(.system(size: 12)).foregroundColor(.secondary)
            Divider()
            if model.historyLocked {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.tr("History is locked. New copies are kept for this session only.", "历史记录已锁定，新复制的内容暂时只保留在本次运行中。"))
                        .font(.system(size: 12)).foregroundColor(.orange)
                    Button(model.tr("Start fresh…", "重新开始…"), action: model.confirmStartFresh)
                }
            }
            HStack {
                Text(model.tr("Remove every history item from this Mac.", "从本机删除全部历史记录。")).font(.system(size: 12)).foregroundColor(.secondary)
                Spacer()
                Button(model.tr("Clear history…", "清空历史…"), action: model.confirmClearHistory).disabled(model.history == nil)
            }
        }
    }
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            content()
        }
    }
    private func load() {
        if !model.previewMode { loginStatus = SMAppService.mainApp.status }
        diagnostics = model.core?.recentDiagnostics ?? []
        guard let settings = model.settings else { return }
        privacyState.load(model)
        shortcuts = model.shortcuts; retention = settings.retentionDays
        frames = ["image": settings.frame(kind: "image"), "gif": settings.frame(kind: "gif"), "video": settings.frame(kind: "video")]
        smart = settings.bool("smart_paste", default: true)
        blacklist = settings.blacklist.joined(separator: "\n")
        offline = settings.providers["offline"] as? Bool ?? false
        let g = settings.providers["generator"] as? [String: Any] ?? [:]
        generator = g["kind"] as? String ?? "none"
        baseURL = g["baseUrl"] as? String ?? g["url"] as? String ?? "http://localhost:11434/v1"
        modelName = g["model"] as? String ?? ""
        let d = settings.providers["decider"] as? [String: Any] ?? [:]
        decider = d["kind"] as? String ?? "rules"
        deciderURL = d["url"] as? String ?? ""
        accountID = d["accountId"] as? String ?? ""
    }
    private func save() {
        guard let settings = model.settings else { return }
        if section == 4 {
            Task {
                let (message, error) = await privacyState.save(model)
                feedback = message; failed = error
            }
            return
        }
        if section == 3 {
            do {
                try settings.setFrames(frames)
                try settings.setPrecomposeOutputs(Array(privacyState.outputs))
            } catch {
                feedback = model.tr("Could not save the frames.", "画幅保存失败。"); failed = true
                return
            }
            Task { _ = try? await model.configureCore() }
            let previous = model.shortcuts
            do {
                try registerShortcuts(shortcuts)
                do { try settings.setValues(["native_shortcuts": shortcuts, "hotkey": shortcuts["panel"] ?? ""]) }
                catch { try? registerShortcuts(previous); throw error }
                feedback = model.tr("Saved", "已保存"); failed = false
            } catch {
                feedback = model.tr("Could not save shortcuts. Check for duplicates or keys used by another app.", "快捷键保存失败，请检查是否重复或被其他应用占用。")
                failed = true
            }
            return
        }
        do {
            if (generator == "openai-compatible" || JevService(rawValue: generator) != nil) && modelName.trimmingCharacters(in: .whitespaces).isEmpty {
                throw NSError(domain: "Settings", code: 1)
            }
            // A Jev service needs a key, typed now or saved before.
            let typed = [(generator, apiKey), (decider, deciderKey)]
            for (kind, _) in typed {
                guard let service = JevService(rawValue: kind), !model.previewMode else { continue }
                let hasTyped = typed.contains { $0.0 == kind && !$0.1.isEmpty }
                if !hasTyped && !KeychainSecrets.has(name: service.keychainName) { throw SettingsError.missingCredential }
            }
            for value in [generator == "openai-compatible" ? baseURL : "", ["laya", "proxy"].contains(decider) ? deciderURL : ""] where !value.isEmpty {
                guard let url = URL(string: value), ["https", "http"].contains(url.scheme ?? ""), url.host != nil else { throw NSError(domain: "Settings", code: 2) }
            }
            try settings.set("retention_days", value: retention)
            try settings.set("smart_paste", value: smart)
            let excluded = blacklist.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            try settings.set("blacklist", value: excluded)
            model.monitor.excludedApps = Set(excluded)
            var g = settings.providers["generator"] as? [String: Any] ?? [:]
            if g["kind"] as? String != generator { g = [:] }
            g["kind"] = generator
            if generator == "openai-compatible" { g["baseUrl"] = baseURL; g["model"] = modelName }
            if generator == "anthropic" { g["model"] = modelName.isEmpty ? NSNull() : modelName as Any }
            if generator == "hosted" { g["url"] = baseURL.isEmpty ? "https://api.peesuto.com" : baseURL; g["tokenRef"] = "pocket-paste/hosted" }
            if ["openai-compatible", "anthropic", "hosted"].contains(generator) && !apiKey.isEmpty && !model.previewMode {
                let name = generator == "hosted" ? "pocket-paste/hosted" : "pocket-paste/generator"
                try KeychainSecrets.write(name: name, value: apiKey)
                g[generator == "hosted" ? "tokenRef" : "apiKeyRef"] = name
            }
            if generator == "anthropic" { g["apiKeyRef"] = "pocket-paste/generator" }
            if let service = JevService(rawValue: generator) {
                g["model"] = modelName; g["apiKeyRef"] = service.keychainName
                if !apiKey.isEmpty && !model.previewMode { try KeychainSecrets.write(name: service.keychainName, value: apiKey.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            var d = settings.providers["decider"] as? [String: Any] ?? [:]
            if d["kind"] as? String != decider { d = [:] }
            d["kind"] = decider
            if ["laya", "proxy", "hosted"].contains(decider) { d["url"] = deciderURL.isEmpty ? NSNull() : deciderURL as Any }
            if decider == "cloudflare" { d["accountId"] = accountID; d["tokenRef"] = "pocket-paste/cloudflare" }
            if decider == "hosted" { d["tokenRef"] = "pocket-paste/hosted" }
            if let service = JevService(rawValue: decider) {
                d["tokenRef"] = service.keychainName
                if !deciderKey.isEmpty && !model.previewMode { try KeychainSecrets.write(name: service.keychainName, value: deciderKey.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            if ["proxy", "hosted", "cloudflare"].contains(decider) && !deciderKey.isEmpty && !model.previewMode {
                let name = "pocket-paste/" + (decider == "cloudflare" ? "cloudflare" : decider == "hosted" ? "hosted" : "proxy")
                try KeychainSecrets.write(name: name, value: deciderKey)
                d["tokenRef"] = name
            }
            try settings.setProvider(track: "generator", fields: g)
            try settings.setProvider(track: "decider", fields: d)
            try settings.setOffline(offline)
            model.offline = offline
            model.pruneHistory()
            apiKey = ""; deciderKey = ""; keyRevision += 1
            feedback = model.tr("Saved", "已保存"); failed = false
            Task {
                do {
                    if try await !model.configureCore() {
                        feedback = model.tr("Saved. AI settings apply when the current task finishes.", "已保存。AI 设置将在当前任务完成后生效。")
                    }
                } catch { feedback = model.tr("Saved. Check your provider configuration before using AI actions.", "已保存，请在使用 AI 动作前检查模型配置。"); failed = true }
            }
        } catch SettingsError.missingCredential {
            feedback = model.tr("Enter an API key for the selected service.", "请为所选服务填写 API 密钥。"); failed = true
        } catch {
            feedback = model.tr("Could not save all changes. Check the shortcut, model and endpoint.", "未能保存全部更改，请检查快捷键、模型和服务地址。")
            failed = true
        }
    }
}
