import AppKit
import CoreGraphics

/// Pure geometry for pinned images ("pin to screen"). All rects are in
/// AppKit screen coordinates (origin bottom-left, points).
public enum PinGeometry {
    /// The initial pin fits within this fraction of the visible screen.
    public static let initialScreenFraction: CGFloat = 0.45
    /// Zooming never makes the short side smaller than this.
    public static let minimumShortSide: CGFloat = 64
    /// Zooming never exceeds this multiple of the natural size.
    public static let maximumZoom: CGFloat = 4

    /// Natural point size of a bitmap on a display with `scale` pixels per point.
    public static func naturalSize(pixelWidth: Int, pixelHeight: Int, scale: CGFloat) -> CGSize {
        let scale = scale > 0 ? scale : 2
        return CGSize(width: max(1, CGFloat(pixelWidth)) / scale, height: max(1, CGFloat(pixelHeight)) / scale)
    }

    /// Scales `size` down (never up) to fit within `bounds`, keeping its aspect ratio.
    public static func fit(_ size: CGSize, within bounds: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return size }
        let scale = min(1, bounds.width / size.width, bounds.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    /// Moves `frame` so it lies inside `visible`; a frame larger than `visible`
    /// is aligned to its top-left corner.
    public static func clamp(_ frame: CGRect, to visible: CGRect) -> CGRect {
        var result = frame
        if result.width >= visible.width { result.origin.x = visible.minX }
        else { result.origin.x = min(max(result.minX, visible.minX), visible.maxX - result.width) }
        if result.height >= visible.height { result.origin.y = visible.maxY - result.height }
        else { result.origin.y = min(max(result.minY, visible.minY), visible.maxY - result.height) }
        return result
    }

    /// The first frame of a pin: natural size fitted within 45% of the visible
    /// screen, centred on `center` (usually the mouse), kept on screen.
    public static func initialFrame(natural: CGSize, center: CGPoint, visibleFrame: CGRect) -> CGRect {
        let bounds = CGSize(width: visibleFrame.width * initialScreenFraction, height: visibleFrame.height * initialScreenFraction)
        let size = fit(natural, within: bounds)
        let frame = CGRect(x: (center.x - size.width / 2).rounded(), y: (center.y - size.height / 2).rounded(),
                           width: size.width.rounded(), height: size.height.rounded())
        return clamp(frame, to: visibleFrame)
    }

    /// Allowed scale range relative to the natural size: at least 64 pt on the
    /// short side, at most 400% of natural size and no larger than the screen.
    public static func scaleLimits(natural: CGSize, screen: CGSize) -> ClosedRange<CGFloat> {
        guard natural.width > 0, natural.height > 0 else { return 1...1 }
        let screenScale = min(screen.width / natural.width, screen.height / natural.height)
        let upper = max(min(maximumZoom, screenScale), 0.0001)
        let lower = min(minimumShortSide / min(natural.width, natural.height), upper)
        return lower...upper
    }

    /// Zooms `frame` by `factor` keeping the point under `anchor` fixed,
    /// with the resulting size clamped by `scaleLimits`.
    public static func zoom(frame: CGRect, by factor: CGFloat, anchor: CGPoint, natural: CGSize, screen: CGSize) -> CGRect {
        guard frame.width > 0, frame.height > 0, natural.width > 0, factor.isFinite, factor > 0 else { return frame }
        let limits = scaleLimits(natural: natural, screen: screen)
        let current = frame.width / natural.width
        let scale = min(max(current * factor, limits.lowerBound), limits.upperBound)
        let size = CGSize(width: natural.width * scale, height: natural.height * scale)
        // Keep the anchor at the same relative position; an anchor outside the
        // frame (should not happen) is treated as its nearest edge.
        let rx = min(max((anchor.x - frame.minX) / frame.width, 0), 1)
        let ry = min(max((anchor.y - frame.minY) / frame.height, 0), 1)
        let ax = frame.minX + rx * frame.width, ay = frame.minY + ry * frame.height
        return CGRect(x: ax - rx * size.width, y: ay - ry * size.height, width: size.width, height: size.height)
    }

    /// Smooth zoom factor for one scroll event: positive deltas zoom in.
    /// Trackpads report many small pixel deltas; mouse wheels report line steps.
    public static func scrollZoomFactor(deltaY: CGFloat, precise: Bool) -> CGFloat {
        let factor = exp(deltaY * (precise ? 0.006 : 0.08))
        return min(max(factor, 0.5), 2)
    }
}

/// An image read from the clipboard for pinning. `format` is "gif" for
/// animated GIF bytes and "png" otherwise (other formats are converted).
public struct PinImage: Equatable {
    public let data: Data
    public let format: String
    public init(data: Data, format: String) { self.data = data; self.format = format }

    public static let maximumBytes = 40 * 1024 * 1024
    public static let imageFileExtensions: Set<String> = ["png", "gif", "jpg", "jpeg", "tif", "tiff", "heic", "heif", "webp", "bmp"]
    public static func isImageFile(_ url: URL) -> Bool { url.isFileURL && imageFileExtensions.contains(url.pathExtension.lowercased()) }

    /// Pixel size of the (first frame of the) image.
    public var pixelSize: (width: Int, height: Int)? {
        guard let bitmap = NSBitmapImageRep(data: data), bitmap.pixelsWide > 0, bitmap.pixelsHigh > 0 else { return nil }
        return (bitmap.pixelsWide, bitmap.pixelsHigh)
    }

    /// GIF bytes are kept as-is (to animate); anything else becomes PNG.
    public static func from(data: Data, gif: Bool) -> PinImage? {
        guard !data.isEmpty, data.count <= maximumBytes else { return nil }
        if gif || data.starts(with: [0x47, 0x49, 0x46, 0x38]) { return NSBitmapImageRep(data: data) == nil ? nil : PinImage(data: data, format: "gif") }
        let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
        if data.starts(with: signature), NSBitmapImageRep(data: data) != nil { return PinImage(data: data, format: "png") }
        let bitmap = NSBitmapImageRep(data: data)
            ?? NSImage(data: data)?.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))
        guard let png = bitmap?.representation(using: .png, properties: [:]) else { return nil }
        return PinImage(data: png, format: "png")
    }

    public static func from(file url: URL) -> PinImage? {
        guard isImageFile(url),
              let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size <= maximumBytes,
              let data = try? Data(contentsOf: url) else { return nil }
        return from(data: data, gif: url.pathExtension.lowercased() == "gif")
    }

    /// Any image on the pasteboard: a file URL to an image, GIF, PNG or TIFF
    /// data. Peesuto's own writes count too. Concealed (password manager)
    /// content is never read.
    @MainActor
    public static func read(from board: NSPasteboard) -> PinImage? {
        let types = (board.types ?? []).map(\.rawValue)
        guard !types.contains("org.nspasteboard.ConcealedType") else { return nil }
        let urls = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !urls.isEmpty {
            // A copied file's TIFF is usually its Finder icon, not its content.
            return urls.lazy.compactMap(from(file:)).first
        }
        if let gif = board.data(forType: NSPasteboard.PasteboardType("com.compuserve.gif")), let image = from(data: gif, gif: true) { return image }
        if let png = board.data(forType: .png), let image = from(data: png, gif: false) { return image }
        if let tiff = board.data(forType: .tiff), let image = from(data: tiff, gif: false) { return image }
        return nil
    }
}

/// How a clipboard shortcut delivers its result.
public enum ClipboardShortcutDelivery: Equatable {
    /// Put the result on the clipboard and press ⌘V in the frontmost app.
    case paste
    /// Show the result in a floating pin window; never touches the clipboard or presses ⌘V.
    case pin

    public static func of(shortcut id: String) -> ClipboardShortcutDelivery {
        id == MediaShortcuts.pinID ? .pin : .paste
    }

    /// The Core action a shortcut renders text with (pin renders like paste-card).
    public static func renderAction(shortcut id: String) -> String {
        id == MediaShortcuts.pinID ? "paste-card" : id
    }
}
