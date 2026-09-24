// PeesutoEncoder: raw RGBA frames on stdin → an H.264 MP4, with AVFoundation
// and the VideoToolbox (hardware) encoder. Core spawns it for every MP4, so
// video works without ffmpeg.
//
//   PeesutoEncoder --width 1080 --height 1080 --fps 30 --out card.mp4 [--quality 0.8] [--bitrate <bit/s>]
//
// stdin carries width × height × 4 bytes per frame (RGBA, straight alpha,
// alpha ignored: cards are opaque) until EOF. On success one JSON line goes to
// stdout ({"ok":true,"frames":N,…}) and the exit status is 0; anything else
// is a failure with the reason on stderr and no file at --out.
//
// The output matches what the ffmpeg path made (libx264, yuv420p): H.264 High,
// 4:2:0, the composition's size and frame rate, moov at the front
// (shouldOptimizeForNetworkUse), no audio. Colour: the frames are sRGB. They
// are converted here — not by VideoToolbox — to BT.709 limited-range Y'CbCr
// with vImage, and tagged BT.709 primaries/matrix with the sRGB transfer
// (falling back to the BT.709 transfer where the writer refuses it), so a
// player that honours the tags shows the PNG render's colours: measured within
// ±2 per channel through AVFoundation. ffmpeg's rgba → yuv420p used BT.601
// coefficients and left the stream untagged, which AVFoundation decodes as
// BT.709 (saturated red 230,40,40 showed as 246,67,42; mid-grey 128 as 139).

import Accelerate
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

struct Options {
    var width = 0, height = 0, fps = 30
    var out = ""
    /// VideoToolbox constant quality, 0...1. Used where supported (Apple silicon).
    var quality = 0.8
    /// Average bit rate instead of constant quality (bit/s); 0 = automatic.
    var bitrate = 0
}

/// Set once the writer exists: a failure leaves no partial movie behind.
var cleanup: (() -> Void)?

func fail(_ message: String, code: Int32 = 1) -> Never {
    cleanup?()
    FileHandle.standardError.write(("PeesutoEncoder: " + message + "\n").data(using: .utf8)!)
    exit(code)
}

func parse() -> Options {
    var o = Options()
    var args = CommandLine.arguments.dropFirst()
    func value(_ name: String) -> String {
        guard let v = args.popFirst() else { fail("\(name) needs a value", code: 64) }
        return v
    }
    while let arg = args.popFirst() {
        switch arg {
        case "--width": o.width = Int(value(arg)) ?? 0
        case "--height": o.height = Int(value(arg)) ?? 0
        case "--fps": o.fps = Int(value(arg)) ?? 0
        case "--out": o.out = value(arg)
        case "--quality": o.quality = Double(value(arg)) ?? -1
        case "--bitrate": o.bitrate = Int(value(arg)) ?? -1
        case "--version":
            print("PeesutoEncoder 1 (AVFoundation H.264)")
            exit(0)
        default: fail("unknown argument \(arg)", code: 64)
        }
    }
    guard o.width >= 2, o.height >= 2, o.width <= 8192, o.height <= 8192 else { fail("--width and --height must be 2...8192", code: 64) }
    guard (1...240).contains(o.fps) else { fail("--fps must be 1...240", code: 64) }
    guard !o.out.isEmpty else { fail("--out is required", code: 64) }
    guard (0...1).contains(o.quality), o.bitrate >= 0 else { fail("--quality is 0...1, --bitrate ≥ 0", code: 64) }
    return o
}

/// Reads exactly `count` bytes; false at a clean EOF before the first byte.
func readFrame(into buffer: UnsafeMutableRawPointer, count: Int) -> Bool {
    var got = 0
    while got < count {
        let n = read(0, buffer + got, count - got)
        if n == 0 {
            if got == 0 { return false }
            fail("stdin ended inside a frame (\(got) of \(count) bytes)")
        }
        if n < 0 {
            if errno == EINTR { continue }
            fail("reading stdin: \(String(cString: strerror(errno)))")
        }
        got += n
    }
    return true
}

let o = parse()
let started = Date()
// H.264 4:2:0 needs even dimensions; an odd edge repeats its last row/column.
let outWidth = (o.width + 1) & ~1, outHeight = (o.height + 1) & ~1
let url = URL(fileURLWithPath: o.out)
try? FileManager.default.removeItem(at: url)

let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: url, fileType: .mp4) } catch { fail("cannot write \(o.out): \(error.localizedDescription)") }
writer.shouldOptimizeForNetworkUse = true // moov before mdat ("faststart")
cleanup = {
    if writer.status == .writing { writer.cancelWriting() }
    try? FileManager.default.removeItem(at: url)
    removeLeftovers()
}

/// BT.709 primaries and matrix. Transfer: sRGB (IEC 61966-2-1) when the writer
/// takes it — the frames ARE sRGB, and a player that honours the tag (AVFoundation,
/// browsers) then shows the PNG's exact tones instead of lifting mid-greys the
/// way BT.709-tagged video is shown — else BT.709.
func colour(srgb: Bool) -> [String: Any] {
    [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
     AVVideoTransferFunctionKey: srgb ? kCVImageBufferTransferFunction_sRGB as String : AVVideoTransferFunction_ITU_R_709_2,
     AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2]
}
func settings(quality: Bool, srgb: Bool) -> [String: Any] {
    var compression: [String: Any] = [
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
        AVVideoExpectedSourceFrameRateKey: o.fps,
        AVVideoMaxKeyFrameIntervalKey: o.fps * 4,
        AVVideoAllowFrameReorderingKey: true,
    ]
    if quality { compression[AVVideoQualityKey] = o.quality }
    else {
        // ≈ 0.12 bit per pixel: 1080×1080 at 30 fps ≈ 4.2 Mbit/s. Cards are flat colour and type.
        compression[AVVideoAverageBitRateKey] = o.bitrate > 0 ? o.bitrate : Int(Double(outWidth * outHeight * o.fps) * 0.12)
    }
    return [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outWidth,
        AVVideoHeightKey: outHeight,
        AVVideoColorPropertiesKey: colour(srgb: srgb),
        AVVideoCompressionPropertiesKey: compression,
        AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true],
    ]
}
// Constant quality when VideoToolbox offers it (Apple silicon) and no bit rate was asked for.
let useQuality = o.bitrate == 0 && writer.canApply(outputSettings: settings(quality: true, srgb: false), forMediaType: .video)
let srgbTransfer = writer.canApply(outputSettings: settings(quality: useQuality, srgb: true), forMediaType: .video)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings(quality: useQuality, srgb: srgbTransfer))
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    kCVPixelBufferWidthKey as String: outWidth,
    kCVPixelBufferHeightKey as String: outHeight,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
])
guard writer.canAdd(input) else { fail("the H.264 encoder rejected \(outWidth)×\(outHeight) at \(o.fps) fps") }
writer.add(input)
guard writer.startWriting() else { fail("cannot start writing: \(writer.error?.localizedDescription ?? "unknown error")") }
writer.startSession(atSourceTime: .zero)

// sRGB → BT.709 limited range ("video range"), 8 bit.
var range = vImage_YpCbCrPixelRange(Yp_bias: 16, CbCr_bias: 128, YpRangeMax: 235, CbCrRangeMax: 240, YpMax: 235, YpMin: 16, CbCrMax: 240, CbCrMin: 16)
var conversion = vImage_ARGBToYpCbCr()
guard vImageConvert_ARGBToYpCbCr_GenerateConversion(kvImage_ARGBToYpCbCrMatrix_ITU_R_709_2, &range, &conversion, kvImageARGB8888, kvImage420Yp8_CbCr8, vImage_Flags(kvImageNoFlags)) == kvImageNoError else { fail("vImage conversion setup failed") }
var rgbaToArgb: [UInt8] = [3, 0, 1, 2]

let frameBytes = o.width * o.height * 4
let rowBytes = outWidth * 4
let frame = UnsafeMutableRawPointer.allocate(byteCount: outWidth * outHeight * 4, alignment: 64)
defer { frame.deallocate() }
var frames: Int64 = 0

func removeLeftovers() {
    let directory = url.deletingLastPathComponent()
    let prefix = url.lastPathComponent + ".sb-"
    for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] where name.hasPrefix(prefix) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
}

func pad() {
    // Spread the frame to the even row pitch, repeating the last column, then the last row.
    guard outWidth != o.width || outHeight != o.height else { return }
    let src = o.width * 4
    for y in stride(from: o.height - 1, through: 0, by: -1) {
        memmove(frame + y * rowBytes, frame + y * src, src)
        if outWidth != o.width { memcpy(frame + y * rowBytes + src, frame + y * rowBytes + src - 4, 4) }
    }
    if outHeight != o.height { memcpy(frame + (outHeight - 1) * rowBytes, frame + (o.height - 1) * rowBytes, rowBytes) }
}

while readFrame(into: frame, count: frameBytes) {
    pad()
    guard let pool = adaptor.pixelBufferPool else { fail("no pixel buffer pool: \(writer.error?.localizedDescription ?? "writer not ready")") }
    var pixelBuffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess, let buffer = pixelBuffer else { fail("cannot allocate a pixel buffer") }
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, srgbTransfer ? kCVImageBufferTransferFunction_sRGB : kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    CVPixelBufferLockBaseAddress(buffer, [])
    var src = vImage_Buffer(data: frame, height: vImagePixelCount(outHeight), width: vImagePixelCount(outWidth), rowBytes: rowBytes)
    var luma = vImage_Buffer(data: CVPixelBufferGetBaseAddressOfPlane(buffer, 0), height: vImagePixelCount(outHeight), width: vImagePixelCount(outWidth), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0))
    var chroma = vImage_Buffer(data: CVPixelBufferGetBaseAddressOfPlane(buffer, 1), height: vImagePixelCount(outHeight / 2), width: vImagePixelCount(outWidth / 2), rowBytes: CVPixelBufferGetBytesPerRowOfPlane(buffer, 1))
    let converted = vImageConvert_ARGB8888To420Yp8_CbCr8(&src, &luma, &chroma, &conversion, &rgbaToArgb, vImage_Flags(kvImageNoFlags))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    guard converted == kvImageNoError else { fail("vImage conversion failed (\(converted))") }
    while !input.isReadyForMoreMediaData {
        if writer.status == .failed { fail("encoding failed: \(writer.error?.localizedDescription ?? "unknown error")") }
        usleep(500)
    }
    guard adaptor.append(buffer, withPresentationTime: CMTime(value: frames, timescale: CMTimeScale(o.fps))) else {
        fail("encoding failed at frame \(frames): \(writer.error?.localizedDescription ?? "unknown error")")
    }
    frames += 1
}
guard frames > 0 else { fail("no frames on stdin") }

input.markAsFinished()
writer.endSession(atSourceTime: CMTime(value: frames, timescale: CMTimeScale(o.fps)))
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
// shouldOptimizeForNetworkUse writes the movie once, then rewrites it with the
// moov first; the first pass stays behind as "<name>.sb-<hex>-<random>" next to
// the output. Nothing else is named like that, so remove it.
removeLeftovers()
guard writer.status == .completed else {
    fail("finishing the MP4 failed: \(writer.error?.localizedDescription ?? "unknown error")")
}
let ms = Int(Date().timeIntervalSince(started) * 1000)
print(#"{"ok":true,"frames":\#(frames),"width":\#(outWidth),"height":\#(outHeight),"fps":\#(o.fps),"rateControl":"\#(useQuality ? "quality" : "bitrate")","transfer":"\#(srgbTransfer ? "srgb" : "bt709")","ms":\#(ms)}"#)
