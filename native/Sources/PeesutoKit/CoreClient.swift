import Foundation
import Darwin

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
    private let writerQueue = DispatchQueue(label: "com.peesuto.core.stdin", qos: .utility)

    public init(executable: URL, daemon: URL, resources: URL? = nil, appData: URL,
                startupTimeout: TimeInterval = 150, requestTimeout: TimeInterval = 180) {
        self.executable = executable; self.daemon = daemon; self.resources = resources
        self.appData = appData; self.startupTimeout = startupTimeout
        self.requestTimeout = requestTimeout
    }

    deinit {
        if let process, process.isRunning {
            if ownsProcessGroup { kill(-process.processIdentifier, SIGKILL) }
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

    /// `secrets` is a dictionary keyed by the existing Keychain reference names.
    /// Never write this dictionary to a preferences file or diagnostic log.
    @discardableResult
    public func configure(_ configuration: [String: Any]) async throws -> CoreProviders {
        guard JSONSerialization.isValidJSONObject(configuration) else {
            throw CoreError(kind: "input", message: "Invalid Core configuration.")
        }
        self.configuration = configuration
        try await ensureStarted()
        var body = configuration
        body["cmd"] = "config.set"
        let data = try await send(body, timeout: startupTimeout)
        struct Response: Decodable { let providers: CoreProviders }
        return try JSONDecoder().decode(Response.self, from: data).providers
    }

    public func pick(context: CoreContext, candidates: [CoreClipItem], fresh: Bool = false) async throws -> CorePickResult {
        struct Response: Decodable { let result: CorePickResult }
        let result: Response = try await request([
            "cmd": "pick", "context": try object(context),
            "candidates": try object(candidates), "fresh": fresh
        ], timeout: min(requestTimeout, 10))
        return result.result
    }

    public func runAction(action: String, input: CoreActionInput, candidates: [CoreClipItem]? = nil,
                          onState: (@Sendable (CoreTaskState) -> Void)? = nil) async throws -> CoreActionResponse {
        var body: [String: Any] = ["cmd": "run-action", "action": action, "input": try object(input)]
        if let candidates { body["candidates"] = try object(candidates) }
        if onState != nil { body["events"] = true }
        return try await request(body, onState: onState)
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
        process = child
        input = stdin.fileHandleForWriting
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
        do {
            _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                register(id: 0, continuation: continuation, timeout: startupTimeout, generation: token)
                do {
                    try child.run()
                    Self.readOutput(stdout.fileHandleForReading, client: self, generation: token)
                    Self.drain(stderr.fileHandleForReading)
                } catch {
                    stop(error: CoreError(kind: "sidecar", message: "Could not start Core."))
                }
            }
            try Task.checkCancellation()
            var body = configuration
            body["cmd"] = "config.set"
            _ = try await send(body, timeout: startupTimeout)
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
        stop(error: CoreError(kind: "timeout", message: "Core did not answer in time."))
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
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel()
        if ok { item.continuation.resume(returning: data) }
        else {
            item.continuation.resume(throwing: CoreError(
                kind: body["kind"] as? String ?? "error",
                message: body["message"] as? String ?? "Core could not complete the request."
            ))
        }
    }

    private func exited(generation: Int) {
        guard self.generation == generation else { return }
        stop(error: CoreError(kind: "sidecar", message: "Core exited before answering."))
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
        if let old, old.isRunning {
            if grouped {
                // The dedicated launcher establishes a process group before
                // exec, so builds and render workers are stopped with Core.
                if kill(-old.processIdentifier, SIGTERM) != 0 { old.terminate() }
                Task.detached(priority: .utility) {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    // Keeping a live leader check prevents signaling a reused
                    // process group after the original group has disappeared.
                    if old.isRunning { kill(-old.processIdentifier, SIGKILL) }
                }
            } else { old.terminate() }
        }
        writerQueue.async { try? oldInput?.close() }
        let callers = pending.values
        pending.removeAll()
        for item in callers {
            item.timeout.cancel()
            item.continuation.resume(throwing: error)
        }
    }

    private nonisolated static func readOutput(_ handle: FileHandle, client: CoreClient, generation: Int) {
        Task.detached(priority: .utility) { [weak client] in
            defer { try? handle.close() }
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0a) {
                    let line = Data(buffer[..<newline])
                    buffer.removeSubrange(...newline)
                    if !line.isEmpty { await client?.receive(line, generation: generation) }
                }
                if buffer.count > 16 * 1024 * 1024 {
                    await client?.exited(generation: generation)
                    return
                }
            }
            await client?.exited(generation: generation)
        }
    }

    private nonisolated static func drain(_ handle: FileHandle) {
        // Provider failures may contain request content. Drain stderr without
        // persisting it, rather than copying arbitrary engine output to logs.
        DispatchQueue.global(qos: .utility).async {
            defer { try? handle.close() }
            while !handle.availableData.isEmpty {}
        }
    }
}
