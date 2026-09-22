import SwiftUI
import AppKit
import PeesutoKit

struct SettingsView: View {
    @ObservedObject var model: AppState
    var registerShortcuts: ([String: String]) throws -> Void
    var recordingChanged: (Bool) -> Void
    @State private var section = 0
    @State private var shortcuts: [String: String] = [:]
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

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Peesuto").font(.system(size: 19, weight: .semibold, design: .rounded)).padding(.horizontal, 12).padding(.bottom, 22)
                category(0, "General", "通用", "slider.horizontal.3")
                category(3, "Shortcuts", "快捷键", "keyboard")
                category(1, "AI & actions", "AI 与动作", "sparkles")
                category(2, "History & privacy", "历史与隐私", "lock.shield")
                Spacer()
                Text(model.tr("Native preview", "原生预览版")).font(.system(size: 10)).foregroundColor(.secondary).padding(12)
            }.padding(14).frame(width: 166).background(Color(NSColor.controlBackgroundColor))
            Divider()
            VStack(alignment: .leading, spacing: 20) {
                Text(section == 0 ? model.tr("General", "通用") : section == 1 ? model.tr("AI & actions", "AI 与动作") : section == 3 ? model.tr("Shortcuts", "快捷键") : model.tr("History & privacy", "历史与隐私"))
                    .font(.system(size: 22, weight: .semibold))
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if section == 0 { general }
                        if section == 1 { ai }
                        if section == 2 { privacy }
                        if section == 3 { shortcutSettings }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 4)
                }
                HStack {
                    if let feedback { Text(feedback).font(.system(size: 11)).foregroundColor(failed ? .orange : .secondary).fixedSize(horizontal: false, vertical: true) }
                    Spacer()
                    Button(model.tr("Save changes", "保存更改"), action: save).buttonStyle(.borderedProminent)
                }
            }.padding(28).frame(maxWidth: .infinity)
        }.frame(width: 650, height: 520).onAppear(perform: load)
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
        }
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
            Text(model.tr("Click a shortcut and press your keys. Clear it to disable. Changes apply after saving.", "点击快捷键后直接按键录入，清除即可停用。保存后生效。"))
                .font(.system(size: 11)).foregroundColor(.secondary)
            Text(model.tr("If the destination changes, the result is copied for manual pasting. If you copy new content, your clipboard is preserved. Video requires ffmpeg.", "输入位置变化时，只复制结果供手动粘贴；如果复制了新内容，会保留当前剪贴板。视频需要 ffmpeg。"))
                .font(.system(size: 11)).foregroundColor(.secondary)
            if model.previewMode {
                Text(model.tr("Preview checks bindings but does not register global shortcuts.", "预览版仅检查配置，不注册全局快捷键。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
        }
    }
    private func shortcutRow(_ id: String, _ en: String, _ zh: String) -> some View {
        HStack {
            Text(model.tr(en, zh)).font(.system(size: 12, weight: .medium))
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
                    Text(model.tr("Hosted", "托管服务")).tag("hosted")
                }.labelsHidden()
            }
            if generator == "openai-compatible" || generator == "hosted" {
                TextField(model.tr("Endpoint URL", "服务地址"), text: $baseURL).textFieldStyle(.roundedBorder)
            }
            if generator == "openai-compatible" || generator == "anthropic" {
                TextField(model.tr("Model", "模型名称"), text: $modelName).textFieldStyle(.roundedBorder)
            }
            if generator != "none" {
                SecureField(model.tr("New key (leave blank to keep existing)", "新密钥（留空保留现有密钥）"), text: $apiKey).textFieldStyle(.roundedBorder)
            }
            Divider()
            field(model.tr("Recommendations & card style", "推荐与卡片样式")) {
                Picker("", selection: $decider) {
                    Text(model.tr("Local rules", "本地规则")).tag("rules")
                    Text(model.tr("Basic fallback", "基础回退")).tag("none")
                    Text("Laya").tag("laya")
                    Text(model.tr("Compatible endpoint", "兼容端点")).tag("proxy")
                    Text("Cloudflare").tag("cloudflare")
                    Text(model.tr("Hosted", "托管服务")).tag("hosted")
                }.labelsHidden()
            }
            if ["laya", "proxy", "hosted"].contains(decider) {
                TextField(model.tr("Endpoint URL", "服务地址"), text: $deciderURL).textFieldStyle(.roundedBorder)
            }
            if decider == "cloudflare" { TextField("Account ID", text: $accountID).textFieldStyle(.roundedBorder) }
            if ["proxy", "hosted", "cloudflare"].contains(decider) {
                SecureField(model.tr("New token (leave blank to keep existing)", "新令牌（留空保留现有令牌）"), text: $deciderKey).textFieldStyle(.roundedBorder)
            }
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
        }
    }
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 12, weight: .medium))
            content()
        }
    }
    private func load() {
        guard let settings = model.settings else { return }
        shortcuts = model.shortcuts; retention = settings.retentionDays
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
        if section == 3 {
            let previous = model.shortcuts
            do {
                try registerShortcuts(shortcuts)
                do { try settings.setValues(["native_shortcuts": shortcuts, "hotkey": shortcuts["panel"] ?? ""]) }
                catch { try? registerShortcuts(previous); throw error }
                feedback = model.tr("Shortcuts saved", "快捷键已保存"); failed = false
            } catch {
                feedback = model.tr("Could not save shortcuts. Check for duplicates or keys used by another app.", "快捷键保存失败，请检查是否重复或被其他应用占用。")
                failed = true
            }
            return
        }
        do {
            if generator == "openai-compatible" && modelName.trimmingCharacters(in: .whitespaces).isEmpty {
                throw NSError(domain: "Settings", code: 1)
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
            var d = settings.providers["decider"] as? [String: Any] ?? [:]
            if d["kind"] as? String != decider { d = [:] }
            d["kind"] = decider
            if ["laya", "proxy", "hosted"].contains(decider) { d["url"] = deciderURL.isEmpty ? NSNull() : deciderURL as Any }
            if decider == "cloudflare" { d["accountId"] = accountID; d["tokenRef"] = "pocket-paste/cloudflare" }
            if decider == "hosted" { d["tokenRef"] = "pocket-paste/hosted" }
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
            apiKey = ""; deciderKey = ""
            feedback = model.tr("Saved", "已保存"); failed = false
            Task {
                do { try await model.configureCore() }
                catch { feedback = model.tr("Saved. Check your provider configuration before using AI actions.", "已保存，请在使用 AI 动作前检查模型配置。"); failed = true }
            }
        } catch {
            feedback = model.tr("Could not save all changes. Check the shortcut, model and endpoint.", "未能保存全部更改，请检查快捷键、模型和服务地址。")
            failed = true
        }
    }
}
