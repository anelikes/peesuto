import Foundation

// JIZURA's font packs (Settings › Templates › Fonts for JIZURA). Core owns
// the files and the download (`fonts.status` / `fonts.install` /
// `fonts.cancel` / `fonts.remove`); the app only asks, shows progress, and
// asks again when Core restarted in the middle. Nothing is downloaded unless
// the user pressed Download.

/// Download progress of a font pack, in bytes.
public struct CoreFontProgress: Codable, Equatable, Sendable {
    public let done: Double
    public let total: Double
    public init(done: Double, total: Double) { self.done = done; self.total = total }
    /// 0…1; nil when the total is unknown.
    public var fraction: Double? { total > 0 ? min(max(done / total, 0), 1) : nil }
}

public struct CoreFontPackError: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// A JIZURA font pack as `fonts.status` lists it. Decoded leniently.
public struct CoreFontPack: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: CoreLabels
    public let bytes: Double
    public let installed: Bool
    public let bundled: Bool
    public let installing: Bool
    public let langs: [String]
    public let families: [String]
    public let progress: CoreFontProgress?
    public let error: CoreFontPackError?

    public init(id: String, title: CoreLabels, bytes: Double, installed: Bool = false, bundled: Bool = false, installing: Bool = false,
                langs: [String] = [], families: [String] = [], progress: CoreFontProgress? = nil, error: CoreFontPackError? = nil) {
        self.id = id; self.title = title; self.bytes = bytes; self.installed = installed; self.bundled = bundled
        self.installing = installing; self.langs = langs; self.families = families; self.progress = progress; self.error = error
    }

    private enum Keys: String, CodingKey { case id, title, bytes, installed, bundled, installing, langs, families, progress, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func value<T: Decodable>(_ key: Keys) -> T? { (try? c.decodeIfPresent(T.self, forKey: key)) ?? nil }
        id = try c.decode(String.self, forKey: .id)
        title = value(.title) ?? CoreLabels(en: id)
        bytes = value(.bytes) ?? 0
        installed = value(.installed) ?? false
        bundled = value(.bundled) ?? false
        installing = value(.installing) ?? false
        langs = value(.langs) ?? []
        families = value(.families) ?? []
        progress = value(.progress)
        error = value(.error)
    }
}

/// `fonts.status`: every JIZURA font pack, the bundled base included.
public struct CoreFontsStatus: Codable, Equatable, Sendable {
    public let offline: Bool
    public let packs: [CoreFontPack]

    public init(offline: Bool, packs: [CoreFontPack]) { self.offline = offline; self.packs = packs }

    private enum Keys: String, CodingKey { case offline, packs }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        offline = ((try? c.decodeIfPresent(Bool.self, forKey: .offline)) ?? nil) ?? false
        packs = try c.decode([CoreFontPack].self, forKey: .packs)
    }

    /// The packs downloaded on demand (the bundled base is not one).
    public var downloadable: [CoreFontPack] { packs.filter { !$0.bundled } }
    public var anyInstalling: Bool { packs.contains { $0.installing } }
    public func pack(_ id: String) -> CoreFontPack? { packs.first { $0.id == id } }
}

public enum FontPackSize {
    /// Whole decimal megabytes, as download sizes are usually given: "69 MB".
    public static func text(_ bytes: Double) -> String {
        "\(max(1, Int((bytes / 1_000_000).rounded()))) MB"
    }
}

/// The packs the user asked to download, until each is installed, fails or
/// is cancelled. A download dies with Core (the app restarts Core after some
/// timeouts and every cancel); Core keeps the partial file, so asking again
/// resumes it. `reconcile` says when to ask.
public struct FontPackRequests: Equatable, Sendable {
    /// Asking this many times in a row without Core reporting the download
    /// running is a failure, not a loop.
    public static let maxAttempts = 3

    public struct Failure: Equatable, Sendable {
        public let id: String
        /// Core's error code ("offline", "network", "checksum", …), or "not-started" / "unknown-pack".
        public let code: String
        /// Core's message, when it gave one.
        public let message: String?
        public init(id: String, code: String, message: String? = nil) { self.id = id; self.code = code; self.message = message }
    }

    /// What a fresh `fonts.status` means for the requests.
    public struct Step: Equatable, Sendable {
        /// Send `fonts.install` for these now.
        public var install: [String] = []
        public var finished: [String] = []
        public var failed: [Failure] = []
    }

    private struct Entry: Equatable, Sendable {
        let id: String
        /// `fonts.install` was sent for this request.
        var issued = false
        /// Installs sent since Core last reported the download running.
        var attempts = 0
    }

    private var entries: [Entry] = []

    public init() {}

    public var requested: [String] { entries.map(\.id) }
    public var isActive: Bool { !entries.isEmpty }
    public func contains(_ id: String) -> Bool { entries.contains { $0.id == id } }

    /// The user pressed Download (again: a failed pack starts over).
    public mutating func request(_ id: String) {
        guard !contains(id) else { return }
        entries.append(Entry(id: id))
    }

    /// Cancelled, removed, or failed outside `reconcile`: stop asking for it.
    public mutating func drop(_ id: String) { entries.removeAll { $0.id == id } }

    public mutating func reconcile(_ status: CoreFontsStatus) -> Step {
        var step = Step()
        var kept: [Entry] = []
        for var entry in entries {
            guard let pack = status.pack(entry.id) else {
                step.failed.append(Failure(id: entry.id, code: "unknown-pack")); continue
            }
            if pack.installed { step.finished.append(entry.id); continue }
            if pack.installing {
                entry.issued = true; entry.attempts = 0
                kept.append(entry); continue
            }
            if status.offline {
                step.failed.append(Failure(id: entry.id, code: "offline", message: pack.error?.message)); continue
            }
            // An error left from before this request is not this request's failure.
            if entry.issued, let error = pack.error {
                step.failed.append(Failure(id: entry.id, code: error.code, message: error.message)); continue
            }
            // Never started, or Core restarted and forgot it: ask (again).
            if entry.attempts >= Self.maxAttempts {
                step.failed.append(Failure(id: entry.id, code: "not-started")); continue
            }
            entry.issued = true
            entry.attempts += 1
            step.install.append(entry.id)
            kept.append(entry)
        }
        entries = kept
        return step
    }
}

public enum FontPackPolling {
    /// About twice a second.
    public static let interval: TimeInterval = 0.5

    /// While a download the user started is unfinished, or while one is
    /// running and something that shows it is on screen.
    public static func shouldPoll(requested: Bool, installing: Bool, visible: Bool) -> Bool {
        requested || (installing && visible)
    }
}
