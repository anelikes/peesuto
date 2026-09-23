import SwiftUI
import PeesutoKit

/// State of the 「隐私与预合成」 settings section. Saved to settings.json
/// (`privacy`, `precompose`; see PeesutoKit/Privacy.swift) and sent with
/// `config.set`.
@MainActor final class PrivacySettingsModel: ObservableObject {
    @Published var outputs: Set<String> = []
    @Published var useModel = false
    @Published var skipSecrets = true
    @Published var modelContent = "redacted"
    @Published var builtinOverrides: [String: Bool] = [:]
    @Published var rules: [PrivacyRule] = []
    @Published var builtins: [CorePrivacyBuiltin] = PrivacyBuiltins.fallback
    @Published var builtinsFromCore = false
    /// Errors reported by Core for a rule, keyed by rule id.
    @Published var ruleErrors: [String: String] = [:]
    @Published var previewText = ""
    @Published var preview: CorePrivacyPreview?
    @Published var previewError: String?
    @Published var previewing = false

    var privacy: PrivacySettings {
        PrivacySettings(modelContent: modelContent, builtins: builtinOverrides, rules: rules)
    }
    var precompose: PrecomposeSettings {
        PrecomposeSettings(outputs: Array(outputs), useModel: useModel, skipSecrets: skipSecrets)
    }

    func load(_ app: AppState) {
        guard let settings = app.settings else { return }
        let privacy = settings.privacySettings, precompose = settings.precomposeSettings
        outputs = Set(precompose.outputs); useModel = precompose.useModel; skipSecrets = precompose.skipSecrets
        modelContent = privacy.modelContent; builtinOverrides = privacy.builtins; rules = privacy.rules
        ruleErrors = [:]
        // A running action occupies the sequential daemon; do not queue behind it.
        guard let core = app.core, !app.busy else { return }
        Task {
            do {
                try await app.configureCore()
                let listed = try await core.privacyRules().builtins
                if !listed.isEmpty { builtins = listed; builtinsFromCore = true }
            } catch { builtinsFromCore = false }
        }
    }

    func isEnabled(_ builtin: CorePrivacyBuiltin) -> Bool {
        builtinOverrides[builtin.id] ?? builtin.defaultEnabled
    }
    func setEnabled(_ builtin: CorePrivacyBuiltin, _ enabled: Bool) {
        // Only differences from the default are stored.
        builtinOverrides[builtin.id] = enabled == builtin.defaultEnabled ? nil : enabled
    }

    func upsert(_ rule: PrivacyRule) {
        ruleErrors[rule.id] = nil
        if let index = rules.firstIndex(where: { $0.id == rule.id }) { rules[index] = rule } else { rules.append(rule) }
    }
    func delete(_ rule: PrivacyRule) {
        rules.removeAll { $0.id == rule.id }; ruleErrors[rule.id] = nil
    }

    /// Returns (message, failed). A rule Core rejects is shown next to that
    /// rule and the previous saved configuration is restored, so an invalid
    /// rule never stays in settings.json.
    func save(_ app: AppState) async -> (String, Bool) {
        guard let settings = app.settings else { return (app.tr("Could not save settings.", "无法保存设置。"), true) }
        ruleErrors = [:]
        if let invalid = rules.first(where: { $0.problem != nil }) {
            ruleErrors[invalid.id] = problemText(invalid.problem!, app)
            return (app.tr("Fix the highlighted rule before saving.", "请先修正标出的规则再保存。"), true)
        }
        if rules.count > PrivacyRule.maxRules {
            return (app.tr("At most 100 custom rules.", "自定义规则最多 100 条。"), true)
        }
        let previous = (settings.privacySettings, settings.precomposeSettings)
        do { try settings.setPrivacy(privacy, precompose: precompose) }
        catch { return (app.tr("Could not save settings.", "无法保存设置。"), true) }
        do {
            if try await !app.configureCore() {
                return (app.tr("Saved. Applies when the current task finishes.", "已保存，将在当前任务完成后生效。"), false)
            }
            return (app.tr("Saved", "已保存"), false)
        } catch let failure as CoreError where failure.kind == "usage" {
            try? settings.setPrivacy(previous.0, precompose: previous.1)
            _ = try? await app.configureCore()
            if let rule = rules.first(where: { failure.message.contains($0.id) || (!$0.name.isEmpty && failure.message.contains($0.name)) }) {
                ruleErrors[rule.id] = failure.message
                return (app.tr("Not saved: Core rejected a rule.", "未保存：有规则被核心服务拒绝。"), true)
            }
            return (app.tr("Not saved: ", "未保存：") + failure.message, true)
        } catch {
            return (app.tr("Saved. Core is not reachable right now; settings apply when it starts.", "已保存。核心服务暂不可用，启动后生效。"), false)
        }
    }

    func runPreview(_ app: AppState) {
        guard let core = app.core, !previewText.isEmpty else { return }
        guard !app.busy else { previewError = app.tr("Wait for the current task to finish.", "请等待当前任务完成。"); return }
        previewing = true; previewError = nil
        let text = previewText
        Task {
            defer { previewing = false }
            do {
                try await app.configureCore()
                preview = try await core.privacyPreview(text: text)
            } catch {
                preview = nil
                previewError = app.tr("Core is not reachable.", "核心服务暂不可用。")
            }
        }
    }

    func problemText(_ problem: PrivacyRule.ValidationProblem, _ app: AppState) -> String {
        switch problem {
        case .emptyPattern: return app.tr("Enter what to match.", "请填写要匹配的内容。")
        case .patternTooLong: return app.tr("The pattern is longer than 500 characters.", "匹配内容超过 500 个字符。")
        case .replacementTooLong: return app.tr("The replacement is longer than 100 characters.", "替换文字超过 100 个字符。")
        case .invalidRegex: return app.tr("This is not a valid regular expression.", "正则表达式无效。")
        }
    }
}

struct PrivacySettingsView: View {
    @ObservedObject var model: AppState
    @ObservedObject var state: PrivacySettingsModel
    @State private var editing: PrivacyRule?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            precomposeSection
            Divider()
            modelContentSection
            Divider()
            builtinSection
            Divider()
            customSection
            Divider()
            testSection
        }
        .sheet(item: $editing) { rule in
            RuleEditor(model: model, state: state, draft: rule) { editing = nil }
        }
    }

    private func caption(_ en: String, _ zh: String, warning: Bool = false) -> some View {
        Text(model.tr(en, zh)).font(.system(size: 11)).foregroundColor(warning ? .orange : .secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
    private func heading(_ en: String, _ zh: String) -> some View {
        Text(model.tr(en, zh)).font(.system(size: 13, weight: .semibold))
    }

    private var precomposeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            heading("Precompose", "预合成")
            HStack(spacing: 16) {
                outputToggle("image", "Image", "图片")
                outputToggle("gif", "GIF", "GIF")
                outputToggle("video", "Video", "视频")
            }
            caption("Renders each copied text in the background so the paste shortcut returns at once. Uses extra CPU and battery; pauses in Low Power Mode and when the Mac is hot.",
                    "每次复制文字后在后台提前生成，按快捷键即可立即粘贴。会额外占用 CPU 与电量；低电量模式或机器过热时暂停。")
            Toggle(model.tr("Precompose also uses the AI model", "预合成也使用 AI 模型"), isOn: $state.useModel)
                .disabled(state.outputs.isEmpty)
            if state.useModel {
                caption("Every text you copy is then sent to the model, processed as set in “Content sent to the AI model” below.",
                        "开启后，每一段复制的文字都会发给模型，按下方「发给 AI 模型的内容」处理。", warning: true)
            } else {
                caption("Off: local rules choose the template for precompose.", "关闭时，预合成由本地规则选择模板。")
            }
            Toggle(model.tr("Don’t precompose text that contains a secret", "包含密钥时不预合成"), isOn: $state.skipSecrets)
                .disabled(state.outputs.isEmpty)
        }
    }
    private func outputToggle(_ kind: String, _ en: String, _ zh: String) -> some View {
        Toggle(model.tr(en, zh), isOn: Binding(
            get: { state.outputs.contains(kind) },
            set: { if $0 { state.outputs.insert(kind) } else { state.outputs.remove(kind) } }))
            .toggleStyle(.checkbox)
    }

    private var modelContentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("Content sent to the AI model", "发给 AI 模型的内容")
            Picker("", selection: $state.modelContent) {
                Text(model.tr("Original text", "原文")).tag("raw")
                Text(model.tr("Redact sensitive info", "敏感信息脱敏")).tag("redacted")
                Text(model.tr("Structure only", "仅发结构")).tag("structure")
            }.labelsHidden().pickerStyle(.segmented).frame(width: 380)
                .accessibilityLabel(model.tr("Content sent to the AI model", "发给 AI 模型的内容"))
            switch state.modelContent {
            case "raw": caption("The model sees your text as copied.", "模型看到的就是你复制的原文。")
            case "structure": caption("Only the shape (lengths, lines, kinds of content) is sent; no words.", "只发送结构（长度、行数、内容类型），不发送任何文字。")
            default: caption("Matches of the rules below are replaced before sending.", "发送前，按下方规则替换匹配到的内容。")
            }
            caption("Applies to every model decision: shortcuts, precompose and smart paste. Local rules never send anything.",
                    "适用于所有模型决策：快捷键、预合成与智能粘贴。本地规则不会发送任何内容。")
        }
    }

    private var builtinSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("Built-in rules", "内置规则")
            if !state.builtinsFromCore {
                caption("Core is not reachable; showing rule ids with their defaults.", "核心服务暂不可用，仅显示规则标识及默认状态。")
            }
            ForEach(state.builtins) { builtin in
                Toggle(isOn: Binding(get: { state.isEnabled(builtin) }, set: { state.setEnabled(builtin, $0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.isChinese ? builtin.nameZh : builtin.name).font(.system(size: 12))
                        let description = model.isChinese ? builtin.descriptionZh : builtin.description
                        if !description.isEmpty { Text(description).font(.system(size: 10)).foregroundColor(.secondary) }
                    }
                }.toggleStyle(.checkbox)
            }
        }
    }

    private var customSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                heading("Custom rules", "自定义规则")
                Spacer()
                Button(model.tr("Add rule…", "添加规则…")) { editing = PrivacyRule() }
                    .controlSize(.small).disabled(state.rules.count >= PrivacyRule.maxRules)
            }
            if state.rules.isEmpty {
                caption("Replace your own words, names or patterns before they reach the model.", "在内容发给模型前替换你自己的词、名称或格式。")
            }
            ForEach(state.rules) { rule in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Toggle("", isOn: Binding(get: { rule.enabled }, set: { var next = rule; next.enabled = $0; state.upsert(next) }))
                            .labelsHidden().toggleStyle(.checkbox)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(rule.name.isEmpty ? rule.pattern : rule.name).font(.system(size: 12)).lineLimit(1)
                            Text(summary(rule)).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button { editing = rule } label: { Image(systemName: "pencil") }.buttonStyle(.borderless)
                            .help(model.tr("Edit", "编辑"))
                        Button { state.delete(rule) } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                            .help(model.tr("Delete", "删除"))
                    }
                    if let message = state.ruleErrors[rule.id] {
                        Text(message).font(.system(size: 10)).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
    private func summary(_ rule: PrivacyRule) -> String {
        let kind = rule.match == "regex" ? model.tr("Regex", "正则") : rule.match == "keywords" ? model.tr("Keywords", "关键词") : model.tr("Text", "文字")
        var parts = [kind, "→ " + (rule.replacement.isEmpty ? model.tr("(removed)", "（删除）") : rule.replacement)]
        if rule.alsoInOutput { parts.append(model.tr("also in images", "图片中也替换")) }
        return parts.joined(separator: " · ")
    }

    private var testSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("Test", "测试")
            caption("Uses the saved rules. Save first to test changes.", "使用已保存的规则；修改后请先保存再测试。")
            TextEditor(text: $state.previewText).font(.system(size: 11)).frame(height: 60)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.25)))
            HStack {
                Button(model.tr("Test", "测试")) { state.runPreview(model) }
                    .controlSize(.small).disabled(state.previewText.isEmpty || state.previewing || model.core == nil)
                if state.previewing { ProgressView().controlSize(.small) }
                if let error = state.previewError { Text(error).font(.system(size: 11)).foregroundColor(.orange) }
            }
            if let preview = state.preview {
                result(model.tr("The model receives", "模型收到"), preview.modelText)
                result(model.tr("Shown in images", "图片中显示"), preview.outputText)
                if preview.containsSecret {
                    caption("Contains a secret.", "包含密钥。", warning: true)
                }
            }
        }
    }
    private func result(_ label: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 11, weight: .medium))
            Text(text.isEmpty ? " " : text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(6)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.08)))
        }
    }
}

private struct RuleEditor: View {
    @ObservedObject var model: AppState
    @ObservedObject var state: PrivacySettingsModel
    @State var draft: PrivacyRule
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(state.rules.contains { $0.id == draft.id } ? model.tr("Edit rule", "编辑规则") : model.tr("New rule", "新建规则"))
                .font(.system(size: 15, weight: .semibold))
            TextField(model.tr("Name", "名称"), text: $draft.name).textFieldStyle(.roundedBorder)
            Picker(model.tr("Match", "匹配方式"), selection: $draft.match) {
                Text(model.tr("Text", "文字")).tag("text")
                Text(model.tr("Keywords (one per line)", "关键词（每行一个）")).tag("keywords")
                Text(model.tr("Regex", "正则")).tag("regex")
            }
            Text(model.tr(draft.match == "keywords" ? "Keywords, one per line" : draft.match == "regex" ? "Regular expression" : "Text to match",
                          draft.match == "keywords" ? "关键词，每行一个" : draft.match == "regex" ? "正则表达式" : "要匹配的文字"))
                .font(.system(size: 11, weight: .medium))
            TextEditor(text: $draft.pattern).font(.system(size: 11, design: .monospaced))
                .frame(height: draft.match == "keywords" ? 80 : 44)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.25)))
            TextField(model.tr("Replace with", "替换为"), text: $draft.replacement).textFieldStyle(.roundedBorder)
            HStack(spacing: 16) {
                Toggle(model.tr("Case sensitive", "区分大小写"), isOn: $draft.caseSensitive)
                Toggle(model.tr("Whole word", "整词匹配"), isOn: $draft.wholeWord)
            }.toggleStyle(.checkbox)
            Toggle(model.tr("Also replace in images", "图片中也替换"), isOn: $draft.alsoInOutput).toggleStyle(.checkbox)
            Text(model.tr("Off: only what the model sees changes. On: the rendered image, GIF and video show the replacement too.",
                          "关闭时只改变模型看到的内容；开启后生成的图片、GIF 与视频中也显示替换后的文字。"))
                .font(.system(size: 10)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            if let problem = draft.problem, !draft.pattern.isEmpty {
                Text(state.problemText(problem, model)).font(.system(size: 11)).foregroundColor(.orange)
            }
            HStack {
                Spacer()
                Button(model.tr("Cancel", "取消"), action: close).keyboardShortcut(.cancelAction)
                Button(model.tr("Done", "完成")) {
                    var rule = draft
                    rule.name = rule.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    state.upsert(rule); close()
                }.keyboardShortcut(.defaultAction).disabled(draft.problem != nil)
            }
            Text(model.tr("Changes apply after saving.", "保存后生效。")).font(.system(size: 10)).foregroundColor(.secondary)
        }.padding(20).frame(width: 420)
    }
}
