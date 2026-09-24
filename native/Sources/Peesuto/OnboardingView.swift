import SwiftUI
import AppKit
import PeesutoKit

/// First-run welcome (settings.json `onboarding_version`). Three steps:
/// what it is, the Accessibility permission, the two shortcuts to remember.
/// Return continues, ← / → move between steps. Preferences are left at
/// their defaults; everything is in Settings.
struct OnboardingView: View {
    @ObservedObject var model: AppState
    let openSettings: () -> Void
    let finish: () -> Void
    @State private var step: Int

    static let stepCount = 3
    static let size = CGSize(width: 680, height: 500)

    init(model: AppState, initialStep: Int = 0, openSettings: @escaping () -> Void, finish: @escaping () -> Void) {
        self.model = model
        self.openSettings = openSettings
        self.finish = finish
        _step = State(initialValue: min(max(initialStep, 0), Self.stepCount - 1))
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                page(step).id(step).transition(.opacity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.top, 28)
            .padding(.bottom, 20)
            .padding(.horizontal, 48)
            footer.padding(.horizontal, 24).padding(.bottom, 22)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .ignoresSafeArea()
    }

    @ViewBuilder private func page(_ index: Int) -> some View {
        switch index {
        case 0: WelcomeStep(model: model)
        case 1: PermissionStep(model: model)
        default: ReadyStep(model: model, openSettings: openSettings)
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            PageDots(count: Self.stepCount, current: step, go: go(to:))
                .padding(.leading, 6)
            Spacer()
            // → mirrors Continue without finishing on the last step.
            Button("") { if step < Self.stepCount - 1 { go(to: step + 1) } }
                .keyboardShortcut(.rightArrow, modifiers: [])
                .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
            if step > 0 {
                Button(model.tr("Back", "上一步")) { go(to: step - 1) }
                    .keyboardShortcut(.leftArrow, modifiers: [])
            }
            Button(step == Self.stepCount - 1 ? model.tr("Done", "完成") : model.tr("Continue", "继续"), action: advance)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
    }

    private func advance() {
        if step >= Self.stepCount - 1 { finish() } else { go(to: step + 1) }
    }
    private func go(to target: Int) {
        guard target != step, (0..<Self.stepCount).contains(target) else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { step = target }
        else { withAnimation(.easeInOut(duration: 0.2)) { step = target } }
    }
}

// MARK: - Pieces

enum OnboardingStyle {
    static func sample(_ name: String) -> NSImage? {
        Bundle.main.url(forResource: name, withExtension: "png", subdirectory: "Onboarding").flatMap(NSImage.init(contentsOf:))
    }
}

private struct PageDots: View {
    let count: Int
    let current: Int
    let go: (Int) -> Void
    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { index in
                Circle()
                    .fill(Color.primary.opacity(index == current ? 0.7 : 0.18))
                    .frame(width: 6, height: 6)
                    .padding(3)
                    .contentShape(Rectangle())
                    .onTapGesture { go(index) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(current + 1) / \(count)")
    }
}

/// One step's heading: a large title and a single line under it.
private struct StepTitle: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(spacing: 10) {
            Text(title).font(.system(size: 26, weight: .semibold))
            Text(subtitle)
                .font(.system(size: 14)).foregroundColor(.secondary)
                .multilineTextAlignment(.center).lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 560)
        }
    }
}

/// Keys as macOS menus and Settings draw them: glyphs on quiet caps.
struct KeycapRow: View {
    let accelerator: String
    let disabledTitle: String
    var body: some View {
        let glyphs = MediaShortcuts.glyphs(accelerator)
        if glyphs.isEmpty {
            Text(disabledTitle).font(.system(size: 12)).foregroundColor(.secondary)
        } else {
            HStack(spacing: 3) {
                ForEach(Array(glyphs.enumerated()), id: \.offset) { item in
                    Text(item.element)
                        .font(.system(size: 12, weight: .medium))
                        .frame(minWidth: 22, minHeight: 22)
                        .padding(.horizontal, item.element.count > 1 ? 6 : 0)
                        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.primary.opacity(0.06)))
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
                }
            }
            .accessibilityElement(children: .ignore).accessibilityLabel(glyphs.joined())
        }
    }
}

/// A plain grouped box, like a Settings form section.
private struct InsetGroup<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .frame(width: 420)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.045)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
    }
}

// MARK: - 1 What it is

private struct WelcomeStep: View {
    @ObservedObject var model: AppState
    var body: some View {
        VStack(spacing: 36) {
            StepTitle(title: model.tr("Copy text, paste a card", "复制文字，粘贴成卡片"),
                      subtitle: model.tr("Peesuto keeps your clipboard history.\nOne shortcut turns what you copied into an image, GIF or video.",
                                         "Peesuto 会记住你复制过的内容。\n按一个快捷键，就能把复制的文字变成图片、GIF 或视频。"))
            PasteDemo(accelerator: model.shortcuts["paste-card"] ?? "", offTitle: model.tr("Off", "未启用"))
        }
    }
}

/// A line of copied text, the image shortcut, then the card that replaces
/// it. Loops quietly; with Reduce Motion it shows only the end state.
private struct PasteDemo: View {
    let accelerator: String
    let offTitle: String
    /// The text on the bundled sample card.
    private let line = "Make room for a clearer thought."
    @State private var phase = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 2 : 0

    var body: some View {
        VStack(spacing: 20) {
            ZStack {
                Text(line)
                    .font(.system(size: 15))
                    .padding(.horizontal, 3).padding(.vertical, 1)
                    .background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: .selectedTextBackgroundColor)))
                    .opacity(phase < 2 ? 1 : 0)
                // The sample ends in a thin dark strip; crop it off.
                Group {
                    if let image = OnboardingStyle.sample("sample-text") {
                        Image(nsImage: image).resizable().interpolation(.high).frame(width: 180, height: 180)
                    } else {
                        Color.primary.opacity(0.06)
                    }
                }
                .frame(width: 180, height: 174, alignment: .top)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.primary.opacity(0.1), lineWidth: 0.5))
                .opacity(phase == 2 ? 1 : 0)
            }
            .frame(width: 320, height: 174)
            KeycapRow(accelerator: accelerator, disabledTitle: offTitle)
                .opacity(phase >= 1 ? 1 : 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("“\(line)” → \(MediaShortcuts.glyphs(accelerator).joined())")
        .task { await loop() }
    }

    private func loop() async {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { phase = 2; return }
        let fade = Animation.easeInOut(duration: 0.4)
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            withAnimation(fade) { phase = 1 }
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(fade) { phase = 2 }
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            withAnimation(fade) { phase = 0 }
        }
    }
}

// MARK: - 2 Permission

private struct PermissionStep: View {
    @ObservedObject var model: AppState
    private let poll = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 36) {
            StepTitle(title: model.tr("Let Peesuto paste for you", "允许 Peesuto 替你粘贴"),
                      subtitle: model.tr("Accessibility access lets Peesuto press ⌘V in the app you’re using.\nWithout it, shortcuts only copy the result.",
                                         "有了辅助功能权限，Peesuto 才能在当前应用里替你按下 ⌘V。\n不开启的话，快捷键只会复制结果。"))
            VStack(spacing: 14) {
                InsetGroup {
                    HStack(spacing: 10) {
                        if let icon = NSImage(named: NSImage.applicationIconName) {
                            Image(nsImage: icon).resizable().frame(width: 28, height: 28)
                        }
                        Text(model.tr("Accessibility", "辅助功能")).font(.system(size: 13))
                        Spacer()
                        if model.trusted {
                            HStack(spacing: 5) {
                                Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                                Text(model.tr("Allowed", "已允许")).foregroundColor(.secondary)
                            }
                            .font(.system(size: 13))
                            .transition(.opacity)
                        } else {
                            Button(model.tr("Open System Settings", "打开系统设置"), action: model.openAccessibilitySettings)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
                Text(model.tr("Your history is encrypted and stays on this Mac.\nmacOS may ask once about Peesuto’s Keychain item; choose Always Allow.",
                              "剪贴板历史加密保存在本机。\nmacOS 可能会就 Peesuto 的钥匙串项询问一次，请选择「始终允许」。"))
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 560)
            }
        }
        .onAppear { model.trusted = PasteController.accessibilityTrusted }
        .onReceive(poll) { _ in
            let trusted = PasteController.accessibilityTrusted
            if trusted != model.trusted { withAnimation(.easeOut(duration: 0.25)) { model.trusted = trusted } }
        }
    }
}

// MARK: - 3 Ready

private struct ReadyStep: View {
    @ObservedObject var model: AppState
    let openSettings: () -> Void

    var body: some View {
        let shortcuts = model.shortcuts
        VStack(spacing: 36) {
            StepTitle(title: model.tr("You’re all set", "准备好了"),
                      subtitle: model.tr("Copy some text, click where it should go, and press the shortcut.",
                                         "复制一段文字，点到要粘贴的位置，再按快捷键。"))
            VStack(spacing: 14) {
                InsetGroup {
                    row(model.tr("Paste as image", "粘贴为图片"), shortcuts["paste-card"])
                    Divider().padding(.horizontal, 12)
                    row(model.tr("Open clipboard history", "打开剪贴板历史"), shortcuts["panel"])
                }
                Button(model.tr("All shortcuts and preferences are in Settings", "全部快捷键与偏好都在「设置」里"), action: openSettings)
                    .buttonStyle(.link).font(.system(size: 12))
            }
        }
    }

    private func row(_ title: String, _ accelerator: String?) -> some View {
        HStack {
            Text(title).font(.system(size: 13))
            Spacer()
            KeycapRow(accelerator: accelerator ?? "", disabledTitle: model.tr("Off", "未启用"))
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}
