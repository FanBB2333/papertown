// swift-tools-version:5.9
// The macOS app: a window round the town's web page, served by the Papertown server it starts
// (or finds already running). build.sh wraps the binary into Papertown.app.
import PackageDescription

let package = Package(
    name: "Papertown",
    platforms: [.macOS(.v14)],
    targets: [.executableTarget(name: "Papertown", path: "Sources/Papertown")]
)
