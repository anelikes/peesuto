import AppKit
import ApplicationServices
import Carbon

/// No clipboard data is read until the application explicitly starts this monitor.
@MainActor
public final class ClipboardMonitor {
    public static let defaultExcludedApps: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7",
        "com.bitwarden.desktop", "com.apple.keychainaccess"
    ]
    public var excludedApps = ClipboardMonitor.defaultExcludedApps
    public var isPaused = false {
        didSet {
            // A copy made during a short pause must not be recorded after resume,
            // even when no timer tick occurred while paused.
            if isPaused != oldValue, timer != nil { lastChange = NSPasteboard.general.changeCount }
        }
    }
    public var onText: ((String, String?) -> Void)?
    public var onImage: ((Data, String?) -> Void)?
    public var onFiles: (([URL], String?) -> Void)?
    private var timer: Timer?
    private var lastChange = 0
    public init() {}

    public func start() {
        guard timer == nil else { return }
        // Do not import the clipboard contents that predate launch/resume.
        lastChange = NSPasteboard.general.changeCount
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Private type attached to every clipboard write made by Peesuto itself
    /// (copies of results and history items). Such changes are never recorded:
    /// rendered GIF/MP4 file URLs point into Core's pruned cards folder and
    /// would later dangle in history.
    public static let ownWriteType = NSPasteboard.PasteboardType("com.peesuto.desktop.own-write")

    public static func shouldRecord(types: [String], bundleID: String?, excludedApps: Set<String>) -> Bool {
        !types.contains(ownWriteType.rawValue) &&
        !types.contains("org.nspasteboard.ConcealedType") &&
        !types.contains("org.nspasteboard.TransientType") &&
        !excludedApps.contains(bundleID ?? "")
    }

    private func poll() {
        let board = NSPasteboard.general
        let count = board.changeCount
        guard count != lastChange else { return }
        lastChange = count
        guard !isPaused else { return }
        let bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard Self.shouldRecord(types: (board.types ?? []).map(\.rawValue), bundleID: bundleID, excludedApps: excludedApps) else { return }
        if let text = board.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard board.changeCount == count else { return }
            onText?(text, bundleID)
            return
        }
        let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !urls.isEmpty {
            guard board.changeCount == count else { return }
            onFiles?(urls, bundleID)
            return
        }
        guard let bytes = board.data(forType: .png) ?? board.data(forType: .tiff),
              !bytes.isEmpty, bytes.count <= 40 * 1024 * 1024,
              board.changeCount == count else { return }
        // Store PNG even if the source is TIFF, so previews and future readers agree.
        if board.availableType(from: [.png]) != nil {
            onImage?(bytes, bundleID)
        } else if let bitmap = NSBitmapImageRep(data: bytes),
                  let png = bitmap.representation(using: .png, properties: [:]), png.count <= 40 * 1024 * 1024 {
            onImage?(png, bundleID)
        }
    }

    deinit { timer?.invalidate() }
}

public enum PasteResult: Equatable {
    case pasted
    case copiedOnly(reason: String)
    case failed(reason: String)
}

/// Why a shortcut result was copied but not pasted.
public enum DirectPasteBlock: Equatable, Sendable {
    /// Accessibility is not granted, so no key event can be sent.
    case accessibility
    /// Secure event input is on (a password field has focus).
    case secureInput
    /// Peesuto itself is frontmost; pasting would target our own window.
    case selfFrontmost
}

public enum DirectPasteOutcome: Equatable {
    case pasted
    case copiedOnly(DirectPasteBlock)
    case failed(reason: String)
}

/// Media shortcuts express the intent to paste where the user is now, so the
/// only reasons not to press ⌘V are the ones below.
public enum DirectPaste {
    public static func decide(trusted: Bool, secureInput: Bool, frontmostIsSelf: Bool) -> DirectPasteBlock? {
        if !trusted { return .accessibility }
        if secureInput { return .secureInput }
        if frontmostIsSelf { return .selfFrontmost }
        return nil
    }
}

/// All writes are invoked by explicit Copy/Paste actions; no permission prompt is automatic.
@MainActor
public final class PasteController {
    private var previous: NSRunningApplication?
    public var beforePaste: (() -> Void)?
    public init() {}
    public static var accessibilityTrusted: Bool { AXIsProcessTrusted() }

    @discardableResult
    public static func requestAccessibility() -> Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    public func rememberFrontmost() {
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        previous = application
    }

    @discardableResult
    public func copyText(_ text: String) -> Bool {
        Self.write([Self.textItem(text)])
    }

    @discardableResult
    public func copyImage(_ png: Data) -> Bool {
        guard let data = Self.normalizedPNG(png) else { return false }
        return Self.write([Self.imageItem(data)])
    }

    /// GIF bytes plus a PNG of the first frame for apps that do not read GIF.
    @discardableResult
    public func copyGIF(_ gif: Data) -> Bool {
        guard !gif.isEmpty, let png = NSBitmapImageRep(data: gif)?.representation(using: .png, properties: [:]) else { return false }
        let item = NSPasteboardItem()
        item.setData(gif, forType: NSPasteboard.PasteboardType("com.compuserve.gif"))
        item.setData(png, forType: .png)
        return Self.write([Self.marked(item)])
    }

    private static func write(_ items: [NSPasteboardItem]) -> Bool {
        let board = NSPasteboard.general
        board.clearContents()
        return board.writeObjects(items)
    }

    static func marked(_ item: NSPasteboardItem) -> NSPasteboardItem {
        item.setData(Data(), forType: ClipboardMonitor.ownWriteType)
        return item
    }

    static func textItem(_ text: String) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        return marked(item)
    }

    static func imageItem(_ png: Data) -> NSPasteboardItem {
        let item = NSPasteboardItem()
        item.setData(png, forType: .png)
        return marked(item)
    }

    /// Older history entries may carry TIFF bytes despite a PNG file extension.
    static func normalizedPNG(_ data: Data) -> Data? {
        guard !data.isEmpty, let bitmap = NSBitmapImageRep(data: data) else { return nil }
        let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
        if data.starts(with: signature) { return data }
        return bitmap.representation(using: .png, properties: [:])
    }

    @discardableResult
    public func copyFile(_ url: URL) -> Bool {
        copyFiles([url])
    }

    @discardableResult
    public func copyFiles(_ urls: [URL]) -> Bool {
        guard let items = Self.fileItems(urls) else { return false }
        return Self.write(items)
    }

    /// Build every item before touching the pasteboard, so missing files never
    /// replace the user's clipboard with an incomplete selection.
    static func fileItems(_ urls: [URL]) -> [NSPasteboardItem]? {
        guard !urls.isEmpty,
              urls.allSatisfy({ $0.isFileURL && FileManager.default.fileExists(atPath: $0.path) }) else { return nil }
        return urls.map { url in
            let item = NSPasteboardItem()
            item.setString(url.absoluteString, forType: .fileURL)
            if urls.count == 1, url.pathExtension.lowercased() == "gif", let data = try? Data(contentsOf: url) {
                item.setData(data, forType: NSPasteboard.PasteboardType("com.compuserve.gif"))
            }
            return marked(item)
        }
    }

    public func pasteText(_ text: String) async -> PasteResult { await deliver(written: copyText(text)) }
    public func pasteImage(_ png: Data) async -> PasteResult { await deliver(written: copyImage(png)) }
    public func pasteFile(_ url: URL) async -> PasteResult { await deliver(written: copyFile(url)) }
    public func pasteFiles(_ urls: [URL]) async -> PasteResult { await deliver(written: copyFiles(urls)) }

    /// Media shortcut delivery: write the result (marked as our own write) and
    /// press ⌘V into whatever app is frontmost now. The result stays on the
    /// clipboard either way.
    public func pasteText(toFrontmost text: String) -> DirectPasteOutcome {
        deliverToFrontmost { self.copyText(text) }
    }
    public func pasteImage(toFrontmost image: Data) -> DirectPasteOutcome {
        guard let png = Self.normalizedPNG(image) else { return .failed(reason: "Could not read the rendered image.") }
        return deliverToFrontmost { Self.write([Self.imageItem(png)]) }
    }
    public func pasteFile(toFrontmost url: URL) -> DirectPasteOutcome {
        guard let items = Self.fileItems([url]) else { return .failed(reason: "The rendered file is unavailable.") }
        return deliverToFrontmost { Self.write(items) }
    }

    private func deliverToFrontmost(write: () -> Bool) -> DirectPasteOutcome {
        guard write() else { return .failed(reason: "Could not write to the clipboard.") }
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if let block = DirectPaste.decide(trusted: AXIsProcessTrusted(), secureInput: IsSecureEventInputEnabled(),
                                          frontmostIsSelf: frontmost == ProcessInfo.processInfo.processIdentifier) {
            return .copiedOnly(block)
        }
        return Self.pressPaste() == .pasted ? .pasted : .failed(reason: "Could not create the paste key event.")
    }

    private func deliver(written: Bool) async -> PasteResult {
        guard written else { return .failed(reason: "Could not write to the clipboard.") }
        let writtenChangeCount = NSPasteboard.general.changeCount
        guard Self.accessibilityTrusted else {
            return .copiedOnly(reason: "Copied. Allow Accessibility access to paste automatically, or press ⌘V yourself.")
        }
        guard let destination = previous, !destination.isTerminated else {
            return .copiedOnly(reason: "Copied. The previous application is unavailable.")
        }
        beforePaste?()
        guard destination.activate(options: [.activateIgnoringOtherApps]) else {
            return .copiedOnly(reason: "Copied. Could not activate the previous application.")
        }
        // Never send the synthetic paste to an unrelated foreground application.
        do { try await Task.sleep(nanoseconds: 120_000_000) }
        catch { return .copiedOnly(reason: "Copied. Paste was cancelled.") }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == destination.processIdentifier else {
            return .copiedOnly(reason: "Copied. The previous application did not receive focus.")
        }
        guard NSPasteboard.general.changeCount == writtenChangeCount else {
            return .copiedOnly(reason: "The clipboard changed before pasting. Paste was cancelled.")
        }
        return Self.pressPaste()
    }

    private static func pressPaste() -> PasteResult {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false) else {
            return .copiedOnly(reason: "Copied. Could not create the paste key event.")
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return .pasted
    }
}

public enum ContextCapture {
    /// AX ranges count UTF-16 units. Clamp malformed ranges and limit context to 200 Unicode scalars.
    public static func aroundCaret(_ value: String, location: Int, length: Int) -> (before: String, after: String) {
        let units = Array(value.utf16)
        let start = min(max(0, location), units.count)
        let remaining = units.count - start
        let end = start + min(max(0, length), remaining)
        let before = String(decoding: units[..<start], as: UTF16.self)
        let after = String(decoding: units[end...], as: UTF16.self)
        return (String(String.UnicodeScalarView(before.unicodeScalars.suffix(200))),
                String(String.UnicodeScalarView(after.unicodeScalars.prefix(200))))
    }

    /// Call only when opening history for a user action, before taking focus. Never persist this payload.
    @MainActor
    public static func capture() -> [String: Any] {
        let front = NSWorkspace.shared.frontmostApplication
        var result: [String: Any] = ["level": 0, "appBundleId": front?.bundleIdentifier ?? ""]
        if let name = front?.localizedName { result["appName"] = name }
        guard AXIsProcessTrusted(), let front else { return result }
        let app = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.35)
        if let window = element(app, kAXFocusedWindowAttribute), let title = string(window, kAXTitleAttribute) {
            result["windowTitle"] = title
        }
        guard let focused = element(app, kAXFocusedUIElementAttribute) else { return result }
        AXUIElementSetMessagingTimeout(focused, 0.35)
        let role = string(focused, kAXRoleAttribute)
        let subrole = string(focused, kAXSubroleAttribute)
        if let role { result["role"] = role; result["level"] = 1 }
        if let subrole { result["subrole"] = subrole }
        // Secure fields are recognized before reading any label, value, or selected text.
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            result["secure"] = true
            return result
        }
        result["label"] = string(focused, kAXTitleAttribute) ?? string(focused, kAXDescriptionAttribute) ?? string(focused, kAXPlaceholderValueAttribute)
        let containers: Set<String> = ["AXWebArea", "AXGroup", "AXScrollArea", "AXWindow", "AXApplication", "AXSplitGroup", "AXToolbar"]
        if let role, !containers.contains(role), let rawRange = attribute(focused, kAXSelectedTextRangeAttribute),
           CFGetTypeID(rawRange) == AXValueGetTypeID() {
            let axRange = unsafeBitCast(rawRange, to: AXValue.self)
            var range = CFRange()
            if AXValueGetValue(axRange, .cfRange, &range), range.location >= 0, range.length >= 0,
               let value = attribute(focused, kAXValueAttribute) as? String {
                let context = aroundCaret(value, location: range.location, length: range.length)
                result["before"] = context.before
                result["after"] = context.after
                result["level"] = 2
            }
        }
        return result
    }

    fileprivate static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
    fileprivate static func string(_ element: AXUIElement, _ name: String) -> String? {
        guard let text = attribute(element, name) as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    fileprivate static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
}

public enum HotKeyError: LocalizedError {
    case invalid(String)
    case unavailable(OSStatus)
    case duplicate(String, String)
    public var errorDescription: String? {
        switch self {
        case .invalid(let accelerator): return "Unsupported keyboard shortcut: \(accelerator)"
        case .unavailable(let status): return "The keyboard shortcut could not be registered (\(status)). It may already be in use."
        case .duplicate(let first, let second): return "The keyboard shortcuts for \(first) and \(second) are identical."
        }
    }
}

@MainActor
protocol HotKeyRegistration: AnyObject {
    func register(accelerator: String, handler: @escaping () -> Void) throws
    func unregister()
}

struct HotKeyCombination: Hashable {
    let keyCode: UInt32
    let modifiers: UInt32
}

/// Transactional shortcut group. Existing keys stay registered until all new
/// keys succeed; swaps simply change dispatch routes without a registration gap.
@MainActor
public final class HotKeyGroup {
    private var registrations: [HotKeyCombination: HotKeyRegistration] = [:]
    private var routes: [HotKeyCombination: String] = [:]
    private var handler: ((String) -> Void)?
    private let makeRegistration: () -> HotKeyRegistration
    public init() { makeRegistration = { HotKeyManager() } }
    init(makeRegistration: @escaping () -> HotKeyRegistration) { self.makeRegistration = makeRegistration }

    public static func validate(_ shortcuts: [String: String]) throws { _ = try normalized(shortcuts) }

    private static func normalized(_ shortcuts: [String: String]) throws -> [HotKeyCombination: (id: String, accelerator: String)] {
        var proposed: [HotKeyCombination: (id: String, accelerator: String)] = [:]
        for id in shortcuts.keys.sorted() {
            let accelerator = (shortcuts[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if accelerator.isEmpty { continue }
            let parsed = try HotKeyManager.parse(accelerator)
            let key = HotKeyCombination(keyCode: parsed.keyCode, modifiers: parsed.modifiers)
            if let duplicate = proposed[key] { throw HotKeyError.duplicate(duplicate.id, id) }
            proposed[key] = (id, accelerator)
        }
        return proposed
    }

    public func register(_ shortcuts: [String: String], handler: @escaping (String) -> Void) throws {
        let proposed = try Self.normalized(shortcuts)
        var added: [HotKeyCombination: HotKeyRegistration] = [:]
        do {
            for (key, value) in proposed where registrations[key] == nil {
                let registration = makeRegistration()
                added[key] = registration
                try registration.register(accelerator: value.accelerator) { [weak self] in
                    guard let self, let id = self.routes[key] else { return }
                    self.handler?(id)
                }
            }
        } catch {
            for registration in added.values { registration.unregister() }
            throw error
        }
        let removed = registrations.filter { proposed[$0.key] == nil }
        registrations = registrations.filter { proposed[$0.key] != nil }.merging(added) { _, new in new }
        routes = proposed.mapValues(\.id)
        self.handler = handler
        for registration in removed.values { registration.unregister() }
    }

    public func unregister() {
        for registration in registrations.values { registration.unregister() }
        registrations.removeAll()
        routes.removeAll()
        handler = nil
    }
}

/// Carbon hotkeys do not require Accessibility permission.
@MainActor
public final class HotKeyManager: HotKeyRegistration {
    private static var nextEventID: UInt32 = 1
    let eventID: UInt32
    private var reference: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var handler: (() -> Void)?
    private var registeredKey: (keyCode: UInt32, modifiers: UInt32)?
    public init() {
        // Never recycle an ID while stale Carbon events may still be queued.
        precondition(Self.nextEventID < UInt32.max, "Hotkey identifier space exhausted")
        eventID = Self.nextEventID
        Self.nextEventID += 1
    }

    func matchesEvent(signature: OSType, id: UInt32) -> Bool { signature == 0x50535554 && id == eventID }

    /// A replacement is registered before the old key is removed, preserving it on conflict.
    public func register(accelerator: String, handler: @escaping () -> Void) throws {
        let parsed = try Self.parse(accelerator)
        if let registeredKey, reference != nil,
           registeredKey.keyCode == parsed.keyCode, registeredKey.modifiers == parsed.modifiers {
            self.handler = handler
            return
        }
        if eventHandler == nil {
            var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let context, let event else { return OSStatus(eventNotHandledErr) }
                var id = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr,
                      id.signature == 0x50535554 else { return OSStatus(eventNotHandledErr) }
                let manager = Unmanaged<HotKeyManager>.fromOpaque(context).takeUnretainedValue()
                return MainActor.assumeIsolated {
                    guard manager.matchesEvent(signature: id.signature, id: id.id) else { return OSStatus(eventNotHandledErr) }
                    manager.handler?()
                    return noErr
                }
            }, 1, &type, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
            guard status == noErr else { throw HotKeyError.unavailable(status) }
        }
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(parsed.keyCode, parsed.modifiers,
                                        EventHotKeyID(signature: 0x50535554, id: eventID), GetApplicationEventTarget(), 0, &replacement)
        guard status == noErr else { throw HotKeyError.unavailable(status) }
        if let reference { UnregisterEventHotKey(reference) }
        reference = replacement
        registeredKey = parsed
        self.handler = handler
    }

    public func unregister() {
        if let reference { UnregisterEventHotKey(reference) }
        reference = nil
        registeredKey = nil
        handler = nil
        if let eventHandler { RemoveEventHandler(eventHandler) }
        eventHandler = nil
    }

    public static func parse(_ accelerator: String) throws -> (keyCode: UInt32, modifiers: UInt32) {
        let parts = accelerator.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 2, let key = parts.last else { throw HotKeyError.invalid(accelerator) }
        var modifiers: UInt32 = 0
        for part in parts.dropLast() {
            switch part {
            case "cmdorctrl", "commandorcontrol", "cmd", "command", "super", "meta": modifiers |= UInt32(cmdKey)
            case "ctrl", "control": modifiers |= UInt32(controlKey)
            case "alt", "option": modifiers |= UInt32(optionKey)
            case "shift": modifiers |= UInt32(shiftKey)
            default: throw HotKeyError.invalid(accelerator)
            }
        }
        guard modifiers & UInt32(cmdKey | controlKey | optionKey) != 0,
              let code = keyCodes[key] else { throw HotKeyError.invalid(accelerator) }
        return (UInt32(code), modifiers)
    }

    private static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
        "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
        "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
        "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab,
        "escape": kVK_Escape, "esc": kVK_Escape, "backspace": kVK_Delete, "delete": kVK_ForwardDelete,
        "up": kVK_UpArrow, "arrowup": kVK_UpArrow, "down": kVK_DownArrow, "arrowdown": kVK_DownArrow,
        "left": kVK_LeftArrow, "arrowleft": kVK_LeftArrow, "right": kVK_RightArrow, "arrowright": kVK_RightArrow,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12
    ]

    deinit {
        if let reference { UnregisterEventHotKey(reference) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }
}
