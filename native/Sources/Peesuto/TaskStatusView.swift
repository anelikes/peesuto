import SwiftUI

/// The card for shortcut outcomes the user has to act on: Accessibility is
/// missing (Grant access…), or a password field blocked the paste (press ⌘V
/// yourself). Everything else is shown at the caret (`CaretFeedback`).
struct TaskStatusView: View {
    @ObservedObject var model: AppState
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                Image(systemName: model.error == nil ? "doc.on.clipboard" : "exclamationmark.circle")
                    .foregroundColor(model.error == nil ? .accentColor : .orange)
                Text(model.error ?? model.notice ?? model.tr("Ready", "已就绪"))
                    .font(.system(size: 12, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            if model.needsAccessibility, !model.trusted {
                Text(model.accessibilityResetHint)
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 25)
            }
            HStack {
                Text("Peesuto").font(.system(size: 10)).foregroundColor(.secondary)
                Spacer()
                if model.needsAccessibility, !model.trusted {
                    Button(model.tr("Grant access…", "授予权限…"), action: model.openAccessibilitySettings)
                        .buttonStyle(.borderedProminent)
                }
                Button(model.tr("Dismiss", "关闭"), action: dismiss)
            }.controlSize(.small)
        }.padding(18).frame(width: 324, alignment: .leading)
    }
}
