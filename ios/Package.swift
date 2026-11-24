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
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
    ],
    targets: [
        .target(name: "PapertownCore"),
        .target(
            name: "PapertownUI",
            dependencies: ["PapertownCore", .product(name: "MarkdownUI", package: "swift-markdown-ui")],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "PapertownCoreTests", dependencies: ["PapertownCore"]),
        .testTarget(name: "PapertownUITests", dependencies: ["PapertownUI", "PapertownCore"]),
    ]
)
