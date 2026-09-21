//! Direct access to the general NSPasteboard and to the frontmost app: what
//! the history poller reads, what `paste.rs` and `card.rs` write. Everything
//! AppKit-specific is behind `cfg(target_os = "macos")`; other platforms get
//! inert stubs so the crate still builds.

use std::path::Path;

/// One reading of the pasteboard.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub change_count: i64,
    pub text: Option<String>,
    /// Raw UTIs present, e.g. `public.utf8-plain-text`, `public.rtf`, `public.file-url`.
    pub types: Vec<String>,
    pub file_paths: Vec<String>,
    /// PNG or TIFF bytes, read only when the pasteboard carries no text.
    pub image: Option<Vec<u8>>,
    /// `org.nspasteboard.ConcealedType`: password managers mark secrets with it.
    pub concealed: bool,
    /// `org.nspasteboard.TransientType`: not meant for history.
    pub transient: bool,
}

pub const CONCEALED: &str = "org.nspasteboard.ConcealedType";
pub const TRANSIENT: &str = "org.nspasteboard.TransientType";

#[derive(Clone, Debug)]
pub struct FrontApp {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub name: Option<String>,
}

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub use stub::*;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
        NSPasteboardTypeString, NSPasteboardTypeTIFF, NSPasteboardWriting, NSRunningApplication, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSData, NSString, NSURL};

    pub fn change_count() -> i64 {
        NSPasteboard::generalPasteboard().changeCount() as i64
    }

    pub fn snapshot() -> Snapshot {
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            let mut s = Snapshot { change_count: pb.changeCount() as i64, ..Default::default() };
            if let Some(types) = pb.types() {
                s.types = types.iter().map(|t| t.to_string()).collect();
            }
            s.concealed = s.types.iter().any(|t| t == CONCEALED);
            s.transient = s.types.iter().any(|t| t == TRANSIENT);
            // SAFETY: AppKit string constants.
            s.text = unsafe { pb.stringForType(NSPasteboardTypeString) }.map(|t| t.to_string());
            if s.types.iter().any(|t| t == "public.file-url") {
                if let Some(items) = pb.pasteboardItems() {
                    for item in items.iter() {
                        let url = unsafe { item.stringForType(NSPasteboardTypeFileURL) };
                        if let Some(path) = url.and_then(|u| NSURL::URLWithString(&u)).and_then(|u| u.path()) {
                            s.file_paths.push(path.to_string());
                        }
                    }
                }
            }
            let no_text = s.text.as_deref().map(str::trim).map(str::is_empty).unwrap_or(true);
            if no_text && s.file_paths.is_empty() && !s.concealed && !s.transient {
                // SAFETY: AppKit string constants; the data is copied out before the pool drains.
                let data = if s.types.iter().any(|t| t == "public.png") {
                    unsafe { pb.dataForType(NSPasteboardTypePNG) }
                } else if s.types.iter().any(|t| t == "public.tiff") {
                    unsafe { pb.dataForType(NSPasteboardTypeTIFF) }
                } else {
                    None
                };
                s.image = data.map(|d| d.to_vec());
            }
            s
        })
    }

    pub fn write_text(text: &str) -> bool {
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            unsafe { pb.setString_forType(&NSString::from_str(text), NSPasteboardTypeString) }
        })
    }

    pub fn write_png(bytes: &[u8]) -> bool {
        autoreleasepool(|_| {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            unsafe { pb.setData_forType(Some(&NSData::with_bytes(bytes)), NSPasteboardTypePNG) }
        })
    }

    /// One pasteboard item carrying a `public.file-url` and, optionally, the
    /// file's bytes under `extra_uti` for apps that take data directly.
    pub fn write_file(path: &Path, extra_uti: Option<&str>) -> bool {
        autoreleasepool(|_| {
            let Ok(abs) = std::fs::canonicalize(path) else { return false };
            let url = NSURL::fileURLWithPath(&NSString::from_str(&abs.to_string_lossy()));
            let Some(url_string) = url.absoluteString() else { return false };
            let item = NSPasteboardItem::new();
            let ok = unsafe { item.setString_forType(&url_string, NSPasteboardTypeFileURL) };
            if let Some(uti) = extra_uti {
                if let Ok(bytes) = std::fs::read(&abs) {
                    let _ = item.setData_forType(&NSData::with_bytes(&bytes), &NSString::from_str(uti));
                }
            }
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            let writing: Retained<ProtocolObject<dyn NSPasteboardWriting>> = ProtocolObject::from_retained(item);
            ok && pb.writeObjects(&NSArray::from_retained_slice(&[writing]))
        })
    }

    pub fn frontmost_app() -> Option<FrontApp> {
        autoreleasepool(|_| {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            Some(FrontApp {
                pid: app.processIdentifier(),
                bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
                name: app.localizedName().map(|s| s.to_string()),
            })
        })
    }

    pub fn app_for_pid(pid: i32) -> Option<FrontApp> {
        autoreleasepool(|_| {
            let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
            Some(FrontApp {
                pid,
                bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
                name: app.localizedName().map(|s| s.to_string()),
            })
        })
    }

    // The flag is a no-op since macOS 14 (cooperative activation), harmless before.
    #[allow(deprecated)]
    pub fn activate_pid(pid: i32) -> bool {
        autoreleasepool(|_| {
            let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else { return false };
            app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps)
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod stub {
    use super::*;
    pub fn change_count() -> i64 { 0 }
    pub fn snapshot() -> Snapshot { Snapshot::default() }
    pub fn write_text(_text: &str) -> bool { false }
    pub fn write_png(_bytes: &[u8]) -> bool { false }
    pub fn write_file(_path: &Path, _extra_uti: Option<&str>) -> bool { false }
    pub fn frontmost_app() -> Option<FrontApp> { None }
    pub fn app_for_pid(_pid: i32) -> Option<FrontApp> { None }
    pub fn activate_pid(_pid: i32) -> bool { false }
}
