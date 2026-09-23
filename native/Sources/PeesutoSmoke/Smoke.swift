import Foundation
import ImageIO
import PeesutoKit
import AVFoundation

@main struct Smoke {
    static func main() async throws {
        guard (2...3).contains(CommandLine.arguments.count) else {
            print("Usage: PeesutoSmoke /path/to/Peesuto.app [--video]")
            exit(2)
        }
        let app = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("peesuto-smoke-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let resources = app.appendingPathComponent("Contents/Resources/resources")
        let client = CoreClient(executable: app.appendingPathComponent("Contents/MacOS/paste"), daemon: resources.appendingPathComponent("core/daemon.ts"), resources: resources, appData: directory)
        do {
            let store = try HistoryStore(directory: directory, key: Data(repeating: 7, count: 32))
            try store.insert(text: "Native clipboard smoke test", sourceApp: "com.peesuto.test")
            guard try store.list().count == 1 else { throw SmokeError.failed("history") }
            _ = try await client.configure(["decider": ["kind": "rules"], "generator": ["kind": "none"], "offline": true])
            let health = try await client.health()
            guard health.engine != nil else { throw SmokeError.failed("engine unavailable") }
            let actions = try await client.actions()
            guard actions.actions.count >= 6 else { throw SmokeError.failed("actions") }
            let templates = try await client.templates()
            guard templates.templates.count >= 9, templates.templates.contains(where: { $0.id == "text" && $0.variants.contains(where: { $0.id == "poster" }) }), templates.templates.allSatisfy({ $0.variants.count >= 2 }) else { throw SmokeError.failed("template discovery") }
            let media = ["paste-card", "paste-gif"] + (CommandLine.arguments.contains("--video") ? ["paste-video"] : [])
            for action in media {
                let response = try await client.runAction(action: action, input: CoreActionInput(text: "[小林]：把时间留给表达。\n[阿澈]：让排版自动完成。", template: CoreTemplateOptions(motion: "typewriter")), onState: { state in
                    print("STATE \(action): \(state.rawValue)")
                })
                guard let path = response.result.path, FileManager.default.fileExists(atPath: path) else { throw SmokeError.failed(action) }
                guard response.result.meta?.template?.id == "chat",
                      response.result.meta?.template?.motion == (action == "paste-card" ? "none" : "typewriter") else { throw SmokeError.failed("template selection / output independence") }
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                let bytes = data.count
                if action == "paste-video" {
                    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
                    let playable = try await asset.load(.isPlayable)
                    let duration = try await asset.load(.duration)
                    let tracks = try await asset.loadTracks(withMediaType: .video)
                    guard response.result.format == "mp4", bytes > 100, playable,
                          duration.seconds > 0, !tracks.isEmpty else { throw SmokeError.failed("invalid video") }
                    print("PASS \(action): \(bytes) bytes, \(Int(response.result.ms)) ms")
                    continue
                }
                guard bytes > 100, let image = CGImageSourceCreateWithData(data as CFData, nil),
                      CGImageSourceCreateImageAtIndex(image, 0, nil) != nil else { throw SmokeError.failed("invalid image") }
                if action == "paste-gif", CGImageSourceGetCount(image) < 2 { throw SmokeError.failed("GIF is not animated") }
                print("PASS \(action): \(bytes) bytes, \(Int(response.result.ms)) ms")
            }
            await client.shutdown()
            print("PASS bundled Core, encrypted history, \(media.joined(separator: ", ")); output: \(directory.path)")
        } catch {
            await client.shutdown()
            throw error
        }
    }
    enum SmokeError: Error { case failed(String) }
}
