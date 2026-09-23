import Foundation
import Darwin

/// The most recent Core stderr lines, kept only in memory for diagnostics.
/// Lines are truncated so an unexpected dump cannot grow without bound; this
/// buffer is never written to disk or to the system log.
public final class CoreLogRing: @unchecked Sendable {
    public let capacity: Int
    public let maxLineLength: Int
    private let lock = NSLock()
    private var lines: [String] = []
    private var partial = Data()
    private var discarding = false

    public init(capacity: Int = 20, maxLineLength: Int = 300) {
        self.capacity = max(1, capacity); self.maxLineLength = max(1, maxLineLength)
    }

    public func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        partial.append(chunk)
        while let newline = partial.firstIndex(of: 0x0a) {
            let line = Data(partial[partial.startIndex..<newline])
            partial.removeSubrange(partial.startIndex...newline)
            if discarding { discarding = false } else { push(line) }
        }
        // A very long line without a newline: keep its head, drop the rest.
        if partial.count > maxLineLength * 4 {
            if !discarding { push(partial) }
            partial.removeAll(); discarding = true
        }
    }

    public func append(line: String) { lock.lock(); defer { lock.unlock() }; push(Data(line.utf8)) }

    /// Flushes a trailing line that ended without a newline (e.g. at EOF).
    public func finish() {
        lock.lock(); defer { lock.unlock() }
        if !discarding { push(partial) }
        partial.removeAll(); discarding = false
    }

    public var snapshot: [String] { lock.lock(); defer { lock.unlock() }; return lines }

    private func push(_ data: Data) {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        lines.append(text.count > maxLineLength ? String(text.prefix(maxLineLength)) + "…" : text)
        if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
    }
}

/// The desktop owns credentials. Configuration is retained only in memory and
/// reapplied after every restart. Requests are never replayed after a failure.
public actor CoreClient {
    private struct Pending {
        let continuation: CheckedContinuation<Data, Error>
        let timeout: Task<Void, Never>
        let onState: (@Sendable (CoreTaskState) -> Void)?
    }

    private let executable: URL
    private let daemon: URL
    private let resources: URL?
    private let appData: URL
    private let startupTimeout: TimeInterval
    private let requestTimeout: TimeInterval
    private var configuration: [String: Any] = [
        "decider": ["kind": "rules"], "generator": ["kind": "none"], "offline": false
    ]
    private var process: Process?
    private var input: FileHandle?
    private var pending: [Int: Pending] = [:]
    private var nextID = 1
    private var generation = 0
    private var startup: (id: UUID, task: Task<Void, Error>)?
    private var configured = false
    private var ownsProcessGroup = false
    /// Bumped by every `configure`; `appliedRevision` is what Core has.
    private var configurationRevision = 0
    private var appliedRevision = -1
    private var lastProviders: CoreProviders?
    /// Outstanding run-action request ids. While any is in flight the
    /// sequential daemon is busy, so configuration is deferred until idle.
    private var actionRequests: Set<Int> = []
    private let writerQueue = DispatchQueue(label: "com.peesuto.core.stdin", qos: .utility)
    /// Recent Core stderr, in memory only. See `recentDiagnostics`.
    public nonisolated let log = CoreLogRing()

    public init(executable: URL, daemon: URL, resources: URL? = nil, appData: URL,
                startupTimeout: TimeInterval = 150, requestTimeout: TimeInterval = 180) {
        self.executable = executable; self.daemon = daemon; self.resources = resources
        self.appData = appData; self.startupTimeout = startupTimeout
        self.requestTimeout = requestTimeout
    }

    deinit {
        if let process, process.isRunning {
            if ownsProcessGroup, process.processIdentifier > 1 { kill(-process.processIdentifier, SIGKILL) }
            else { process.terminate() }
        }
        try? input?.close()
        for item in pending.values {
            item.timeout.cancel()
            item.continuation.resume(throwing: CancellationError())
        }
    }

    public func health() async throws -> CoreHealth {
        try await request(["cmd": "health"])
    }

    public func actions(reload: Bool = false) async throws -> CoreActionList {
        try await request(["cmd": reload ? "actions.reload" : "actions.list"])
    }

    /// Recent Core stderr lines (at most 20, each at most 300 characters).
    public nonisolated var recentDiagnostics: [String] { log.snapshot }

    /// `secrets` is a dictionary keyed by the existing Keychain reference names.
    /// Never write this dictionary to a preferences file or diagnostic log.
    ///
    /// Returns nil when an action is running: the daemon is sequential, so a
    /// `config.set` would wait behind the render and its timeout would tear
    /// Core down. The configuration is applied as soon as Core is idle, and
    /// always before the next request is sent.
    @discardableResult
    public func configure(_ configuration: [String: Any]) async throws -> CoreProviders? {
        guard JSONSerialization.isValidJSONObject(configuration) else {
            throw CoreError(kind: "input", message: "Invalid Core configuration.")
        }
        self.configuration = configuration
        configurationRevision += 1
        let revision = configurationRevision
        if !actionRequests.isEmpty, process?.isRunning == true { return nil }
        try await ensureStarted()
        // A cold start already sent this exact configuration.
        if appliedRevision >= revision, let lastProviders { return lastProviders }
        if !actionRequests.isEmpty { return nil }
        return try await applyConfiguration()
    }

    private func applyConfiguration() async throws -> CoreProviders {
        appliedRevision = configurationRevision
        var body = configuration
        body["cmd"] = "config.set"
        let data = try await send(body, timeout: startupTimeout)
        struct Response: Decodable { let providers: CoreProviders }
        guard let providers = try? JSONDecoder().decode(Response.self, from: data).providers else {
            throw CoreError(kind: "protocol", message: "Core returned an incompatible response.")
        }
        lastProviders = providers
        return providers
    }

    private func applyDeferredConfigurationIfIdle() async {
        guard actionRequests.isEmpty, configured, appliedRevision < configurationRevision,
              process?.isRunning == true else { return }
        _ = try? await applyConfiguration()
    }

    /// Render deadlines: Core stops png/gif renders after 240 s and mp4 after
    /// 600 s, so the shell waits somewhat longer than Core itself.
    public static func actionTimeout(output: String?) -> TimeInterval? {
        switch output {
        case "video", "mp4": return 720
        case "image", "png", "gif": return 300
        default: return nil
        }
    }

    public static func actionTimeout(actionID: String) -> TimeInterval? {
        switch actionID {
        case "paste-video": return actionTimeout(output: "video")
        case "paste-card": return actionTimeout(output: "image")
        case "paste-gif": return actionTimeout(output: "gif")
        default: return nil
        }
    }

    public func pick(context: CoreContext, candidates: [CoreClipItem], fresh: Bool = false) async throws -> CorePickResult {
        struct Response: Decodable { let result: CorePickResult }
        let result: Response = try await request([
            "cmd": "pick", "context": try object(context),
            "candidates": try object(candidates), "fresh": fresh
        ], timeout: min(requestTimeout, 10))
        return result.result
    }

    /// `timeout` defaults to the render deadline for built-in media actions
    /// and to the client's request timeout otherwise.
    public func runAction(action: String, input: CoreActionInput, candidates: [CoreClipItem]? = nil,
                          timeout: TimeInterval? = nil,
                          onState: (@Sendable (CoreTaskState) -> Void)? = nil) async throws -> CoreActionResponse {
        var body: [String: Any] = ["cmd": "run-action", "action": action, "input": try object(input)]
        if let candidates { body["candidates"] = try object(candidates) }
        if onState != nil { body["events"] = true }
        return try await request(body, timeout: timeout ?? Self.actionTimeout(actionID: action), onState: onState)
    }

    public func templates() async throws -> CoreTemplateList {
        try await request(["cmd": "templates.list"])
    }

    /// No cancellation command exists in the current protocol. Stopping Core
    /// fails outstanding callers; subsequent requests start a fresh process.
    public func shutdown() async {
        startup?.task.cancel()
        startup = nil
        stop(error: CancellationError())
    }

    private func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private func request<T: Decodable>(_ body: [String: Any], timeout: TimeInterval? = nil,
                                       onState: (@Sendable (CoreTaskState) -> Void)? = nil) async throws -> T {
        try Task.checkCancellation()
        try await ensureStarted()
        if actionRequests.isEmpty, appliedRevision < configurationRevision { _ = try await applyConfiguration() }
        let data = try await send(body, timeout: timeout ?? requestTimeout, onState: onState)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw CoreError(kind: "protocol", message: "Core returned an incompatible response.") }
    }

    private func ensureStarted() async throws {
        if let startup { return try await startup.task.value }
        if configured, process?.isRunning == true { return }
        let task = Task { try await boot() }
        let id = UUID()
        startup = (id, task)
        do { try await task.value; if startup?.id == id { startup = nil } }
        catch { if startup?.id == id { startup = nil }; throw error }
    }

    private func boot() async throws {
        stop(error: CoreError(kind: "sidecar", message: "Core restarted."))
        let token = generation
        try FileManager.default.createDirectory(at: appData, withIntermediateDirectories: true)
        let child = Process()
        let host = executable.deletingLastPathComponent().appendingPathComponent("PeesutoCoreHost")
        ownsProcessGroup = FileManager.default.isExecutableFile(atPath: host.path)
        if resources != nil, !ownsProcessGroup {
            throw CoreError(kind: "sidecar", message: "The bundled Core launcher is missing.")
        }
        child.executableURL = ownsProcessGroup ? host : executable
        child.currentDirectoryURL = appData
        child.arguments = [daemon.path, "--app-data", appData.path, "--idle-minutes", "10"]
        if let resources { child.arguments! += ["--engine-resources", resources.path] }
        if ownsProcessGroup { child.arguments!.insert(executable.path, at: 0) }
        // Ensure the daemon owns the process we launched instead of reexecuting
        // through a wrapper because its bundled executable is named `paste`.
        let bin = appData.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let bun = bin.appendingPathComponent("bun")
        if let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: bun.path) {
            if destination != executable.path {
                try FileManager.default.removeItem(at: bun)
                try FileManager.default.createSymbolicLink(at: bun, withDestinationURL: executable)
            }
        } else {
            // Do not overwrite an unexpected regular file at a managed path.
            try FileManager.default.createSymbolicLink(at: bun, withDestinationURL: executable)
        }
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = bin.path + ":" + (environment["PATH"] ?? "/usr/bin:/bin")
        child.environment = environment
        // Credentials travel only through config.set, never argv/environment.
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        child.standardInput = stdin; child.standardOutput = stdout; child.standardError = stderr
        // Render workers inherit stdout, so EOF alone may never arrive after
        // the daemon dies. A short grace lets already-written lines drain.
        child.terminationHandler = { [weak self] _ in
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 200_000_000)
                await self?.exited(generation: token)
            }
        }
        process = child
        input = stdin.fileHandleForWriting
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        do {
            _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                register(id: 0, continuation: continuation, timeout: startupTimeout, generation: token)
                do {
                    try child.run()
                    Self.readOutput(stdout.fileHandleForReading, client: self, generation: token)
                    Self.drain(stderr.fileHandleForReading, into: log)
                } catch {
                    stop(error: CoreError(kind: "sidecar", message: "Could not start Core."))
                }
            }
            try Task.checkCancellation()
            _ = try await applyConfiguration()
            guard generation == token, process?.isRunning == true else { throw CancellationError() }
            configured = true
        } catch {
            if generation == token { stop(error: error) }
            throw error
        }
    }

    private func send(_ body: [String: Any], timeout: TimeInterval,
                      onState: (@Sendable (CoreTaskState) -> Void)? = nil) async throws -> Data {
        try Task.checkCancellation()
        guard let input, process?.isRunning == true else {
            throw CoreError(kind: "sidecar", message: "Core is not running.")
        }
        let id = nextID
        nextID += 1
        let token = generation
        var envelope = body
        envelope["id"] = id
        var data = try JSONSerialization.data(withJSONObject: envelope)
        data.append(0x0a)
        if body["cmd"] as? String == "run-action" { actionRequests.insert(id) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                register(id: id, continuation: continuation, timeout: timeout, generation: token, onState: onState)
                // Pipe writes can block while Core is rendering. Keep them off
                // the actor so response handling and timeouts remain runnable.
                let payload = data
                writerQueue.async { [weak self] in
                    do { try input.write(contentsOf: payload) }
                    catch { Task { await self?.writeFailed(generation: token) } }
                }
            }
        } onCancel: {
            Task { await self.cancel(id: id, generation: token) }
        }
    }

    private func register(id: Int, continuation: CheckedContinuation<Data, Error>, timeout: TimeInterval, generation: Int,
                          onState: (@Sendable (CoreTaskState) -> Void)? = nil) {
        let task = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0.001, timeout) * 1_000_000_000)) }
            catch { return }
            await self?.expired(id: id, generation: generation)
        }
        pending[id] = Pending(continuation: continuation, timeout: task, onState: onState)
    }

    private func cancel(id: Int, generation: Int) {
        guard self.generation == generation, pending[id] != nil else { return }
        stop(error: CancellationError())
    }

    private func writeFailed(generation: Int) {
        guard self.generation == generation else { return }
        stop(error: CoreError(kind: "sidecar", message: "Could not write to Core."))
    }

    private func expired(id: Int, generation: Int) {
        guard self.generation == generation, pending[id] != nil else { return }
        // The daemon is sequential: abandoning just one request could leave
        // subsequent work behind a hung action. Never silently retry that work.
        stop(error: CoreError(kind: "timeout", message: "Core did not answer in time.", diagnostics: log.snapshot))
    }

    private func receive(_ data: Data, generation: Int) {
        guard self.generation == generation, process != nil else { return }
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = body["id"] as? Int else {
            stop(error: CoreError(kind: "protocol", message: "Core returned an invalid response."))
            return
        }
        if body["event"] != nil {
            // Events cannot consume a response continuation or reset its
            // timeout. Unknown future states are ignored for compatibility.
            if body["event"] as? String == "task", body["cmd"] as? String == "run-action",
               let raw = body["state"] as? String, let state = CoreTaskState(rawValue: raw) {
                pending[id]?.onState?(state)
            }
            return
        }
        guard let ok = body["ok"] as? Bool else {
            stop(error: CoreError(kind: "protocol", message: "Core returned an invalid response."))
            return
        }
        if id == 0, body["cmd"] as? String != "ready" { return }
        if id == -1 {
            // Usage errors for a line the daemon could not attribute. It
            // answers in order, so the oldest outstanding request is the one
            // it rejected; failing it keeps that caller from hanging.
            guard !ok, let oldest = pending.keys.filter({ $0 > 0 }).min(),
                  let item = pending.removeValue(forKey: oldest) else { return }
            item.timeout.cancel()
            finishedAction(oldest)
            item.continuation.resume(throwing: CoreError(
                kind: body["kind"] as? String ?? "usage",
                message: body["message"] as? String ?? "Core rejected the request."
            ))
            return
        }
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel()
        finishedAction(id)
        if ok { item.continuation.resume(returning: data) }
        else {
            item.continuation.resume(throwing: CoreError(
                kind: body["kind"] as? String ?? "error",
                message: body["message"] as? String ?? "Core could not complete the request."
            ))
        }
    }

    private func finishedAction(_ id: Int) {
        guard actionRequests.remove(id) != nil, actionRequests.isEmpty,
              appliedRevision < configurationRevision else { return }
        Task { await self.applyDeferredConfigurationIfIdle() }
    }

    private func exited(generation: Int) {
        guard self.generation == generation else { return }
        stop(error: CoreError(kind: "sidecar", message: "Core exited before answering.", diagnostics: log.snapshot))
    }

    private func stop(error: Error) {
        generation += 1
        configured = false
        let old = process
        let grouped = ownsProcessGroup
        process = nil
        ownsProcessGroup = false
        let oldInput = input
        input = nil
        actionRequests.removeAll()
        // A process that never launched has pid 0; kill(-0) would signal our own group.
        if let old, old.processIdentifier > 1 {
            if grouped {
                // The dedicated launcher establishes a process group before
                // exec, so builds and render workers are stopped with Core.
                // Signal the group even when the leader already exited: its
                // render workers can outlive it.
                let group = old.processIdentifier
                if kill(-group, SIGTERM) != 0, old.isRunning { old.terminate() }
                Task.detached(priority: .utility) {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    // ESRCH when the whole group is already gone.
                    kill(-group, SIGKILL)
                }
            } else if old.isRunning { old.terminate() }
        }
        writerQueue.async { try? oldInput?.close() }
        let callers = pending.values
        pending.removeAll()
        for item in callers {
            item.timeout.cancel()
            item.continuation.resume(throwing: error)
        }
    }

    private enum OutputEvent: Sendable { case line(Data), end }

    /// Blocking pipe reads run on a dedicated dispatch queue rather than the
    /// cooperative pool; a single consumer delivers lines to the actor in order.
    private nonisolated static func readOutput(_ handle: FileHandle, client: CoreClient, generation: Int) {
        var sink: AsyncStream<OutputEvent>.Continuation!
        let stream = AsyncStream<OutputEvent>(bufferingPolicy: .unbounded) { sink = $0 }
        let output = sink!
        DispatchQueue(label: "com.peesuto.core.stdout.\(generation)", qos: .utility).async {
            defer { try? handle.close(); output.yield(.end); output.finish() }
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { return }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0a) {
                    let line = Data(buffer[buffer.startIndex..<newline])
                    buffer.removeSubrange(buffer.startIndex...newline)
                    if !line.isEmpty { output.yield(.line(line)) }
                }
                if buffer.count > 16 * 1024 * 1024 { return }
            }
        }
        Task.detached(priority: .utility) { [weak client] in
            for await event in stream {
                switch event {
                case .line(let line): await client?.receive(line, generation: generation)
                case .end: await client?.exited(generation: generation); return
                }
            }
        }
    }

    private nonisolated static func drain(_ handle: FileHandle, into log: CoreLogRing) {
        // Provider failures may contain request content. Keep only a short,
        // truncated tail in memory for diagnostics; never persist or log it.
        DispatchQueue(label: "com.peesuto.core.stderr", qos: .utility).async {
            defer { try? handle.close(); log.finish() }
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { return }
                log.append(chunk)
            }
        }
    }
}
