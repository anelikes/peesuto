import SwiftUI
import AppKit
import PeesutoKit
import AVKit

struct PanelView: View {
    @ObservedObject var model: AppState
    var openSettings: () -> Void
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundColor(.secondary)
                TextField(model.tr("Search your clipboard", "搜索剪贴板"), text: $model.query)
                    .textFieldStyle(.plain).font(.system(size: 17)).focused($searchFocused)
                    .onSubmit { model.pasteSelection() }
                    .accessibilityIdentifier("history-search")
                if !model.query.isEmpty {
                    Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundColor(.secondary)
                }
                Button { model.panelPinned.toggle() } label: {
                    Image(systemName: model.panelPinned ? "pin.fill" : "pin").font(.system(size: 15))
                        .rotationEffect(.degrees(model.panelPinned ? 0 : 45))
                }
                    .buttonStyle(.plain).foregroundColor(model.panelPinned ? .accentColor : .secondary)
                    .help(model.panelPinned ? model.tr("Pinned: stays open when you click elsewhere", "已钉住：点击别处也不会关闭")
                                            : model.tr("Keep the panel open when you click elsewhere", "钉住面板，点击别处时不关闭"))
                    .accessibilityLabel(model.tr("Keep panel open", "钉住面板"))
                    .accessibilityAddTraits(model.panelPinned ? .isSelected : [])
                Button(action: openSettings) { Image(systemName: "gearshape").font(.system(size: 16)) }
                    .buttonStyle(.plain).foregroundColor(.secondary)
                    .help(model.tr("Settings", "设置")).accessibilityLabel(model.tr("Settings", "设置"))
            }.padding(.horizontal, 22).frame(height: 56)
                // The header doubles as the handle for moving the window.
                .contentShape(Rectangle())
            Hairline()
            HStack(spacing: 0) {
                history.frame(width: 282)
                Hairline(vertical: true)
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Hairline()
            footer
        }
        // The backdrop is the window's glass (PanelBackground); nothing opaque on top of it.
        .ignoresSafeArea()
        .frame(minWidth: 760, minHeight: 500)
        .onAppear { searchFocused = true }
        .onExitCommand {
            if model.busy { model.cancelAction() }
            else if model.output != nil { model.output = nil }
            else if !model.query.isEmpty { model.query = "" }
            else { model.hidePanel?() }
        }
        .background(Group {
            Button("") { moveSelection(1) }.keyboardShortcut(.downArrow, modifiers: []).hidden()
            Button("") { moveSelection(-1) }.keyboardShortcut(.upArrow, modifiers: []).hidden()
            Button("") { model.copySelection() }.keyboardShortcut("c", modifiers: [.command, .shift]).hidden()
        })
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(model.tr("RECENT", "最近复制")).font(.system(size: 10, weight: .semibold)).tracking(1.2)
                Spacer()
                Text("\(model.items.count)").font(.system(size: 11, design: .monospaced))
            }.foregroundColor(.secondary).padding(.horizontal, 20).padding(.top, 20).padding(.bottom, 12)
            if model.items.isEmpty {
                VStack(spacing: 9) {
                    Image(systemName: "doc.on.clipboard").font(.system(size: 25)).foregroundColor(.secondary)
                    Text(model.tr(model.query.isEmpty ? "Copy something to begin" : "No matches", model.query.isEmpty ? "复制内容，从这里开始" : "没有匹配的内容"))
                        .font(.system(size: 12)).foregroundColor(.secondary)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(model.items) { item in
                                historyRow(item).id(item.id)
                            }
                        }.padding(.horizontal, 10).padding(.bottom, 10)
                    }.onChange(of: model.selectedID) { id in if let id { proxy.scrollTo(id) } }
                }
            }
        }.background(Color.primary.opacity(0.025))
    }

    private func historyRow(_ item: ClipRecord) -> some View {
        Button {
            model.selectedID = item.id
            model.output = nil
            model.error = nil
            model.notice = nil
        } label: {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: item.kind == "image" ? "photo" : "text.alignleft")
                    .font(.system(size: 13)).foregroundColor(model.selectedID == item.id ? .accentColor : .secondary)
                    .frame(width: 26, height: 30)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(model.selectedID == item.id ? 0.1 : 0.06)))
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.preview).font(.system(size: 13, weight: .medium)).lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 5) {
                        Text(sourceName(item.sourceApp)).lineLimit(1)
                        Text("·")
                        Text(Date(timeIntervalSince1970: Double(item.createdAt) / 1000), style: .time)
                    }.font(.system(size: 10)).foregroundColor(.secondary)
                }
                Spacer(minLength: 0)
                if item.pinned { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundColor(.secondary) }
            }
            .padding(11).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(model.selectedID == item.id ? Color.accentColor.opacity(0.16) : .clear))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(model.busy)
        .accessibilityLabel(item.preview)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                if model.output != nil {
                    Button { model.output = nil } label: { Label(model.tr("Back", "返回"), systemImage: "chevron.left") }.buttonStyle(.plain).disabled(model.busy)
                } else {
                    Text(model.tr("PREVIEW", "内容预览")).font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundColor(.secondary)
                }
                if model.output?.precomposed == true { PrecomposedTag(model: model) }
                Spacer()
                if model.output == nil, model.selected != nil {
                    Button { model.togglePin() } label: { Image(systemName: model.selected?.pinned == true ? "pin.slash" : "pin") }
                        .help(model.tr("Pin / unpin", "置顶 / 取消置顶"))
                    Button { model.deleteSelection() } label: { Image(systemName: "trash") }
                        .help(model.tr("Delete", "删除"))
                } else if model.output != nil {
                    Button { model.exportOutput() } label: { Image(systemName: "square.and.arrow.up") }.help(model.tr("Save result", "保存结果"))
                }
            }.buttonStyle(.borderless).foregroundColor(.secondary)
            if let output = model.output {
                if let selection = output.template { templateControls(selection, format: output.format ?? "png", frame: output.usedFrame) }
                if let failure = output.template?.decisionError {
                    Label(model.tr("The AI style pick was unavailable (\(failure.kind)), so local rules chose this template.",
                                   "AI 风格选择暂不可用（\(failure.kind)），已由本地规则选择模板。"), systemImage: "info.circle")
                        .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                        .help(failure.message)
                }
                if let url = output.url {
                    if url.pathExtension.lowercased() == "mp4" {
                        NativeVideoPreview(url: url).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        NativeImagePreview(url: url).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else {
                    textPreview(output.text ?? "")
                }
            } else if let item = model.selected {
                if item.kind == "image", let data = try? model.history?.imageData(id: item.id), let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else { textPreview(item.text ?? item.preview) }
            } else {
                Spacer()
                VStack(alignment: .leading, spacing: 10) {
                    Text("Peesuto").font(.system(size: 28, weight: .medium, design: .rounded))
                    Text(model.tr("A little space for everything you copy.", "给每一次复制，留一点空间。"))
                        .foregroundColor(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Spacer()
            }
            if let recommendation = model.items.first(where: { $0.id == model.recommendedID }), model.output == nil {
                Button {
                    model.selectedID = recommendation.id
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkle")
                        Text(model.tr("Suggested", "推荐")).fontWeight(.medium)
                        Text(recommendation.preview).lineLimit(1)
                    }.font(.system(size: 11)).foregroundColor(.secondary)
                }.buttonStyle(.plain)
            }
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.circle").font(.system(size: 12)).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if model.historyLocked {
                Button(model.tr("Start fresh…", "重新开始…"), action: model.confirmStartFresh).controlSize(.small)
            }
            if model.selected != nil || model.output != nil { actionBar }
        }.padding(24)
    }

    private func textPreview(_ text: String) -> some View {
        ScrollView {
            Text(text).font(.system(size: 18)).lineSpacing(7).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .topLeading).padding(.top, 8)
        }.frame(maxHeight: .infinity)
    }

    private var actionBar: some View {
        HStack(spacing: 10) {
            if model.busy {
                ProgressView().controlSize(.small)
                Text(model.taskStatus).font(.system(size: 12)).foregroundColor(.secondary)
                Button(model.tr("Cancel", "取消")) { model.cancelAction() }.buttonStyle(.borderless)
            } else if model.output == nil && model.selected?.text != nil {
                Menu {
                    ForEach(model.actions.filter { $0.id != "paste-smart" }) { action in
                        Button(model.actionName(action)) { model.run(action) }
                    }
                } label: { Label(model.tr("Actions", "动作"), systemImage: "sparkles") }
                    .menuStyle(.borderlessButton).fixedSize()
                    .disabled(model.actions.isEmpty)
                    .accessibilityIdentifier("action-menu")
            }
            Spacer()
            if model.canPin(model.output) {
                Button { model.pinOutput() } label: { Label(model.tr("Pin to screen", "贴到屏幕"), systemImage: "pin") }
                    .disabled(model.busy)
                    .help(model.tr("Keep this image floating on screen", "把图片贴在屏幕上"))
            }
            Button(model.tr("Copy", "复制")) { model.copySelection() }.disabled(model.busy)
            Button { model.pasteSelection() } label: {
                HStack(spacing: 12) { Text(model.tr("Paste", "粘贴")); Text("↵").foregroundColor(.white.opacity(0.65)) }
            }.buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: [])
                .disabled(model.busy)
        }.controlSize(.large)
    }

    private func templateControls(_ selection: CoreTemplateSelection, format: String, frame: String?) -> some View {
        let kind = OutputFrames.kind(output: format) ?? "image"
        let currentFrame = OutputFrames.normalize(frame, kind: kind)
        let spec = model.templates.first { $0.id == selection.id }
        let variant = spec?.variants.first { $0.id == selection.variant }
        return HStack(spacing: 12) {
            Menu {
                ForEach(model.templates.filter { selection.availableTemplates.contains($0.id) }) { candidate in
                    Button(model.templateName(candidate)) { model.rerender(templateID: candidate.id) }
                }
            } label: { Text(spec.map { model.templateName($0) } ?? selection.id) }
                .help(model.tr("Template", "模板"))
            Menu {
                ForEach(spec?.variants ?? []) { variant in
                    Button(model.variantName(variant)) { model.rerender(variant: variant.id) }
                }
            } label: { Text(variant.map { model.variantName($0) } ?? model.tr("Style", "风格")) }
                .help(model.tr("Change style", "更换风格"))
            if format != "png" {
                Menu {
                    ForEach(spec?.motions ?? [], id: \.self) { motion in
                        Button(model.motionName(motion)) { model.rerender(motion: motion) }
                    }
                } label: { Text(model.motionName(selection.motion)) }
                    .help(model.tr("Motion", "动效"))
            }
            Spacer(minLength: 0)
            Menu {
                ForEach(OutputFrames.options(kind: kind), id: \.self) { option in
                    Button { model.rerender(frame: option) } label: {
                        if option == currentFrame { Label(model.frameName(option), systemImage: "checkmark") }
                        else { Text(model.frameName(option)) }
                    }
                }
            } label: { Text(model.frameName(currentFrame)) }
                .fixedSize()
                .help(model.tr("Frame for this result (the default is in Settings → Shortcuts)", "本次结果的画幅（默认值在「设置 → 快捷键」中）"))
            Menu {
                Button("PNG") { model.rerender(format: "png") }
                Button("GIF") { model.rerender(format: "gif") }
                Button("MP4") { model.rerender(format: "mp4") }
            } label: { Text(format.uppercased()) }
                .help(model.tr("Output format", "输出格式"))
        }.font(.system(size: 11)).menuStyle(.borderlessButton).disabled(model.busy)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Circle().fill(model.paused ? Color.orange : Color.secondary.opacity(0.5)).frame(width: 5, height: 5)
            Text(model.notice ?? (model.previewMode ? model.tr("Preview · sample history", "预览版 · 示例历史") : model.tr(model.paused ? "History paused" : "Stored on this Mac", model.paused ? "已暂停记录" : "历史保存在本机")))
                .lineLimit(1)
            Spacer()
            Text("↑ ↓").font(.system(size: 11, design: .monospaced))
            Text(model.tr("Navigate", "选择"))
            Text("esc").font(.system(size: 11, design: .monospaced)).padding(.leading, 8)
            Text(model.tr("Close", "关闭"))
        }.font(.system(size: 10)).foregroundColor(.secondary).padding(.horizontal, 20).frame(height: 34)
    }

    private func moveSelection(_ delta: Int) {
        guard !model.busy, !model.items.isEmpty else { return }
        let index = model.items.firstIndex { $0.id == model.selectedID } ?? 0
        model.selectedID = model.items[min(max(index + delta, 0), model.items.count - 1)].id
        model.output = nil
    }
    private func sourceName(_ id: String?) -> String {
        guard let id else { return model.tr("Clipboard", "剪贴板") }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url.deletingPathExtension().lastPathComponent }
        return id.components(separatedBy: ".").last ?? id
    }
}

struct NativeVideoPreview: NSViewRepresentable {
    let url: URL
    final class Coordinator { var loadedURL: URL? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.videoGravity = .resizeAspect
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) {
        guard context.coordinator.loadedURL != url else { return }
        view.player?.pause()
        view.player = AVPlayer(url: url)
        context.coordinator.loadedURL = url
    }
    static func dismantleNSView(_ view: AVPlayerView, coordinator: Coordinator) { view.player?.pause(); view.player = nil }
}

final class FittedImageView: NSImageView {
    override var intrinsicContentSize: NSSize { NSSize(width: 1, height: 1) }
}

struct NativeImagePreview: NSViewRepresentable {
    let url: URL
    final class Coordinator { var loadedURL: URL? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSImageView {
        let view = FittedImageView()
        view.imageScaling = .scaleProportionallyUpOrDown
        view.animates = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return view
    }
    func updateNSView(_ view: NSImageView, context: Context) {
        if context.coordinator.loadedURL != url {
            view.image = NSImage(contentsOf: url)
            context.coordinator.loadedURL = url
        }
    }
}

/// A quiet marker for results Core served from background precompose.
struct PrecomposedTag: View {
    @ObservedObject var model: AppState
    var body: some View {
        Text(model.tr("Precomposed", "已预合成"))
            .font(.system(size: 10, weight: .medium)).foregroundColor(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().stroke(Color.secondary.opacity(0.35)))
            .help(model.tr("Rendered in the background right after you copied it.", "复制后已在后台提前生成。"))
    }
}

/// A one-pixel separator that reads on glass (Divider is drawn for opaque backgrounds).
private struct Hairline: View {
    var vertical = false
    var body: some View {
        Rectangle().fill(Color.primary.opacity(0.09))
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}
