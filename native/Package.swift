// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "PeesutoNative",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "PeesutoCoreHost", targets: ["PeesutoCoreHost"]), .executable(name: "Peesuto", targets: ["Peesuto"]), .executable(name: "PeesutoSmoke", targets: ["PeesutoSmoke"]), .executable(name: "PeesutoEncoder", targets: ["PeesutoEncoder"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.0")],
    targets: [
        .executableTarget(name: "PeesutoCoreHost"),
        // MP4 without ffmpeg: RGBA frames on stdin → H.264 via AVFoundation/VideoToolbox. Core spawns it.
        .executableTarget(name: "PeesutoEncoder"),
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
        .target(name: "PeesutoKit", dependencies: ["CSQLite"]),
        // Sparkle.framework is embedded in Contents/Frameworks by scripts/build-native.ts.
        .executableTarget(name: "Peesuto", dependencies: ["PeesutoKit", .product(name: "Sparkle", package: "Sparkle")],
                          linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .executableTarget(name: "PeesutoSmoke", dependencies: ["PeesutoKit"]),
        .testTarget(name: "PeesutoKitTests", dependencies: ["PeesutoKit"])
    ]
)
