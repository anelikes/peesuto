import SwiftUI
import AppKit
import PeesutoKit

/// Reports whether the window showing this view is on screen (visible and not
/// fully covered). SwiftUI's onAppear/onDisappear do not fire when a window is
/// ordered out or closed, and views that make the app poll must stop then.
struct WindowVisibility: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.changed = changed
        return probe
    }
    func updateNSView(_ probe: Probe, context: Context) { probe.changed = changed }
    static func dismantleNSView(_ probe: Probe, coordinator: ()) { probe.detach() }

    final class Probe: NSView {
        var changed: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var last: Bool?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeObservers()
            if let window {
                for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification] {
                    observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                        MainActor.assumeIsolated { self?.report(closing: note.name == NSWindow.willCloseNotification) }
                    })
                }
            }
            report(closing: false)
        }

        func detach() {
            removeObservers()
            if last == true { last = false; send(false) }
        }

        private func removeObservers() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
        }

        private func report(closing: Bool) {
            let visible = !closing && window?.isVisible == true && window?.occlusionState.contains(.visible) == true
            guard visible != last else { return }
            last = visible
            send(visible)
        }

        /// Never during a SwiftUI update.
        private func send(_ visible: Bool) {
            let changed = self.changed
            DispatchQueue.main.async { changed?(visible) }
        }
    }
}

/// One JIZURA font pack in Settings › Templates: size and state, and what can
/// be done with it now.
struct FontPackRow: View {
    @ObservedObject var model: AppState
    let pack: CoreFontPack

    private var downloading: Bool { pack.installing || (model.fontRequests.contains(pack.id) && !pack.installed) }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pack.title.text(model.localizer.language)).font(.system(size: 12, weight: .medium))
                    Text(detail).font(.system(size: 11)).foregroundColor(.secondary).monospacedDigit()
                }
                Spacer()
                if pack.installed {
                    Button(model.tr("Remove", "移除")) { model.removeFontPack(pack.id) }
                        .help(model.tr("Delete these fonts from this Mac; Lyric motion in this language goes back to the classic style.",
                                       "从本机删除这些字体；这种语言的文字 PV 将改回经典风格。"))
                } else if downloading {
                    Button(model.tr("Cancel", "取消")) { model.cancelFontPack(pack.id) }
                } else {
                    Button(model.tr("Download", "下载")) { model.downloadFontPack(pack.id) }
                        .disabled(model.offline)
                }
            }
            if downloading && !pack.installed {
                if let fraction = pack.progress?.fraction { ProgressView(value: fraction) } else { ProgressView().progressViewStyle(.linear) }
            }
            // The failure of a download started here, else the one Core last reported.
            if let failure = model.fontFailures[pack.id] ?? pack.error?.message, !downloading, !pack.installed {
                Text(failure).font(.system(size: 11)).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
        .controlSize(.small)
    }

    private var detail: String {
        let size = FontPackSize.text(pack.bytes)
        if pack.installed { return model.tr("Installed", "已安装") + " · " + size }
        if downloading, let progress = pack.progress, progress.total > 0 {
            let done = FontPackSize.text(progress.done).replacingOccurrences(of: " MB", with: "")
            let total = FontPackSize.text(progress.total)
            return model.tr("Downloading… \(done) of \(total)", "正在下载… \(done) / \(total)", ja: "ダウンロード中… \(done) / \(total)")
        }
        if downloading { return model.tr("Downloading…", "正在下载…") }
        return size
    }
}

/// The history panel's note under a Lyric motion GIF or video that the classic
/// renderer drew instead of JIZURA: why, and for missing fonts a Download
/// button (progress inline), then Redraw with JIZURA once they are in.
struct LyricFallbackNote: View {
    @ObservedObject var model: AppState
    let fallback: LyricFallback

    private var packs: [CoreLyricPack] { fallback.packs }
    private func status(_ id: String) -> CoreFontPack? { model.fontStatus?.pack(id) }
    private var installed: Bool { !packs.isEmpty && packs.allSatisfy { status($0.id)?.installed == true } }
    private var downloading: [CoreLyricPack] {
        packs.filter { status($0.id)?.installed != true && (status($0.id)?.installing == true || model.fontRequests.contains($0.id)) }
    }
    private var failures: [String] { packs.compactMap { model.fontFailures[$0.id] } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Label(fallback.message(model.localizer), systemImage: "info.circle")
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                controls
            }
            if downloading.isEmpty, let failure = failures.first {
                Text(failure).font(.system(size: 11)).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
            } else if downloading.isEmpty, !installed, !packs.isEmpty, model.offline {
                Text(model.tr("Offline mode is on, so nothing is downloaded. Turn it off in Settings › AI & actions.",
                              "离线模式已开启，不会下载任何内容。可在“设置 › AI 与动作”中关闭。"))
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .controlSize(.small)
        // Also when the packs are not known yet: the status names them.
        .background(WindowVisibility { visible in if fallback.isFontsMissing { model.fontsVisible("panel", visible) } })
        .onDisappear { model.fontsVisible("panel", false) }
    }

    @ViewBuilder private var controls: some View {
        if installed {
            Button(model.tr("Redraw with JIZURA", "用 JIZURA 重新绘制")) { model.rerender() }
                .disabled(model.busy)
        } else if !downloading.isEmpty {
            let progress = downloading.compactMap { status($0.id)?.progress }
            let total = progress.reduce(0) { $0 + $1.total }
            if total > 0 {
                ProgressView(value: min(progress.reduce(0) { $0 + $1.done } / total, 1)).frame(width: 90)
            } else {
                ProgressView().progressViewStyle(.linear).frame(width: 90)
            }
            Button(model.tr("Cancel", "取消")) { for pack in downloading { model.cancelFontPack(pack.id) } }
        } else if !packs.isEmpty {
            let needed = packs.filter { status($0.id)?.installed != true }
            let size = FontPackSize.text(needed.reduce(0) { $0 + $1.bytes })
            Button(model.tr("Download (\(size))", "下载（\(size)）", ja: "ダウンロード（\(size)）")) {
                for pack in needed { model.downloadFontPack(pack.id) }
            }
            .disabled(model.offline)
            .help(model.tr("From GitHub (anelikes/peesuto releases), only now that you ask.", "来自 GitHub（anelikes/peesuto 的发布页），只在你点击时下载。"))
        }
    }
}

/// Preview builds only (`--fonts-sample`): a pretend `fonts.status` for
/// screenshots and trying the UI without Core's download. Packs installed
/// from the UI count up to done.
@MainActor final class PreviewFontPacks {
    private(set) var packs: [CoreFontPack]
    private var running: Set<String> = []

    init() {
        func title(en: String, zh: String, ja: String) -> CoreLabels { CoreLabels(en: en, zh: zh, ja: ja) }
        packs = [
            CoreFontPack(id: "base", title: title(en: "Base fonts (Latin)", zh: "基础字体（拉丁字母）", ja: "基本フォント（欧文）"), bytes: 2_900_000,
                         installed: true, bundled: true, langs: ["en"]),
            CoreFontPack(id: "ja", title: title(en: "Japanese lyric fonts", zh: "日文歌词字体", ja: "日本語の歌詞フォント"), bytes: 56_022_016,
                         installed: true, langs: ["ja"]),
            CoreFontPack(id: "zh-hans", title: title(en: "Simplified Chinese lyric fonts", zh: "简体中文歌词字体", ja: "簡体字中国語の歌詞フォント"), bytes: 68_869_120,
                         installing: true, langs: ["zh-Hans"], families: ["Noto Sans SC", "Noto Serif SC"],
                         progress: CoreFontProgress(done: 29_100_000, total: 68_869_120)),
            CoreFontPack(id: "zh-hant", title: title(en: "Traditional Chinese lyric fonts", zh: "繁体中文歌词字体", ja: "繁体字中国語の歌詞フォント"), bytes: 66_180_096,
                         langs: ["zh-Hant"], families: ["Noto Sans TC", "Noto Serif TC"]),
            CoreFontPack(id: "ko", title: title(en: "Korean lyric fonts", zh: "韩文歌词字体", ja: "韓国語の歌詞フォント"), bytes: 34_932_224,
                         langs: ["ko"], families: ["Noto Sans KR"],
                         error: CoreFontPackError(code: "network", message: "Could not download ko-3c9ee757.tar: the connection was reset.")),
        ]
    }

    var status: CoreFontsStatus { CoreFontsStatus(offline: false, packs: packs) }

    func install(_ id: String) {
        update(id) { CoreFontPack(id: $0.id, title: $0.title, bytes: $0.bytes, installing: true, langs: $0.langs, families: $0.families,
                                  progress: CoreFontProgress(done: 0, total: $0.bytes)) }
        running.insert(id)
    }
    func cancel(_ id: String) {
        running.remove(id)
        update(id) { CoreFontPack(id: $0.id, title: $0.title, bytes: $0.bytes, langs: $0.langs, families: $0.families) }
    }
    func remove(_ id: String) { cancel(id) }

    /// One poll's worth of progress for the downloads started here.
    func advance() {
        for id in running {
            update(id) { pack in
                let done = min((pack.progress?.done ?? 0) + pack.bytes * 0.08, pack.bytes)
                return done >= pack.bytes
                    ? CoreFontPack(id: pack.id, title: pack.title, bytes: pack.bytes, installed: true, langs: pack.langs, families: pack.families)
                    : CoreFontPack(id: pack.id, title: pack.title, bytes: pack.bytes, installing: true, langs: pack.langs, families: pack.families,
                                   progress: CoreFontProgress(done: done, total: pack.bytes))
            }
            if packs.first(where: { $0.id == id })?.installed == true { running.remove(id) }
        }
    }

    private func update(_ id: String, _ change: (CoreFontPack) -> CoreFontPack) {
        guard let index = packs.firstIndex(where: { $0.id == id }) else { return }
        packs[index] = change(packs[index])
    }
}
