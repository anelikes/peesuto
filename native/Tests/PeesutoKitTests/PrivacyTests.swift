import Foundation
import XCTest
@testable import PeesutoKit

final class PrivacyTests: XCTestCase {
    private func store() throws -> (SettingsStore, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-privacy-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return (try SettingsStore(directory: root), root)
    }

    func testConfigurationCarriesPrivacyAndPrecomposeDefaults() throws {
        let (settings, root) = try store()
        defer { try? FileManager.default.removeItem(at: root) }
        let config = try settings.coreConfiguration(secretReader: { _ in nil })
        let privacy = try XCTUnwrap(config["privacy"] as? [String: Any])
        XCTAssertEqual(privacy["modelContent"] as? String, "redacted")
        XCTAssertEqual((privacy["builtins"] as? [String: Bool])?.isEmpty, true)
        XCTAssertEqual((privacy["rules"] as? [Any])?.count, 0)
        let precompose = try XCTUnwrap(config["precompose"] as? [String: Any])
        XCTAssertEqual(precompose["outputs"] as? [String], ["image"], "fresh installs prepare images on copy")
        XCTAssertEqual(precompose["useModel"] as? Bool, false)
        XCTAssertEqual(precompose["skipSecrets"] as? Bool, true)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(config))
    }

    func testPrecomposeDefaultAppliesOnlyWhenTheKeyIsAbsent() throws {
        XCTAssertEqual(PrecomposeSettings(json: nil), PrecomposeSettings(outputs: ["image"], useModel: false, skipSecrets: true))
        XCTAssertEqual(PrecomposeSettings(json: ["outputs": [String](), "useModel": false]).outputs, [], "a saved empty value is kept")
        XCTAssertEqual(PrecomposeSettings(json: ["outputs": ["gif"], "useModel": true]), PrecomposeSettings(outputs: ["gif"], useModel: true))
        let (settings, root) = try store()
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(settings.precomposeSettings.outputs, ["image"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("settings.json").path),
                       "reading the default does not write settings.json")
        try settings.setValues(["precompose": ["outputs": [String](), "useModel": true, "skipSecrets": false]])
        let reopened = try SettingsStore(directory: root)
        XCTAssertEqual(reopened.precomposeSettings, PrecomposeSettings(outputs: [], useModel: true, skipSecrets: false))
        // The Shortcuts page and onboarding change outputs only.
        try reopened.setPrecomposeOutputs(["video", "image"])
        XCTAssertEqual(try SettingsStore(directory: root).precomposeSettings,
                       PrecomposeSettings(outputs: ["image", "video"], useModel: true, skipSecrets: false))
    }

    func testOnboardingShowsUntilTheCurrentVersionIsSeen() throws {
        XCTAssertTrue(Onboarding.shouldShow(savedVersion: nil))
        XCTAssertTrue(Onboarding.shouldShow(savedVersion: Onboarding.currentVersion - 1))
        XCTAssertFalse(Onboarding.shouldShow(savedVersion: Onboarding.currentVersion))
        XCTAssertFalse(Onboarding.shouldShow(savedVersion: Onboarding.currentVersion + 1))
        let (settings, root) = try store()
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertTrue(settings.shouldShowOnboarding)
        try settings.set("onboarding_version", value: 0)
        XCTAssertTrue(try SettingsStore(directory: root).shouldShowOnboarding)
        try settings.markOnboardingSeen()
        let reopened = try SettingsStore(directory: root)
        XCTAssertEqual(reopened.onboardingVersion, Onboarding.currentVersion)
        XCTAssertFalse(reopened.shouldShowOnboarding)
    }

    func testCustomRulesPersistAndEncodeForConfigSet() throws {
        let (settings, root) = try store()
        defer { try? FileManager.default.removeItem(at: root) }
        let rule = PrivacyRule(id: "r1", name: "Project", match: "keywords", pattern: "Falcon\nOsprey",
                               replacement: "[project]", caseSensitive: true, wholeWord: true, alsoInOutput: true, enabled: false)
        try settings.setPrivacy(PrivacySettings(modelContent: "structure", builtins: ["email": true, "jwt": false], rules: [rule]),
                                precompose: PrecomposeSettings(outputs: ["video", "image", "bogus"], useModel: true, skipSecrets: false))
        // Reads back from disk in a fresh store.
        let reopened = try SettingsStore(directory: root)
        XCTAssertEqual(reopened.privacySettings.rules, [rule])
        XCTAssertEqual(reopened.precomposeSettings.outputs, ["image", "video"])
        let config = try reopened.coreConfiguration(secretReader: { _ in nil })
        let privacy = try XCTUnwrap(config["privacy"] as? [String: Any])
        XCTAssertEqual(privacy["modelContent"] as? String, "structure")
        XCTAssertEqual(privacy["builtins"] as? [String: Bool], ["email": true, "jwt": false])
        let encoded = try XCTUnwrap((privacy["rules"] as? [[String: Any]])?.first)
        XCTAssertEqual(encoded["id"] as? String, "r1")
        XCTAssertEqual(encoded["name"] as? String, "Project")
        XCTAssertEqual(encoded["match"] as? String, "keywords")
        XCTAssertEqual(encoded["pattern"] as? String, "Falcon\nOsprey")
        XCTAssertEqual(encoded["replacement"] as? String, "[project]")
        XCTAssertEqual(encoded["caseSensitive"] as? Bool, true)
        XCTAssertEqual(encoded["wholeWord"] as? Bool, true)
        XCTAssertEqual(encoded["alsoInOutput"] as? Bool, true)
        XCTAssertEqual(encoded["enabled"] as? Bool, false)
        let precompose = try XCTUnwrap(config["precompose"] as? [String: Any])
        XCTAssertEqual(precompose["outputs"] as? [String], ["image", "video"])
        XCTAssertEqual(precompose["useModel"] as? Bool, true)
        XCTAssertEqual(precompose["skipSecrets"] as? Bool, false)
    }

    func testRuleDefaultsAndValidation() throws {
        let decoded = PrivacySettings(json: ["modelContent": "nonsense", "rules": [["id": "x", "pattern": "abc"], ["name": "no id"]]])
        XCTAssertEqual(decoded.modelContent, "redacted")
        XCTAssertEqual(decoded.rules.count, 1)
        let rule = try XCTUnwrap(decoded.rules.first)
        XCTAssertEqual(rule.match, "text")
        XCTAssertFalse(rule.caseSensitive); XCTAssertFalse(rule.wholeWord)
        XCTAssertFalse(rule.alsoInOutput); XCTAssertTrue(rule.enabled)
        XCTAssertNil(rule.problem)
        XCTAssertEqual(PrivacyRule(match: "regex", pattern: "([a-").problem, .invalidRegex)
        XCTAssertEqual(PrivacyRule(pattern: "  ").problem, .emptyPattern)
        XCTAssertEqual(PrivacyRule(pattern: String(repeating: "a", count: 501)).problem, .patternTooLong)
        XCTAssertEqual(PrivacyRule(pattern: "a", replacement: String(repeating: "b", count: 101)).problem, .replacementTooLong)
        XCTAssertTrue(PrivacySettings().isEnabled(builtin: "api-keys"))
        XCTAssertFalse(PrivacySettings().isEnabled(builtin: "email"))
        XCTAssertEqual(PrivacyBuiltins.fallback.count, 11)
    }

    func testPrecomposeFramesUseSavedDefaults() throws {
        let (settings, root) = try store()
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertEqual(settings.precomposeFrames, ["image": "auto", "gif": "1:1", "video": "1:1"])
        try settings.setFrames(["image": "4:5", "video": "9:16"])
        XCTAssertEqual(settings.precomposeFrames, ["image": "4:5", "gif": "1:1", "video": "9:16"])
    }
}

// MARK: - Scheduler

private struct FakePower: PowerStateProviding {
    var isLowPowerModeEnabled = false
    var thermalState: ProcessInfo.ThermalState = .nominal
}

private final class MutablePower: PowerStateProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var low = false
    var isLowPowerModeEnabled: Bool {
        get { lock.lock(); defer { lock.unlock() }; return low }
        set { lock.lock(); low = newValue; lock.unlock() }
    }
    var thermalState: ProcessInfo.ThermalState { .nominal }
}

/// A clock that only moves when the test advances it.
private final class ManualClock: PrecomposeClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: TimeInterval = 0
    private var waiters: [(id: UUID, deadline: TimeInterval, continuation: CheckedContinuation<Void, Error>)] = []

    var waiting: Int { lock.lock(); defer { lock.unlock() }; return waiters.count }

    func sleep(seconds: TimeInterval) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if Task.isCancelled { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                waiters.append((id, now + seconds, continuation))
                lock.unlock()
            }
        } onCancel: {
            lock.lock()
            let index = waiters.firstIndex { $0.id == id }
            let waiter = index.map { waiters.remove(at: $0) }
            lock.unlock()
            waiter?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by seconds: TimeInterval) {
        lock.lock()
        now += seconds
        let due = waiters.filter { $0.deadline <= now + 1e-9 }
        waiters.removeAll { $0.deadline <= now + 1e-9 }
        lock.unlock()
        for waiter in due { waiter.continuation.resume() }
    }
}

@MainActor final class PrecomposeSchedulerTests: XCTestCase {
    private var performed: [String] = []

    private func settle() async {
        for _ in 0..<50 { await Task.yield() }
    }
    private func waitForSleepers(_ clock: ManualClock, count: Int = 1) async {
        for _ in 0..<500 where clock.waiting < count { await Task.yield() }
    }

    func testSkipReasons() {
        let normal = FakePower()
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: "hi", outputs: [], power: normal), .off)
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: " \n", outputs: ["image"], power: normal), .empty)
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: "hi", outputs: ["image"], power: FakePower(isLowPowerModeEnabled: true)), .lowPower)
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: "hi", outputs: ["gif"], power: FakePower(thermalState: .serious)), .thermal)
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: "hi", outputs: ["gif"], power: FakePower(thermalState: .critical)), .thermal)
        XCTAssertNil(PrecomposeScheduler.skipReason(text: "hi", outputs: ["gif"], power: FakePower(thermalState: .fair)))
        XCTAssertEqual(PrecomposeScheduler.skipReason(text: "hi", outputs: ["gif"], power: normal, busy: true), .busy)
    }

    func testDebounceKeepsOnlyTheLatestCopy() async {
        let clock = ManualClock()
        let scheduler = PrecomposeScheduler(clock: clock, power: FakePower()) { [unowned self] in self.performed.append($0) }
        scheduler.schedule(text: "first", outputs: { ["image"] })
        await waitForSleepers(clock)
        clock.advance(by: 0.3)
        await settle()
        XCTAssertEqual(performed, [])
        // A newer copy resets the delay.
        scheduler.schedule(text: "second", outputs: { ["image"] })
        await settle()
        await waitForSleepers(clock)
        clock.advance(by: 0.3)
        await settle()
        XCTAssertEqual(performed, [], "0.3 s after the newer copy is still inside the delay")
        clock.advance(by: 0.2)
        await settle()
        XCTAssertEqual(performed, ["second"])
    }

    func testOffAndEmptyNeverWait() async {
        let clock = ManualClock()
        let scheduler = PrecomposeScheduler(clock: clock, power: FakePower()) { [unowned self] in self.performed.append($0) }
        scheduler.schedule(text: "hello", outputs: { [] })
        XCTAssertEqual(scheduler.lastSkip, .off)
        scheduler.schedule(text: "   ", outputs: { ["gif"] })
        XCTAssertEqual(scheduler.lastSkip, .empty)
        await settle()
        XCTAssertEqual(clock.waiting, 0)
        XCTAssertEqual(performed, [])
    }

    func testPowerStateAndBusyAreCheckedWhenTheDelayEnds() async {
        let clock = ManualClock()
        let power = MutablePower()
        var busy = false
        let scheduler = PrecomposeScheduler(clock: clock, power: power) { [unowned self] in self.performed.append($0) }
        scheduler.schedule(text: "a", outputs: { ["video"] }, busy: { busy })
        await waitForSleepers(clock)
        power.isLowPowerModeEnabled = true
        clock.advance(by: 0.5)
        await settle()
        XCTAssertEqual(performed, [])
        XCTAssertEqual(scheduler.lastSkip, .lowPower)

        power.isLowPowerModeEnabled = false
        busy = true
        scheduler.schedule(text: "b", outputs: { ["video"] }, busy: { busy })
        await waitForSleepers(clock)
        clock.advance(by: 0.5)
        await settle()
        XCTAssertEqual(scheduler.lastSkip, .busy)

        busy = false
        var outputs = ["video"]
        scheduler.schedule(text: "c", outputs: { outputs }, busy: { busy })
        await waitForSleepers(clock)
        outputs = []  // turned off in settings during the delay
        clock.advance(by: 0.5)
        await settle()
        XCTAssertEqual(scheduler.lastSkip, .off)
        XCTAssertEqual(performed, [])

        outputs = ["video"]
        scheduler.schedule(text: "d", outputs: { outputs }, busy: { busy })
        await waitForSleepers(clock)
        clock.advance(by: 0.5)
        await settle()
        XCTAssertEqual(performed, ["d"])
    }
}
