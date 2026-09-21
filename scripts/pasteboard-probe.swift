// Write test items to the general pasteboard for the privacy audit.
//
//   swift scripts/pasteboard-probe.swift plain "hello"          # ordinary text
//   swift scripts/pasteboard-probe.swift concealed "s3cret"     # org.nspasteboard.ConcealedType set
//   swift scripts/pasteboard-probe.swift transient "tmp"        # org.nspasteboard.TransientType set
//
// The app's poller must record only the first. Exit 0 on success.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else { fputs("usage: pasteboard-probe.swift plain|concealed|transient <text>\n", stderr); exit(2) }
let mode = args[1], text = args[2]
let pb = NSPasteboard.general
pb.clearContents()
let item = NSPasteboardItem()
item.setString(text, forType: .string)
switch mode {
case "plain": break
case "concealed": item.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
case "transient": item.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
default: fputs("unknown mode \(mode)\n", stderr); exit(2)
}
guard pb.writeObjects([item]) else { fputs("writeObjects failed\n", stderr); exit(1) }
print("\(mode) written, changeCount \(pb.changeCount), types \(pb.types?.map { $0.rawValue } ?? [])")
