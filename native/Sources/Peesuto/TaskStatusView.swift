import SwiftUI

struct TaskStatusView: View {
    @ObservedObject var model: AppState
    let openResult: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                if model.busy { ProgressView().controlSize(.small) }
                else { Image(systemName: model.error == nil ? "checkmark.circle" : "exclamationmark.circle").foregroundColor(model.error == nil ? .accentColor : .orange) }
                Text(model.busy ? model.taskStatus : model.error ?? model.notice ?? model.tr("Ready", "已就绪"))
                    .font(.system(size: 12, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            HStack {
                Text("Peesuto").font(.system(size: 10)).foregroundColor(.secondary)
                Spacer()
                if model.busy {
                    Button(model.tr("Cancel", "取消"), action: model.cancelAction)
                } else {
                    if model.output != nil { Button(model.tr("View result", "查看结果"), action: openResult) }
                    Button(model.tr("Dismiss", "关闭"), action: dismiss)
                }
            }.controlSize(.small)
        }.padding(18).frame(width: 324, alignment: .leading)
    }
}
