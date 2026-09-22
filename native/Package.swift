// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "PeesutoNative",
    platforms: [.macOS(.v12)],
    products: [.executable(name: "PeesutoCoreHost", targets: ["PeesutoCoreHost"]), .executable(name: "Peesuto", targets: ["Peesuto"]), .executable(name: "PeesutoSmoke", targets: ["PeesutoSmoke"])],
    targets: [
        .executableTarget(name: "PeesutoCoreHost"),
        .systemLibrary(name: "CSQLite", pkgConfig: "sqlite3"),
        .target(name: "PeesutoKit", dependencies: ["CSQLite"]),
        .executableTarget(name: "Peesuto", dependencies: ["PeesutoKit"]),
        .executableTarget(name: "PeesutoSmoke", dependencies: ["PeesutoKit"]),
        .testTarget(name: "PeesutoKitTests", dependencies: ["PeesutoKit"])
    ]
)
