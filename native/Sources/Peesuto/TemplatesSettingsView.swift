import SwiftUI
import AppKit
import PeesutoKit

/// Settings › Templates: every template with its styles, whether automatic
/// choice may use it, and which style it defaults to. Changes apply at once.
struct TemplatesSettingsView: View {
    @ObservedObject var model: AppState
    @State private var disabled: Set<String> = []
    @State private var styles: [String: String] = [:]
    @State private var font = "maple"
    /// The signature as typed; saved on Return and when the field loses focus
    /// (saving each keystroke would trim a space the user is still typing).
    @State private var signature = ""
    @FocusState private var signatureFocused: Bool
    @State private var problem: String?
    @State private var unavailable = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(model.tr("Peesuto picks a template from what you copied. Turn one off to keep it out of automatic choice; you can still pick it by hand after a card is made. Click a style to make it the default, click it again to let Peesuto decide.",
                          "Peesuto 会根据复制的内容自动选择模板。关闭某个模板后它不会再被自动选中，但生成后仍可手动切换。点击风格设为默认，再次点击则交给 Peesuto 决定。"))
                .font(.system(size: 12)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.tr("Card font", "卡片字体")).font(.system(size: 13, weight: .semibold))
                    Text(model.tr("Code cards always use Maple Mono.", "代码图始终使用 Maple Mono。")).font(.system(size: 11)).foregroundColor(.secondary)
                }
                Spacer()
                Picker("", selection: Binding(get: { font }, set: { value in apply { try $0.setTemplateFont(value) } })) {
                    Text("Maple Mono").tag("maple")
                    Text(model.tr("Noto Sans SC", "思源黑体")).tag("noto")
                }.labelsHidden().pickerStyle(.segmented).fixedSize()
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(NSColor.controlBackgroundColor)))
            signatureRow
            if model.templates.isEmpty && unavailable {
                Text(model.tr("Templates are unavailable until Peesuto's engine starts.", "Peesuto 引擎启动后才能显示模板。"))
                    .font(.system(size: 12)).foregroundColor(.secondary)
            } else if model.templates.isEmpty {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text(model.tr("Loading templates…", "正在载入模板…")) }
                    .font(.system(size: 12)).foregroundColor(.secondary)
            }
            ForEach(model.templates) { spec in row(spec) }
            HStack {
                if let problem { Text(problem).font(.system(size: 11)).foregroundColor(.orange) }
                Spacer()
                Button(model.tr("Restore defaults", "恢复默认"), action: reset)
                    .disabled(disabled.isEmpty && styles.isEmpty && font == "maple" && signature.isEmpty)
            }
        }
        .onAppear(perform: load)
        .onDisappear(perform: saveSignature)
        .task { unavailable = !(await model.loadTemplates()) }
    }

    private var signatureRow: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.tr("Signature", "签名")).font(.system(size: 13, weight: .semibold))
                Text(model.tr("A small line at the foot of every card except QR codes. Leave it empty for none.",
                              "显示在每张卡片底部的一行小字（二维码除外）。留空则不显示。"))
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            TextField("@you · example.com", text: $signature)
                .textFieldStyle(.roundedBorder).frame(width: 220)
                .focused($signatureFocused)
                .onSubmit(saveSignature)
                .onChange(of: signature) { value in
                    if value.count > SettingsStore.templateSignatureMaxLength { signature = String(value.prefix(SettingsStore.templateSignatureMaxLength)) }
                }
                .onChange(of: signatureFocused) { focused in if !focused { saveSignature() } }
                .help(model.tr("Up to 40 characters", "最多 40 个字符"))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(NSColor.controlBackgroundColor)))
    }

    private func saveSignature() {
        guard let settings = model.settings,
              SettingsStore.normalizedTemplateSignature(signature) != settings.templateSignature else { return }
        apply { try $0.setTemplateSignature(signature) }
    }

    private func row(_ spec: CoreTemplateSpec) -> some View {
        let on = !disabled.contains(spec.id)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.templateName(spec)).font(.system(size: 13, weight: .semibold))
                    Text(summary(spec.id)).font(.system(size: 11)).foregroundColor(.secondary)
                }
                Spacer()
                switch spec.id {
                case "qr":
                    Text(model.tr("Only when chosen", "仅手动选择")).font(.system(size: 11)).foregroundColor(.secondary)
                case "document":
                    Text(model.tr("Always on (fallback)", "始终开启（兜底）")).font(.system(size: 11)).foregroundColor(.secondary)
                default:
                    Toggle(model.tr("Use automatically", "自动使用"), isOn: Binding(get: { on }, set: { setEnabled(spec.id, $0) }))
                        .toggleStyle(.switch).controlSize(.small).labelsHidden()
                        .help(model.tr("Use automatically", "自动使用"))
                }
            }
            HStack(spacing: 10) {
                ForEach(spec.variants, id: \.id) { variant in
                    styleTile(spec, variant)
                }
            }
            .opacity(on ? 1 : 0.45)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(NSColor.controlBackgroundColor)))
    }

    private func styleTile(_ spec: CoreTemplateSpec, _ variant: CoreTemplateVariant) -> some View {
        let selected = styles[spec.id] == variant.id
        return Button { setStyle(spec.id, selected ? nil : variant.id) } label: {
            VStack(spacing: 5) {
                Group {
                    if let image = Self.preview(spec.id, variant.id) {
                        Image(nsImage: image).resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Color.primary.opacity(0.06)
                    }
                }
                .frame(width: 92, height: 92).clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(selected ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: selected ? 2.5 : 1))
                .overlay(alignment: .topTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.white, Color.accentColor).font(.system(size: 15)).padding(4)
                    }
                }
                Text(model.variantName(variant)).font(.system(size: 11)).foregroundColor(selected ? .primary : .secondary).lineLimit(1)
            }
            .frame(width: 92)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(selected ? model.tr("Default style. Click to let Peesuto decide.", "默认风格，再次点击交给 Peesuto 决定。")
                       : model.tr("Make this the default style", "设为默认风格"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func summary(_ id: String) -> String {
        switch id {
        case "text": return model.tr("Short prose, set as typography", "短句与段落，排成海报式文字")
        case "document": return model.tr("Longer text and anything else", "长文本及其他内容")
        case "quote": return model.tr("A quotation with its source", "带出处的引文")
        case "code": return model.tr("Code with highlighting and line numbers", "代码，带高亮与行号")
        case "stat": return model.tr("One number with its label", "一个数字及其说明")
        case "list": return model.tr("Bullet and numbered lists", "项目符号与编号列表")
        case "chat": return model.tr("A conversation between named people", "有发言人的对话")
        case "table": return model.tr("Markdown and box-drawing tables", "Markdown 与线框表格")
        case "comparison": return model.tr("Before / after, pros / cons", "之前 / 之后、优点 / 缺点")
        case "diagram": return model.tr("Mermaid flowcharts and arrow chains", "Mermaid 流程图与箭头链")
        case "info": return model.tr("Contacts, accounts and keys, field by field", "联系方式、账号与密钥，逐项排版")
        case "changelog": return model.tr("Release notes: versions, dates and tagged changes", "更新日志：版本、日期与分类标签")
        case "terminal": return model.tr("Shell sessions: commands, output and errors", "终端会话：命令、输出与报错")
        case "diff": return model.tr("Diffs and patches: added and removed lines", "代码差异与补丁：新增与删除的行")
        case "error": return model.tr("Errors and stack traces, your own frames first", "报错与调用栈，突出你自己的代码")
        case "timeline": return model.tr("Schedules and milestones on a timeline", "日程与里程碑，排成时间轴")
        case "stats": return model.tr("Several numbers with labels, as a grid", "多个带说明的数字，排成网格")
        case "lyrics": return model.tr("Song lyrics and poems as kinetic type", "歌词与诗，做成动态文字")
        case "qr": return model.tr("Any text as a QR code", "任意文字转为二维码")
        default: return ""
        }
    }

    private static var previews: [String: NSImage] = [:]
    private static func preview(_ template: String, _ variant: String) -> NSImage? {
        let name = "\(template)-\(variant)"
        if let cached = previews[name] { return cached }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "TemplatePreviews"),
              let image = NSImage(contentsOf: url) else { return nil }
        previews[name] = image
        return image
    }

    private func load() {
        guard let settings = model.settings else { return }
        disabled = Set(settings.disabledTemplates)
        styles = settings.templatePreferences ?? [:]
        font = settings.templateFont
        signature = settings.templateSignature
    }

    private func setEnabled(_ id: String, _ enabled: Bool) {
        apply { try $0.setTemplateEnabled(id, enabled) }
    }
    private func setStyle(_ id: String, _ variant: String?) {
        apply { try $0.setTemplateStyle(id, variant: variant) }
    }
    private func reset() {
        apply { try $0.resetTemplates() }
    }
    /// Save and re-read. Requests read the settings each time, and the
    /// precompose key includes them, so nothing else needs restarting.
    private func apply(_ change: (SettingsStore) throws -> Void) {
        guard let settings = model.settings else { return }
        do {
            try change(settings)
            problem = nil
            withAnimation(.easeOut(duration: 0.12)) { load() }
        } catch { problem = model.tr("Could not save this change.", "无法保存这项更改。") }
    }
}
