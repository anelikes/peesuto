import SwiftUI
import AppKit
import ServiceManagement
import PeesutoKit

/// First-run welcome and setup (settings.json `onboarding_version`). Five
/// steps; Return continues, ← / → move between steps.
struct OnboardingView: View {
    @ObservedObject var model: AppState
    let openAISettings: () -> Void
    let finish: () -> Void
    @State private var step: Int
    @State private var forward = true

    static let steps: [(en: String, zh: String)] = [
        ("Welcome", "欢迎"), ("Shortcuts", "快捷键"), ("Permissions", "权限与隐私"), ("Preferences", "偏好"), ("Try it", "试一试")
    ]

    init(model: AppState, initialStep: Int = 0, openAISettings: @escaping () -> Void, finish: @escaping () -> Void) {
        self.model = model
        self.openAISettings = openAISettings
        self.finish = finish
        _step = State(initialValue: min(max(initialStep, 0), Self.steps.count - 1))
    }

    var body: some View {
        ZStack {
            OnboardingStyle.background
            VStack(spacing: 0) {
                progress.padding(.top, 42).padding(.horizontal, 64)
                ZStack {
                    page(step)
                        .id(step)
                        .transition(.asymmetric(
                            insertion: .offset(x: forward ? 36 : -36).combined(with: .opacity),
                            removal: .offset(x: forward ? -36 : 36).combined(with: .opacity)))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 56)
                footer.padding(.horizontal, 32).padding(.bottom, 24)
            }
        }
        .frame(width: 760, height: 540)
        .ignoresSafeArea()
        .tint(OnboardingStyle.accent)
    }

    @ViewBuilder private func page(_ index: Int) -> some View {
        switch index {
        case 0: WelcomeStep(model: model)
        case 1: ShortcutsStep(model: model)
        case 2: PermissionsStep(model: model)
        case 3: PreferencesStep(model: model, openAISettings: openAISettings)
        default: TryItStep(model: model)
        }
    }

    private var progress: some View {
        HStack(spacing: 10) {
            ForEach(Self.steps.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 7) {
                    Capsule()
                        .fill(index <= step ? OnboardingStyle.accent : Color.primary.opacity(0.1))
                        .frame(height: 3)
                    Text(model.tr(Self.steps[index].en, Self.steps[index].zh))
                        .font(.system(size: 11, weight: index == step ? .semibold : .regular))
                        .foregroundColor(index == step ? .primary : .secondary)
                }
                .contentShape(Rectangle())
                .onTapGesture { go(to: index) }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(index == step ? .isSelected : [])
            }
        }
    }

    private var footer: some View {
        HStack {
            if step > 0 {
                Button { go(to: step - 1) } label: {
                    Label(model.tr("Back", "上一步"), systemImage: "chevron.left").font(.system(size: 13))
                }
                .buttonStyle(.plain).foregroundColor(.secondary)
                .keyboardShortcut(.leftArrow, modifiers: [])
            } else {
                Button(model.tr("Skip setup", "跳过"), action: finish)
                    .buttonStyle(.plain).foregroundColor(.secondary).font(.system(size: 13))
            }
            Spacer()
            // → mirrors Continue without finishing on the last step.
            Button("") { if step < Self.steps.count - 1 { go(to: step + 1) } }
                .keyboardShortcut(.rightArrow, modifiers: [])
                .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
            Button(action: advance) {
                HStack(spacing: 6) {
                    Text(step == 0 ? model.tr("Get started", "开始设置")
                         : step == Self.steps.count - 1 ? model.tr("Finish", "完成") : model.tr("Continue", "继续"))
                    if step < Self.steps.count - 1 { Image(systemName: "arrow.right").font(.system(size: 11, weight: .semibold)) }
                }
            }
            .buttonStyle(PrimaryCapsuleStyle())
            .keyboardShortcut(.defaultAction)
        }
    }

    private func advance() {
        if step >= Self.steps.count - 1 { finish() } else { go(to: step + 1) }
    }
    private func go(to target: Int) {
        guard target != step, Self.steps.indices.contains(target) else { return }
        forward = target > step
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { step = target }
    }
}

// MARK: - Look

enum OnboardingStyle {
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.40, green: 0.79, blue: 0.69, alpha: 1)
            : NSColor(srgbRed: 0.09, green: 0.46, blue: 0.39, alpha: 1)
    })
    /// Text on a filled accent: white on the deep light-mode teal, ink on the pale dark-mode one.
    static let onAccent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.04, green: 0.13, blue: 0.11, alpha: 1) : .white
    })
    static var background: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            RadialGradient(colors: [accent.opacity(0.10), .clear], center: .topLeading, startRadius: 20, endRadius: 520)
            RadialGradient(colors: [accent.opacity(0.05), .clear], center: .bottomTrailing, startRadius: 10, endRadius: 420)
        }.ignoresSafeArea()
    }
    static func sample(_ name: String) -> NSImage? {
        Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Onboarding").flatMap(NSImage.init(contentsOf:))
    }
}

struct PrimaryCapsuleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(OnboardingStyle.onAccent)
            .padding(.horizontal, 20).padding(.vertical, 9)
            .background(Capsule().fill(OnboardingStyle.accent.opacity(configuration.isPressed ? 0.8 : 1)))
            .shadow(color: OnboardingStyle.accent.opacity(0.28), radius: 8, y: 3)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct SecondaryCapsuleStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(OnboardingStyle.accent)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Capsule().fill(OnboardingStyle.accent.opacity(configuration.isPressed ? 0.2 : 0.12)))
    }
}

struct Keycap: View {
    let label: String
    var body: some View {
        Text(label)
            .font(.system(size: 13, weight: .medium, design: .rounded))
            .frame(minWidth: 26, minHeight: 26)
            .padding(.horizontal, label.count > 1 ? 7 : 0)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
                    .shadow(color: .black.opacity(0.22), radius: 0, x: 0, y: 1.5))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
    }
}

struct KeycapRow: View {
    let accelerator: String
    let disabledTitle: String
    var body: some View {
        let glyphs = MediaShortcuts.glyphs(accelerator)
        if glyphs.isEmpty {
            Text(disabledTitle).font(.system(size: 12)).foregroundColor(.secondary)
        } else {
            HStack(spacing: 4) { ForEach(Array(glyphs.enumerated()), id: \.offset) { Keycap(label: $0.element) } }
                .accessibilityElement(children: .ignore).accessibilityLabel(glyphs.joined())
        }
    }
}

private struct Card<Content: View>: View {
    var padding: CGFloat = 18
    @ViewBuilder let content: Content
    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .controlBackgroundColor).opacity(0.75)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.07), lineWidth: 1))
    }
}

private struct SymbolTile: View {
    let symbol: String
    var size: CGFloat = 30
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.46, weight: .medium))
            .foregroundColor(OnboardingStyle.accent)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(OnboardingStyle.accent.opacity(0.12)))
    }
}

private struct StepHeader: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 24, weight: .semibold))
            Text(subtitle).font(.system(size: 13)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 1 Welcome

private struct WelcomeStep: View {
    @ObservedObject var model: AppState
    private let samples: [(file: String, en: String, zh: String, tilt: Double, lift: CGFloat)] = [
        ("sample-text", "Poster", "海报", -4, 6), ("sample-chat", "Chat", "对话", 2, -4),
        ("sample-code", "Code", "代码", -2, 2), ("sample-qr", "QR code", "二维码", 4, -6)
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 8)
            HStack(spacing: 12) {
                if let icon = NSImage(named: NSImage.applicationIconName) {
                    Image(nsImage: icon).resizable().frame(width: 44, height: 44)
                }
                Text("Peesuto").font(.system(size: 34, weight: .bold, design: .rounded))
            }
            Text(model.tr("Copy anything, then paste it as a card, GIF, video or QR code — with a smart clipboard history that remembers the rest.",
                          "复制任何内容，一键粘贴成卡片、GIF、视频或二维码；智能剪贴板历史替你记住其余的一切。"))
                .font(.system(size: 15)).foregroundColor(.secondary)
                .multilineTextAlignment(.center).frame(maxWidth: 590).padding(.top, 12)
            HStack(spacing: 20) {
                ForEach(samples, id: \.file) { sample in
                    VStack(spacing: 10) {
                        Group {
                            if let image = OnboardingStyle.sample(sample.file) {
                                Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
                            } else {
                                OnboardingStyle.accent.opacity(0.12)
                            }
                        }
                        .frame(width: 128, height: 128)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 1))
                        .shadow(color: .black.opacity(0.16), radius: 12, y: 6)
                        .rotationEffect(.degrees(sample.tilt))
                        .offset(y: sample.lift)
                        Text(model.tr(sample.en, sample.zh)).font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
                            .offset(y: sample.lift)
                    }
                }
            }.padding(.top, 34)
            Text(model.tr("These samples were made by Peesuto’s own renderer, on this Mac.", "以上样张由 Peesuto 的渲染器在本机生成。"))
                .font(.system(size: 11)).foregroundColor(.secondary.opacity(0.8)).padding(.top, 22)
            Spacer(minLength: 8)
        }
    }
}

// MARK: - 2 Shortcuts

private struct ShortcutsStep: View {
    @ObservedObject var model: AppState
    var body: some View {
        let shortcuts = model.shortcuts
        VStack(alignment: .leading, spacing: 14) {
            StepHeader(title: model.tr("Paste as anything", "一键粘贴成任何形式"),
                       subtitle: model.tr("Copy some text, click into any text field, then press a shortcut. Peesuto renders it and pastes the result right there.",
                                          "先复制文字，点进任意输入框，再按快捷键。Peesuto 会生成结果并直接粘贴到那里。"))
            Card(padding: 6) {
                VStack(spacing: 0) {
                    row("photo", "Image", "图片", "A card that fits your content", "贴合内容的卡片", shortcuts["paste-card"])
                    Divider().padding(.leading, 56)
                    row("sparkles.rectangle.stack", "GIF", "GIF", "Animated, plays anywhere", "动图，到处都能播放", shortcuts["paste-gif"])
                    Divider().padding(.leading, 56)
                    row("play.rectangle", "Video", "视频", "MP4 with motion (needs ffmpeg)", "带动效的 MP4（需要 ffmpeg）", shortcuts["paste-video"])
                    Divider().padding(.leading, 56)
                    row("qrcode", "QR code", "二维码", "Links and text, scannable", "链接和文字，扫码即得", shortcuts["paste-qr"])
                    Divider().padding(.leading, 56)
                    row("pin", "Pin to screen", "贴到屏幕", "Floats on top: drag, scroll to zoom, double-click to close", "浮在最上层：拖动、滚动缩放、双击关闭", shortcuts["pin-screen"])
                }
            }
            Card(padding: 6) {
                row("clock.arrow.circlepath", "Clipboard history", "剪贴板历史", "Search, pin and reuse what you copied", "搜索、置顶、再次使用复制过的内容", shortcuts["panel"])
            }
            Text(model.tr("Change them any time in Settings › Shortcuts.", "可随时在「设置 › 快捷键」中修改。"))
                .font(.system(size: 11)).foregroundColor(.secondary)
            Spacer(minLength: 0)
        }.padding(.top, 20)
    }
    private func row(_ symbol: String, _ en: String, _ zh: String, _ detailEn: String, _ detailZh: String, _ accelerator: String?) -> some View {
        HStack(spacing: 14) {
            SymbolTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.tr(en, zh)).font(.system(size: 13, weight: .medium))
                Text(model.tr(detailEn, detailZh)).font(.system(size: 11)).foregroundColor(.secondary)
            }
            Spacer()
            KeycapRow(accelerator: accelerator ?? "", disabledTitle: model.tr("Off", "未启用"))
        }.padding(.horizontal, 12).padding(.vertical, 6)
    }
}

// MARK: - 3 Permissions & privacy

private struct PermissionsStep: View {
    @ObservedObject var model: AppState
    private let poll = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            StepHeader(title: model.tr("Permissions & privacy", "权限与隐私"),
                       subtitle: model.tr("One permission, and what stays on your Mac.", "只需一项权限，以及哪些内容留在你的 Mac 上。"))
            Card {
                HStack(alignment: .top, spacing: 14) {
                    SymbolTile(symbol: "accessibility", size: 36)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(model.tr("Accessibility", "辅助功能")).font(.system(size: 14, weight: .semibold))
                            Spacer()
                            status
                        }
                        Text(model.tr("Lets Peesuto press ⌘V for you and read the focused field’s context for smart paste.",
                                      "让 Peesuto 替你按下 ⌘V，并读取当前输入框的上下文用于智能粘贴。"))
                            .font(.system(size: 12)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 12) {
                            if model.trusted {
                                Text(model.tr("All set: shortcuts paste straight into the app in front.", "已就绪：快捷键会直接粘贴到最前面的应用。"))
                                    .font(.system(size: 11)).foregroundColor(OnboardingStyle.accent)
                            } else {
                                Button(model.tr("Open Accessibility Settings", "打开辅助功能设置"), action: model.openAccessibilitySettings)
                                    .buttonStyle(SecondaryCapsuleStyle())
                                Text(model.tr("You can continue without it; shortcuts will then copy only.", "也可以先跳过；那样快捷键只会复制结果。"))
                                    .font(.system(size: 11)).foregroundColor(.secondary)
                            }
                        }.padding(.top, 4)
                    }
                }
            }
            HStack(alignment: .top, spacing: 14) {
                Card {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(spacing: 10) {
                            SymbolTile(symbol: "key", size: 28)
                            Text(model.tr("Keychain", "钥匙串")).font(.system(size: 13, weight: .semibold))
                        }
                        Text(model.tr("History is encrypted on this Mac; its key is kept in your login Keychain. If macOS asks whether Peesuto may use confidential information, choose Always Allow. Peesuto reads only its own item.",
                                      "历史记录在本机加密，密钥保存在你的登录钥匙串中。如果 macOS 询问 Peesuto 能否使用机密信息，请选择「始终允许」。Peesuto 只读取它自己的那一项。"))
                            .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Card {
                    VStack(alignment: .leading, spacing: 7) {
                        HStack(spacing: 10) {
                            SymbolTile(symbol: "doc.on.clipboard", size: 28)
                            Text(model.tr("Clipboard", "剪贴板")).font(.system(size: 13, weight: .semibold))
                        }
                        Text(model.tr("Text, images and files you copy are recorded. Password managers, concealed items and excluded apps are skipped. Everything stays on this Mac; change it in Settings › History & privacy.",
                                      "记录你复制的文字、图片和文件；跳过密码管理器、标记为隐藏的内容和排除的应用。全部留在本机，可在「设置 › 历史与隐私」中修改。"))
                            .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 26)
        .onAppear { model.trusted = PasteController.accessibilityTrusted }
        .onReceive(poll) { _ in
            let trusted = PasteController.accessibilityTrusted
            if trusted != model.trusted { withAnimation(.easeOut(duration: 0.25)) { model.trusted = trusted } }
        }
    }

    private var status: some View {
        HStack(spacing: 5) {
            Image(systemName: model.trusted ? "checkmark.circle.fill" : "circle.dashed")
            Text(model.trusted ? model.tr("Granted", "已授权") : model.tr("Not granted", "尚未授权"))
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundColor(model.trusted ? OnboardingStyle.accent : .secondary)
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(Capsule().fill(model.trusted ? OnboardingStyle.accent.opacity(0.12) : Color.primary.opacity(0.06)))
    }
}

// MARK: - 4 Preferences

private struct PreferencesStep: View {
    @ObservedObject var model: AppState
    let openAISettings: () -> Void
    @State private var outputs: Set<String> = []
    @State private var decider = "rules"
    @State private var loginStatus = SMAppService.Status.notRegistered
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StepHeader(title: model.tr("Make it yours", "按你的习惯来"),
                       subtitle: model.tr("Sensible defaults are already on. You can change everything later in Settings.",
                                          "已经选好了合适的默认值，之后都可以在设置中修改。"))
            VStack(alignment: .leading, spacing: 9) {
                sectionTitle("Prepare on copy", "复制后预先生成")
                HStack(spacing: 10) {
                    chip("image", "photo", "Image", "图片")
                    chip("gif", "sparkles.rectangle.stack", "GIF", "GIF")
                    chip("video", "play.rectangle", "Video", "视频")
                }
                Text(model.tr("Copying renders in the background with local rules, so the shortcut pastes instantly. Pauses in Low Power Mode.",
                              "复制时用本地规则在后台提前生成，按快捷键即可立即粘贴。低电量模式下暂停。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            VStack(alignment: .leading, spacing: 9) {
                sectionTitle("Who decides the layout", "由谁来决定排版")
                HStack(spacing: 12) {
                    option(selected: decider == "rules" || decider == "none", symbol: "lock.laptopcomputer",
                           "Local rules", "本地规则", "Default. Offline; nothing leaves your Mac.", "默认。离线运行，不发送任何内容。") { chooseLocalRules() }
                    option(selected: decider != "rules" && decider != "none", symbol: "sparkles",
                           "AI model", "AI 模型", "Cloudflare, Laya or your own endpoint. Opens AI settings.", "Cloudflare、Laya 或自有端点。将打开 AI 设置。") { openAISettings() }
                }
            }
            HStack(spacing: 12) {
                SymbolTile(symbol: "power", size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.tr("Open at login", "登录时打开")).font(.system(size: 13, weight: .medium))
                    Text(model.previewMode ? model.tr("Not available in the preview build.", "预览版不可用。")
                         : loginStatus == .requiresApproval ? model.tr("Allow Peesuto in System Settings › Login Items.", "请在「系统设置 › 登录项」中允许 Peesuto。")
                         : model.tr("Keeps your clipboard history ready after a restart.", "重启后剪贴板历史也会随时可用。"))
                        .font(.system(size: 11)).foregroundColor(.secondary)
                }
                Spacer()
                Toggle("", isOn: Binding(get: { loginStatus == .enabled || loginStatus == .requiresApproval }, set: setOpenAtLogin))
                    .toggleStyle(.switch).labelsHidden().disabled(model.previewMode)
            }
            if let problem { Text(problem).font(.system(size: 11)).foregroundColor(.orange) }
            Spacer(minLength: 0)
        }
        .padding(.top, 26)
        .onAppear(perform: load)
        .onChange(of: model.settingsRevision) { _ in load() }
    }

    private func sectionTitle(_ en: String, _ zh: String) -> some View {
        Text(model.tr(en, zh).uppercased()).font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary).tracking(0.6)
    }

    private func chip(_ kind: String, _ symbol: String, _ en: String, _ zh: String) -> some View {
        let on = outputs.contains(kind)
        return Button { toggle(kind) } label: {
            HStack(spacing: 7) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundColor(on ? OnboardingStyle.accent : .secondary)
                Image(systemName: symbol).foregroundColor(on ? .primary : .secondary)
                Text(model.tr(en, zh)).foregroundColor(on ? .primary : .secondary)
            }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Capsule().fill(on ? OnboardingStyle.accent.opacity(0.12) : Color.primary.opacity(0.04)))
            .overlay(Capsule().stroke(on ? OnboardingStyle.accent.opacity(0.5) : Color.primary.opacity(0.1), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func option(selected: Bool, symbol: String, _ en: String, _ zh: String, _ detailEn: String, _ detailZh: String,
                        action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 11) {
                SymbolTile(symbol: symbol, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.tr(en, zh)).font(.system(size: 13, weight: .semibold)).foregroundColor(.primary)
                    Text(model.tr(detailEn, detailZh)).font(.system(size: 11)).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(selected ? OnboardingStyle.accent : .secondary.opacity(0.5))
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(selected ? OnboardingStyle.accent.opacity(0.08) : Color(nsColor: .controlBackgroundColor).opacity(0.75)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(selected ? OnboardingStyle.accent.opacity(0.55) : Color.primary.opacity(0.08), lineWidth: selected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func load() {
        guard let settings = model.settings else { return }
        outputs = Set(settings.precomposeSettings.outputs)
        decider = (settings.providers["decider"] as? [String: Any])?["kind"] as? String ?? "rules"
        if !model.previewMode { loginStatus = SMAppService.mainApp.status }
    }

    /// Saved at once, into the same `precompose` value as Settings.
    private func toggle(_ kind: String) {
        guard let settings = model.settings else { return }
        var next = outputs
        if next.contains(kind) { next.remove(kind) } else { next.insert(kind) }
        do {
            try settings.setPrecomposeOutputs(Array(next))
            withAnimation(.easeOut(duration: 0.15)) { outputs = next }
            problem = nil
            model.settingsRevision += 1
            Task { _ = try? await model.configureCore() }
        } catch { problem = model.tr("Could not save this preference.", "无法保存这项偏好。") }
    }

    private func chooseLocalRules() {
        guard let settings = model.settings, decider != "rules" else { return }
        do {
            try settings.setProvider(track: "decider", fields: ["kind": "rules"])
            decider = "rules"; problem = nil
            model.settingsRevision += 1
            Task { _ = try? await model.configureCore() }
        } catch { problem = model.tr("Could not save this preference.", "无法保存这项偏好。") }
    }

    private func setOpenAtLogin(_ enabled: Bool) {
        guard !model.previewMode else { return }
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            problem = nil
        } catch {
            problem = model.tr("Could not change the login item. Check System Settings › Login Items.", "无法更改登录项，请检查「系统设置 › 登录项」。")
        }
        loginStatus = SMAppService.mainApp.status
    }
}

// MARK: - 5 Try it

private struct TryItStep: View {
    @ObservedObject var model: AppState
    @State private var copied = false

    private var sample: String {
        model.tr("Make room for a clearer thought.", "把灵感留住，让表达更简单。")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            StepHeader(title: model.tr("Try it now", "现在就试一试"),
                       subtitle: model.tr("Three steps, about five seconds.", "三步，大约五秒钟。"))
            Card(padding: 20) {
                VStack(alignment: .leading, spacing: 18) {
                    stepRow(1) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("“\(sample)”").font(.system(size: 17, weight: .medium, design: .serif))
                            HStack(spacing: 10) {
                                Button(action: copySample) {
                                    Label(copied ? model.tr("Copied", "已复制") : model.tr("Copy sample text", "复制示例文字"),
                                          systemImage: copied ? "checkmark" : "doc.on.doc")
                                }.buttonStyle(SecondaryCapsuleStyle())
                            }
                        }
                    }
                    stepRow(2) {
                        Text(model.tr("Switch to any text field — Notes, WeChat, Slack, a browser.", "切换到任意输入框——备忘录、微信、Slack、浏览器都可以。"))
                            .font(.system(size: 13))
                    }
                    stepRow(3) {
                        HStack(spacing: 10) {
                            Text(model.tr("Press", "按下")).font(.system(size: 13))
                            KeycapRow(accelerator: model.shortcuts["paste-card"] ?? "", disabledTitle: model.tr("(image shortcut is off)", "（图片快捷键未启用）"))
                            Text(model.tr("and the card is pasted.", "卡片就粘贴好了。")).font(.system(size: 13))
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "lightbulb").foregroundColor(OnboardingStyle.accent)
                Text(model.tr("Welcome guide is always in Settings › General › About.", "欢迎引导随时可在「设置 › 通用 › 关于」中重新打开。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }.padding(.top, 26)
    }

    private func stepRow<Content: View>(_ number: Int, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(number)")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundColor(OnboardingStyle.onAccent)
                .frame(width: 22, height: 22)
                .background(Circle().fill(OnboardingStyle.accent))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            content()
        }
    }

    /// A plain clipboard write, not marked as Peesuto's own: the media
    /// shortcut then treats it like text the user copied.
    private func copySample() {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(sample, forType: .string)
        withAnimation(.easeOut(duration: 0.2)) { copied = true }
    }
}
