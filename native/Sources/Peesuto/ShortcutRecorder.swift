import AppKit
import SwiftUI
import PeesutoKit

struct ShortcutRecorder: NSViewRepresentable {
    @Binding var value: String
    let emptyTitle: String
    let recordingTitle: String
    let recordingChanged: (Bool) -> Void

    func makeNSView(context: Context) -> ShortcutButton { ShortcutButton() }
    func updateNSView(_ view: ShortcutButton, context: Context) {
        view.value = value
        view.emptyTitle = emptyTitle
        view.recordingTitle = recordingTitle
        view.changed = { value = $0 }
        view.recordingChanged = recordingChanged
        view.refreshTitle()
    }
    static func dismantleNSView(_ view: ShortcutButton, coordinator: ()) { view.finish() }
}

final class ShortcutButton: NSButton {
    var value = ""
    var emptyTitle = "Disabled"
    var recordingTitle = "Press shortcut…"
    var changed: ((String) -> Void)?
    var recordingChanged: ((Bool) -> Void)?
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var recording = false
    override var acceptsFirstResponder: Bool { true }

    init() {
        super.init(frame: .zero)
        bezelStyle = .rounded
        font = .systemFont(ofSize: 12)
        target = self
        action = #selector(begin)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func refreshTitle() {
        title = recording ? recordingTitle : value.isEmpty ? emptyTitle : value
            .replacingOccurrences(of: "CmdOrCtrl", with: "⌘")
            .replacingOccurrences(of: "Command", with: "⌘")
            .replacingOccurrences(of: "Control", with: "⌃")
            .replacingOccurrences(of: "Alt", with: "⌥")
            .replacingOccurrences(of: "Shift", with: "⇧")
            .replacingOccurrences(of: "+", with: " ")
        setAccessibilityValue(title)
    }
    @objc private func begin() {
        guard !recording else { finish(); return }
        window?.makeFirstResponder(self)
        recording = true
        recordingChanged?(true)
        refreshTitle()
        for name in [NSWindow.didResignKeyNotification, NSWindow.willCloseNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in self?.finish() })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.finish() })
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.recording else { return event }
            guard event.window === self.window else { self.finish(); return event }
            self.record(event)
            return nil
        }
    }
    override func resignFirstResponder() -> Bool { finish(); return super.resignFirstResponder() }
    func finish() {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        guard recording else { return }
        recording = false
        recordingChanged?(false)
        refreshTitle()
    }
    private func record(_ event: NSEvent) {
        if event.keyCode == 53 { finish(); return }
        guard !event.isARepeat else { return }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard !flags.intersection([.command, .control, .option]).isEmpty else { NSSound.beep(); return }
        // Use the same physical keys as Carbon registration, independent of the input method.
        let keys: [UInt16: String] = [0:"A",1:"S",2:"D",3:"F",4:"H",5:"G",6:"Z",7:"X",8:"C",9:"V",11:"B",12:"Q",13:"W",14:"E",15:"R",16:"Y",17:"T",18:"1",19:"2",20:"3",21:"4",22:"6",23:"5",25:"9",26:"7",28:"8",29:"0",31:"O",32:"U",34:"I",35:"P",37:"L",38:"J",40:"K",45:"N",46:"M",36:"Return",48:"Tab",49:"Space",51:"Backspace",117:"Delete",123:"Left",124:"Right",125:"Down",126:"Up",122:"F1",120:"F2",99:"F3",118:"F4",96:"F5",97:"F6",98:"F7",100:"F8",101:"F9",109:"F10",103:"F11",111:"F12"]
        guard let key = keys[event.keyCode] else { NSSound.beep(); return }
        var parts: [String] = []
        if flags.contains(.command) { parts.append("CmdOrCtrl") }
        if flags.contains(.control) { parts.append("Control") }
        if flags.contains(.option) { parts.append("Alt") }
        if flags.contains(.shift) { parts.append("Shift") }
        parts.append(key)
        let shortcut = parts.joined(separator: "+")
        guard (try? HotKeyManager.parse(shortcut)) != nil else { NSSound.beep(); return }
        value = shortcut
        changed?(shortcut)
        finish()
    }
}
