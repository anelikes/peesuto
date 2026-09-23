import Foundation
import Darwin
import XCTest
@testable import PeesutoKit

final class CoreClientTests: XCTestCase {
    func testMediaOverridesAndResultMetadataRoundTrip() async throws {
        let (client, root) = try fixture(behavior: """
        if cmd == 'templates.list':
            res['templates'] = [{'id':'chat', 'name':'Conversation', 'nameZh':'对话', 'variants':[{'id':'classic', 'name':'Bubbles', 'nameZh':'气泡'}], 'motions':['none','reveal','typewriter']}]
            emit(res)
            continue
        if cmd == 'run-action':
            assert req['input']['template'] == {'id':'chat', 'variant':'editorial', 'motion':'typewriter'}
            assert req['input']['templatePreferences'] == {'quote':'classic'}
            res['result'] = {'output':'gif','format':'gif','path':'/synthetic.gif','ms':12,'meta':{'template':{'id':'chat','variant':'editorial','motion':'typewriter','decisionSource':'override','availableTemplates':['chat','document']}}}
            emit(res)
            continue
        """)
        defer { try? FileManager.default.removeItem(at: root) }
        let catalog = try await client.templates()
        XCTAssertEqual(catalog.templates.first?.nameZh, "对话")
        let response = try await client.runAction(action: "paste-gif", input: CoreActionInput(text: "A: Hi\nB: Hello",
            template: CoreTemplateOptions(id: "chat", variant: "editorial", motion: "typewriter"), templatePreferences: ["quote": "classic"]))
        XCTAssertEqual(response.result.meta?.template?.availableTemplates, ["chat", "document"])
        XCTAssertEqual(response.result.meta?.template?.motion, "typewriter")
        await client.shutdown()
    }
    private final class StateRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var states: [CoreTaskState] = []
        func append(_ state: CoreTaskState) { lock.lock(); defer { lock.unlock() }; states.append(state) }
        var values: [CoreTaskState] { lock.lock(); defer { lock.unlock() }; return states }
    }
    private func fixture(behavior: String = "", timeout: TimeInterval = 2, grouped: Bool = false) throws -> (CoreClient, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-core-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("daemon.py")
        let source = """
        import json, sys, time
        def emit(body):
            print(json.dumps(body), flush=True)
        emit({'id': 0, 'ok': True, 'cmd': 'ready', 'version': 'fixture'})
        configured = False
        providers = None
        config_count = 0
        for line in sys.stdin:
            req = json.loads(line)
            cmd = req['cmd']
            res = {'id': req['id'], 'ok': True, 'cmd': cmd}
            if cmd == 'shutdown':
                break
            if cmd == 'config.set':
                configured = True
                config_count += 1
                providers = {'decider': req.get('decider', {}).get('kind', 'none'), 'generator': req.get('generator', {}).get('kind', 'none'), 'offline': req.get('offline', False)}
                res['providers'] = providers
                emit(res)
                continue
            if not configured:
                emit({'id': req['id'], 'ok': False, 'kind': 'ordering', 'message': 'Configuration missing'})
                continue
        \(behavior.split(separator: "\n", omittingEmptySubsequences: false).map { "    " + $0 }.joined(separator: "\n"))
            if cmd == 'health':
                res.update({'version': 'fixture', 'engine': None, 'providers': providers, 'uptimeMs': 1, 'packs': []})
            if cmd == 'actions.list' or cmd == 'actions.reload':
                res.update({'actions': [{'id': 'custom', 'name': 'Custom action', 'input': 'item', 'needs': 'none', 'output': 'text', 'builtin': False}], 'problems': []})
            if cmd == 'run-action':
                res['result'] = {'output': 'text', 'text': req['input']['text'], 'ms': 1}
            if cmd == 'pick':
                res['result'] = {'ranked': [{'item': item, 'score': 1, 'reason': 'fixture'} for item in req['candidates']], 'shouldPaste': 0.8, 'source': 'heuristic'}
            emit(res)
        """
        try source.write(to: script, atomically: true, encoding: .utf8)
        var executable = URL(fileURLWithPath: "/usr/bin/python3")
        if grouped {
            // Apple's /usr/bin/python3 is an xcrun shim that dispatches by
            // executable name, so keep this fixture's basename as python3.
            executable = root.appendingPathComponent("python3")
            try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: URL(fileURLWithPath: "/usr/bin/python3"))
            let hostSource = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/PeesutoCoreHost/main.c")
            let compiler = Process()
            compiler.executableURL = URL(fileURLWithPath: "/usr/bin/cc")
            compiler.arguments = [hostSource.path, "-o", root.appendingPathComponent("PeesutoCoreHost").path]
            try compiler.run()
            compiler.waitUntilExit()
            guard compiler.terminationStatus == 0 else { throw CoreError(kind: "fixture", message: "Could not compile test launcher.") }
        }
        let client = CoreClient(executable: executable, daemon: script,
                                appData: root, startupTimeout: 2, requestTimeout: timeout)
        return (client, root)
    }

    func testReadyConfigurationAndConcurrentResponseMatching() async throws {
        let (client, root) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let providers = try await client.configure([
            "decider": ["kind": "rules"], "generator": ["kind": "none"],
            "offline": true, "secrets": ["pocket-paste/generator": "synthetic-test-secret"]
        ])
        XCTAssertEqual(providers?.offline, true)
        async let health = client.health()
        async let actions = client.actions()
        let (h, a) = try await (health, actions)
        XCTAssertEqual(h.version, "fixture")
        XCTAssertEqual(h.providers.decider, "rules")
        XCTAssertEqual(a.actions.first?.id, "custom")
        XCTAssertEqual(a.actions.first?.builtin, false)
        let results = try await withThrowingTaskGroup(of: String.self) { group in
            for index in 0..<12 {
                group.addTask {
                    let result = try await client.runAction(action: "custom", input: CoreActionInput(text: "content-\(index)"))
                    return result.result.text ?? ""
                }
            }
            var values = Set<String>()
            for try await result in group { values.insert(result) }
            return values
        }
        XCTAssertEqual(results, Set((0..<12).map { "content-\($0)" }))
        await client.shutdown()
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), ["daemon.py", "bin"])
    }

    func testPickRoundTripsProtocolModels() async throws {
        let (client, root) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let item = CoreClipItem(id: "fixture", kind: "text", text: "hello", preview: "hello", createdAt: 123)
        let result = try await client.pick(context: CoreContext(appBundleId: "test.app"), candidates: [item])
        XCTAssertEqual(result.ranked.first?.item.text, "hello")
        XCTAssertEqual(result.shouldPaste, 0.8)
        await client.shutdown()
    }

    func testTaskLifecycleEventsDoNotConsumeTheFinalResponse() async throws {
        let behavior = """
        if cmd == 'run-action':
            if not req.get('events'):
                emit({'id': req['id'], 'ok': False, 'kind': 'fixture', 'message': 'Missing event opt-in'})
                continue
            emit({'id': req['id'] + 9000, 'event': 'task', 'cmd': cmd, 'state': 'failed'})
            for state in ['accepted', 'running', 'future-state', 'completed']:
                emit({'id': req['id'], 'event': 'task', 'cmd': cmd, 'state': state})
            time.sleep(0.03)
        """
        let (client, root) = try fixture(behavior: behavior)
        defer { try? FileManager.default.removeItem(at: root) }
        let states = StateRecorder()
        let response = try await client.runAction(action: "custom", input: CoreActionInput(text: "final content"), onState: { states.append($0) })
        XCTAssertEqual(response.result.text, "final content")
        XCTAssertEqual(states.values, [.accepted, .running, .completed])
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testFailedLifecycleRetainsTheActualErrorResponse() async throws {
        let behavior = """
        if cmd == 'run-action':
            for state in ['accepted', 'running', 'failed']:
                emit({'id': req['id'], 'event': 'task', 'cmd': cmd, 'state': state})
            emit({'id': req['id'], 'ok': False, 'cmd': cmd, 'kind': 'action:needs', 'message': 'Generator is unavailable'})
            continue
        """
        let (client, root) = try fixture(behavior: behavior)
        defer { try? FileManager.default.removeItem(at: root) }
        let states = StateRecorder()
        do {
            _ = try await client.runAction(action: "custom", input: CoreActionInput(text: "fixture"), onState: { states.append($0) })
            XCTFail("Expected action failure")
        } catch let error as CoreError { XCTAssertEqual(error.kind, "action:needs") }
        XCTAssertEqual(states.values, [.accepted, .running, .failed])
        await client.shutdown()
    }

    func testComposeErrorsCarryCodeAndCharacters() async throws {
        let behavior = """
        if cmd == 'run-action':
            emit({'id': req['id'], 'ok': False, 'cmd': cmd, 'kind': 'compose', 'code': 'unsupported-script', 'message': 'The font cannot draw U+2005.', 'characters': ['\\u2005', '\\u0bf5']})
            continue
        """
        let (client, root) = try fixture(behavior: behavior)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try await client.runAction(action: "paste-card", input: CoreActionInput(text: "fixture"))
            XCTFail("Expected compose failure")
        } catch let error as CoreError {
            XCTAssertEqual(error.kind, "compose")
            XCTAssertEqual(error.code, "unsupported-script")
            XCTAssertEqual(error.characterLabels, ["U+2005", "\u{0BF5} (U+0BF5)"])
        }
        await client.shutdown()
    }

    func testLegacyDaemonResponseWorksWithOptionalStateCallback() async throws {
        let (client, root) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let states = StateRecorder()
        let response = try await client.runAction(action: "custom", input: CoreActionInput(text: "legacy response"), onState: { states.append($0) })
        XCTAssertEqual(response.result.text, "legacy response")
        XCTAssertEqual(states.values, [])
        await client.shutdown()
    }

    func testLifecycleEventsCannotExtendRequestDeadline() async throws {
        let behavior = """
        if cmd == 'run-action':
            for _ in range(20):
                emit({'id': req['id'], 'event': 'task', 'cmd': cmd, 'state': 'running'})
                time.sleep(0.03)
        """
        let (client, root) = try fixture(behavior: behavior, timeout: 0.15)
        defer { try? FileManager.default.removeItem(at: root) }
        let states = StateRecorder()
        do {
            _ = try await client.runAction(action: "custom", input: CoreActionInput(text: "fixture"), onState: { states.append($0) })
            XCTFail("Expected timeout despite lifecycle activity")
        } catch let error as CoreError { XCTAssertEqual(error.kind, "timeout") }
        XCTAssertTrue(states.values.contains(.running))
        await client.shutdown()
    }

    func testTimeoutStopsProcessAndNextRequestRecovers() async throws {
        let (client, root) = try fixture(behavior: "if cmd == 'run-action':\n    time.sleep(10)", timeout: 0.1)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try await client.runAction(action: "slow", input: CoreActionInput(text: "fixture"))
            XCTFail("Expected timeout")
        } catch let error as CoreError { XCTAssertEqual(error.kind, "timeout") }
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testFullInputPipeDoesNotBlockTimeoutHandling() async throws {
        let (client, root) = try fixture(behavior: "if cmd == 'run-action':\n    time.sleep(10)", timeout: 0.2)
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try await client.health()
        let first = Task { try await client.runAction(action: "slow", input: CoreActionInput(text: "fixture")) }
        try await Task.sleep(nanoseconds: 20_000_000)
        let second = Task {
            try await client.runAction(action: "large", input: CoreActionInput(text: String(repeating: "x", count: 2_000_000)))
        }
        for task in [first, second] {
            do { _ = try await task.value; XCTFail("Expected interrupted request") }
            catch let error as CoreError { XCTAssertEqual(error.kind, "timeout") }
        }
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testCrashFailsActionWithoutReplayAndRestartsOnDemand() async throws {
        let (client, root) = try fixture(behavior: "if cmd == 'run-action':\n    sys.exit(7)")
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try await client.runAction(action: "crash", input: CoreActionInput(text: "fixture"))
            XCTFail("Expected exit error")
        } catch let error as CoreError { XCTAssertEqual(error.kind, "sidecar") }
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testCancellationFailsCallerAndAllowsRestart() async throws {
        let (client, root) = try fixture(behavior: "if cmd == 'run-action':\n    time.sleep(10)")
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try await client.health()
        let task = Task { try await client.runAction(action: "slow", input: CoreActionInput(text: "fixture")) }
        try await Task.sleep(nanoseconds: 100_000_000)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") }
        catch is CancellationError {}
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testMalformedOutputIsNotExposedInErrors() async throws {
        let (client, root) = try fixture(behavior: "print('synthetic-private-content', flush=True)\ncontinue")
        defer { try? FileManager.default.removeItem(at: root) }
        do { _ = try await client.health(); XCTFail("Expected protocol error") }
        catch let error as CoreError {
            XCTAssertEqual(error.kind, "protocol")
            XCTAssertFalse(error.message.contains("synthetic-private-content"))
        }
        await client.shutdown()
    }

    func testUnattributedUsageErrorFailsOldestRequest() async throws {
        let (client, root) = try fixture(behavior: "if cmd == 'run-action':\n    emit({'id': -1, 'ok': False, 'kind': 'usage', 'message': 'not JSON'})\n    continue", timeout: 10)
        defer { try? FileManager.default.removeItem(at: root) }
        let started = Date()
        do {
            _ = try await client.runAction(action: "custom", input: CoreActionInput(text: "fixture"))
            XCTFail("Expected usage error")
        } catch let error as CoreError { XCTAssertEqual(error.kind, "usage") }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        // The daemon survived; the next request is answered normally.
        let health = try await client.health()
        XCTAssertEqual(health.version, "fixture")
        await client.shutdown()
    }

    func testDaemonDeathFailsPendingEvenWhenWorkerHoldsStdout() async throws {
        let behavior = """
        if cmd == 'run-action':
            import os, subprocess
            worker = subprocess.Popen(['/bin/sleep', '30'])
            with open('worker.pid', 'w') as marker:
                marker.write(str(worker.pid))
            sys.stderr.write('synthetic failure detail\\n')
            sys.stderr.flush()
            os._exit(3)
        """
        let (client, root) = try fixture(behavior: behavior, timeout: 20)
        defer {
            if let text = try? String(contentsOf: root.appendingPathComponent("worker.pid")), let pid = pid_t(text) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: root)
        }
        let started = Date()
        do {
            _ = try await client.runAction(action: "custom", input: CoreActionInput(text: "fixture"))
            XCTFail("Expected exit error")
        } catch let error as CoreError {
            XCTAssertEqual(error.kind, "sidecar")
            XCTAssertEqual(error.diagnostics.last, "synthetic failure detail")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "Pending request waited for stdout EOF")
        XCTAssertEqual(client.recentDiagnostics.last, "synthetic failure detail")
        await client.shutdown()
    }

    func testStderrRingKeepsTruncatedTail() {
        let ring = CoreLogRing()
        ring.append(Data(String(repeating: "x", count: 500).utf8 + [0x0a]))
        for index in 0..<25 { ring.append(Data("line \(index)\n".utf8)) }
        ring.append(Data("partial".utf8))
        XCTAssertEqual(ring.snapshot.count, 20)
        XCTAssertEqual(ring.snapshot.first, "line 5")
        XCTAssertEqual(ring.snapshot.last, "line 24")
        ring.finish()
        XCTAssertEqual(ring.snapshot.last, "partial")
        let long = CoreLogRing(capacity: 3, maxLineLength: 300)
        long.append(Data(String(repeating: "y", count: 5_000).utf8))
        long.append(Data("tail of the long line\nnext\n".utf8))
        XCTAssertEqual(long.snapshot, [String(repeating: "y", count: 300) + "…", "next"])
    }

    func testRenderTimeoutsFollowOutputKind() {
        XCTAssertEqual(CoreClient.actionTimeout(actionID: "paste-card"), 300)
        XCTAssertEqual(CoreClient.actionTimeout(actionID: "paste-gif"), 300)
        XCTAssertEqual(CoreClient.actionTimeout(actionID: "paste-video"), 720)
        XCTAssertEqual(CoreClient.actionTimeout(output: "video"), 720)
        XCTAssertNil(CoreClient.actionTimeout(actionID: "paste-summary"))
    }

    func testConfigurationDuringActionIsDeferredNotTimedOut() async throws {
        let behavior = """
        if cmd == 'health':
            res.update({'version': str(config_count), 'engine': None, 'providers': providers, 'uptimeMs': 1, 'packs': []})
            emit(res)
            continue
        if cmd == 'run-action':
            time.sleep(0.6)
        """
        // startupTimeout (config.set) is 2 s; a queued config.set would still
        // be answered, so use a render longer than a short request timeout.
        let (client, root) = try fixture(behavior: behavior, timeout: 5)
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try await client.configure(["decider": ["kind": "rules"], "generator": ["kind": "none"], "offline": false])
        let first = try await client.health()
        XCTAssertEqual(first.version, "1", "Cold start must send config.set once")
        let action = Task { try await client.runAction(action: "custom", input: CoreActionInput(text: "rendering")) }
        try await Task.sleep(nanoseconds: 150_000_000)
        let started = Date()
        let deferred = try await client.configure(["decider": ["kind": "rules"], "generator": ["kind": "anthropic"], "offline": true])
        XCTAssertNil(deferred)
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.3)
        let result = try await action.value
        XCTAssertEqual(result.result.text, "rendering")
        let health = try await client.health()
        XCTAssertEqual(health.providers.generator, "anthropic")
        XCTAssertTrue(health.providers.offline)
        XCTAssertEqual(health.version, "2")
        await client.shutdown()
    }

    func testShutdownTerminatesRenderWorkerProcessGroup() async throws {
        try await assertRenderWorkerStops(cancel: false)
    }

    func testCancellationTerminatesRenderWorkerProcessGroup() async throws {
        try await assertRenderWorkerStops(cancel: true)
    }

    private func assertRenderWorkerStops(cancel: Bool) async throws {
        let behavior = """
        if cmd == 'run-action':
            import os, subprocess
            worker = subprocess.Popen(['/bin/sleep', '30'])
            with open('worker.json', 'w') as marker:
                json.dump({'worker': worker.pid, 'leader': os.getpid()}, marker)
            time.sleep(30)
        """
        let (client, root) = try fixture(behavior: behavior, timeout: 10, grouped: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let task = Task { try await client.runAction(action: "render", input: CoreActionInput(text: "fixture")) }
        let marker = root.appendingPathComponent("worker.json")
        var worker: pid_t = 0
        var leader: pid_t = 0
        for _ in 0..<100 {
            if let data = try? Data(contentsOf: marker),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: Int],
               let workerID = value["worker"], let leaderID = value["leader"] {
                worker = pid_t(workerID); leader = pid_t(leaderID)
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard worker > 0, leader > 0 else {
            await client.shutdown()
            _ = await task.result
            XCTFail("Render worker never started")
            return
        }
        defer {
            // Limit failure cleanup to the private group created by this test.
            if getpgid(worker) == leader { kill(worker, SIGKILL) }
        }
        XCTAssertNotEqual(leader, getpgrp())
        XCTAssertEqual(getpgid(worker), leader)
        if cancel { task.cancel() } else { await client.shutdown() }
        do { _ = try await task.value; XCTFail("Expected interrupted render") }
        catch is CancellationError {}
        for _ in 0..<100 {
            if kill(worker, 0) != 0, errno == ESRCH { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(kill(worker, 0), -1, "Render worker survived Core termination")
        XCTAssertEqual(errno, ESRCH)
        await client.shutdown()
    }
}
