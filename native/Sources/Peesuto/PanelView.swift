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
                Image(systemName: "magnifyingglass").foregroundColor(.secondary)
                TextField(model.tr("Search your clipboard", "搜索剪贴板"), text: $model.query)
                    .textFieldStyle(.plain).font(.system(size: 17)).focused($searchFocused)
                    .onSubmit { model.pasteSelection() }
                    .accessibilityIdentifier("history-search")
                if !model.query.isEmpty {
                    Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundColor(.secondary)
                }
                Button(action: openSettings) { Image(systemName: "gearshape").font(.system(size: 16)) }
                    .buttonStyle(.plain).foregroundColor(.secondary)
                    .help(model.tr("Settings", "设置")).accessibilityLabel(model.tr("Settings", "设置"))
            }.padding(.horizontal, 24).frame(height: 68)
            Divider()
            HStack(spacing: 0) {
                history.frame(width: 282)
                Divider()
                detail.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            footer
        }
        .background(Color(NSColor.windowBackgroundColor))
        .frame(minWidth: 760, minHeight: 500)
        .onAppear { searchFocused = true }
        .onExitCommand {
            if model.output != nil { model.output = nil }
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
        }.background(Color(NSColor.controlBackgroundColor).opacity(0.55))
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
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color(NSColor.windowBackgroundColor)))
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
            .background(RoundedRectangle(cornerRadius: 9).fill(model.selectedID == item.id ? Color.accentColor.opacity(0.1) : .clear))
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
        .accessibilityLabel(item.preview)
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                if model.output != nil {
                    Button { model.output = nil } label: { Label(model.tr("Back", "返回"), systemImage: "chevron.left") }.buttonStyle(.plain)
                } else {
                    Text(model.tr("PREVIEW", "内容预览")).font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundColor(.secondary)
                }
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
            Button(model.tr("Copy", "复制")) { model.copySelection() }
            Button { model.pasteSelection() } label: {
                HStack(spacing: 12) { Text(model.tr("Paste", "粘贴")); Text("↵").foregroundColor(.white.opacity(0.65)) }
            }.buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: [])
                .disabled(model.busy)
        }.controlSize(.large)
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
        guard !model.items.isEmpty else { return }
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
