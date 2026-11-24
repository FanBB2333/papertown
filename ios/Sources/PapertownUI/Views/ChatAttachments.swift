import Foundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// Photos and files that go with a message: prepared on the device, then uploaded and named in the message by the server.
enum ChatFiles {
    static let maxBytes = 25 * 1024 * 1024
    static let maxFiles = 10

    /// A photo as a JPEG at most 2048 pixels on its longer side, the right way up: what an agent's CLI reads well.
    static func photo(_ data: Data, name: String) -> OutgoingFile? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let base = (name as NSString).deletingPathExtension
        return OutgoingFile(name: (base.isEmpty ? "photo" : base) + ".jpg", type: "image/jpeg", data: out as Data)
    }

    /// A file picked from Files, as it is; an image among them is prepared like a photo.
    static func file(at url: URL) throws -> OutgoingFile {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        let type = UTType(filenameExtension: url.pathExtension)
        if type?.conforms(to: .image) == true, let photo = photo(data, name: url.lastPathComponent) { return photo }
        return OutgoingFile(name: url.lastPathComponent, type: type?.preferredMIMEType ?? "application/octet-stream", data: data)
    }

    static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }

    static func thumbnail(_ data: Data, side: Int = 160) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// The files a sent message names after its text (the server writes them as `附件：` and one `- 图片 path` or
    /// `- 文件 path` a line), split off so they show as tags rather than paths.
    static func split(_ text: String) -> (text: String, files: [(image: Bool, name: String)]) {
        guard let r = text.range(of: "附件：\n", options: .backwards) else { return (text, []) }
        let head = text[..<r.lowerBound]
        guard head.isEmpty || head.hasSuffix("\n\n") else { return (text, []) }
        var files: [(image: Bool, name: String)] = []
        for line in text[r.upperBound...].split(separator: "\n") {
            let image = line.hasPrefix("- 图片 ")
            guard image || line.hasPrefix("- 文件 ") else { return (text, []) }
            var name = String(line.dropFirst(5).split(separator: "/").last ?? "")
            if let stamp = name.range(of: #"^\d{8}-\d{6}-[0-9a-f]{6}-"#, options: .regularExpression) { name.removeSubrange(stamp) }
            files.append((image: image, name: name))
        }
        return (head.trimmingCharacters(in: .whitespacesAndNewlines), files)
    }
}

/// The files going with the draft, above the input row: photos as thumbnails, other files by name, each with a way out.
struct AttachmentStrip: View {
    let files: [OutgoingFile]
    let thumbs: [String: CGImage]
    let remove: (String) -> Void
    let removeLabel: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(files) { f in
                    ZStack(alignment: .topTrailing) {
                        if f.isImage, let thumb = thumbs[f.id] {
                            Image(decorative: thumb, scale: 1)
                                .resizable().scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.fill").font(.system(size: 20)).foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(f.name).font(.caption.weight(.medium)).lineLimit(1).truncationMode(.middle)
                                    Text(ChatFiles.size(f.data.count)).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 10)
                            .frame(maxWidth: 170, minHeight: 56, maxHeight: 56, alignment: .leading)
                            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                        }
                        Button { remove(f.id) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, Color.black.opacity(0.55))
                        }
                        .buttonStyle(.plain)
                        .offset(x: 6, y: -6)
                        .accessibilityLabel(removeLabel)
                    }
                    .padding(.top, 6)
                    .padding(.trailing, 6)
                }
            }
        }
    }
}

/// The files a message carries, under its text in the bubble.
struct AttachmentTags: View {
    let files: [(image: Bool, name: String)]

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            ForEach(Array(files.enumerated()), id: \.offset) { _, f in
                Label(f.name, systemImage: f.image ? "photo" : "doc")
                    .font(.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.white.opacity(0.18), in: Capsule())
            }
        }
    }
}

#if os(iOS)
/// The camera, for a photo to send.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}
#endif
