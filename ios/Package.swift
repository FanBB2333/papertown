// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PapertownCore",
    defaultLocalization: "en",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "PapertownCore", targets: ["PapertownCore"]),
        .library(name: "PapertownUI", targets: ["PapertownUI"]),
    ],
    targets: [
        .target(name: "PapertownCore"),
        .target(
            name: "PapertownUI",
            dependencies: ["PapertownCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "PapertownCoreTests", dependencies: ["PapertownCore"]),
        .testTarget(name: "PapertownUITests", dependencies: ["PapertownUI", "PapertownCore"]),
    ]
)
