//! Where the user is about to paste: the focused UI element, read through
//! the Accessibility API when the paste hotkey fires and before the panel
//! takes focus. The result is Core's `Context` (core/src/pick/types.ts),
//! graded by how much could be read:
//!
//! * level 0 — only the frontmost app (Accessibility not trusted, or no
//!   focused element);
//! * level 1 — plus the element's role and a label (title, description or
//!   placeholder) and the window title;
//! * level 2 — plus up to `CONTEXT_CHARS` of text before and after the
//!   caret, for text roles that expose a value and a selection range.
//!
//! A secure field (`AXSecureTextField` role or subrole) is reported with
//! `secure: true` and nothing else read from it, and the shell never runs a
//! pick there: the panel opens as plain history with a one-line note.
//! Nothing captured here is stored; it lives in `Current` until the next
//! capture.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::pasteboard;

pub const CONTEXT_CHARS: usize = 200;

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub level: u8,
    pub app_bundle_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secure: Option<bool>,
}

/// What the hotkey captured for the panel that is about to open.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub context: Context,
    /// Run the pick. False on a secure field, with smart paste off, or from the tray.
    pub smart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub trusted: bool,
    pub captured_at: i64,
    /// Milliseconds the capture took.
    pub ms: u64,
}

#[derive(Default)]
pub struct Current(pub Mutex<Option<Session>>);

const SECURE_ROLE: &str = "AXSecureTextField";

fn frontmost_only() -> Context {
    let front = pasteboard::frontmost_app();
    Context {
        level: 0,
        app_bundle_id: front.as_ref().and_then(|f| f.bundle_id.clone()).unwrap_or_default(),
        app_name: front.and_then(|f| f.name),
        ..Default::default()
    }
}

/// Read the focused element now. Blocking; a hung app is bounded by the AX messaging timeout.
pub fn capture() -> Context {
    if !crate::paste::accessibility_trusted() {
        return frontmost_only();
    }
    #[cfg(target_os = "macos")]
    {
        macos::capture().unwrap_or_else(frontmost_only)
    }
    #[cfg(not(target_os = "macos"))]
    {
        frontmost_only()
    }
}

/// Capture for a panel that is about to open, remember it, and say whether to pick.
pub fn begin(app: &AppHandle, smart_requested: bool) -> Session {
    let t0 = std::time::Instant::now();
    let trusted = crate::paste::accessibility_trusted();
    let context = capture();
    let secure = context.secure == Some(true);
    let (smart, note) = if secure {
        (false, Some("Secure field: smart paste stays off here.".to_string()))
    } else if !smart_requested {
        (false, None)
    } else if !trusted {
        (true, Some("Accessibility is off: picking from the app name only.".to_string()))
    } else {
        (true, None)
    };
    let session = Session { context, smart, note, trusted, captured_at: crate::clipboard::now_ms(), ms: t0.elapsed().as_millis() as u64 };
    if let Ok(mut c) = app.state::<Current>().0.lock() {
        *c = Some(session.clone());
    }
    session
}

/// The last capture, without the caret text (it is only for the pick request).
pub fn last(app: &AppHandle) -> Option<Session> {
    app.state::<Current>().0.lock().ok().and_then(|c| c.clone())
}

/// Take a string's `n` last (or first) characters.
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

fn head_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `before`/`after` from a value and a UTF-16 selection range.
pub fn around_caret(value: &str, location: usize, length: usize) -> (String, String) {
    let units: Vec<u16> = value.encode_utf16().collect();
    let loc = location.min(units.len());
    let end = loc.saturating_add(length).min(units.len());
    let before = String::from_utf16_lossy(&units[..loc]);
    let after = String::from_utf16_lossy(&units[end..]);
    (tail_chars(&before, CONTEXT_CHARS), head_chars(&after, CONTEXT_CHARS))
}

// ---- commands ----

/// What the panel that just opened should do.
#[tauri::command]
pub fn pick_session(app: AppHandle) -> Option<Session> {
    last(&app)
}

/// Settings → Accessibility: what can be seen right now (the settings window itself, usually).
#[tauri::command]
pub async fn context_probe() -> Context {
    tauri::async_runtime::spawn_blocking(capture).await.unwrap_or_else(|_| frontmost_only())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{around_caret, Context, SECURE_ROLE};
    use core_foundation::{
        base::{CFGetTypeID, CFRelease, CFTypeID, CFTypeRef, TCFType},
        string::{CFString, CFStringRef},
    };
    use std::ffi::c_void;

    type AXUIElementRef = *const c_void;
    type AXValueRef = *const c_void;
    type AXError = i32;
    const K_AX_ERROR_SUCCESS: AXError = 0;
    /// kAXValueTypeCFRange
    const K_AX_VALUE_CFRANGE_TYPE: u32 = 4;
    /// Seconds a single AX request may take before it is abandoned.
    const MESSAGING_TIMEOUT: f32 = 0.35;

    #[repr(C)]
    #[derive(Default)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
        fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
        fn AXUIElementGetTypeID() -> CFTypeID;
        fn AXValueGetTypeID() -> CFTypeID;
        fn AXValueGetValue(value: AXValueRef, value_type: u32, out: *mut c_void) -> bool;
    }

    /// An owned AXUIElement (released on drop).
    struct Elem(AXUIElementRef);

    impl Drop for Elem {
        fn drop(&mut self) {
            // SAFETY: created with a +1 reference by an AX*Create/Copy call.
            unsafe { CFRelease(self.0) }
        }
    }

    impl Elem {
        /// The raw attribute value with a +1 reference, or None.
        fn raw(&self, attr: &str) -> Option<CFTypeRef> {
            let name = CFString::new(attr);
            let mut out: CFTypeRef = std::ptr::null();
            // SAFETY: `name` lives for the call; `out` receives an owned reference on success.
            let err = unsafe { AXUIElementCopyAttributeValue(self.0, name.as_concrete_TypeRef(), &mut out) };
            if err != K_AX_ERROR_SUCCESS || out.is_null() {
                return None;
            }
            Some(out)
        }

        fn string(&self, attr: &str) -> Option<String> {
            let raw = self.raw(attr)?;
            // SAFETY: `raw` is a live CF object we own.
            unsafe {
                if CFGetTypeID(raw) == CFString::type_id() {
                    let s = CFString::wrap_under_create_rule(raw as CFStringRef).to_string();
                    Some(s)
                } else {
                    CFRelease(raw);
                    None
                }
            }
        }

        fn element(&self, attr: &str) -> Option<Elem> {
            let raw = self.raw(attr)?;
            // SAFETY: as above.
            unsafe {
                if CFGetTypeID(raw) == AXUIElementGetTypeID() {
                    Some(Elem(raw))
                } else {
                    CFRelease(raw);
                    None
                }
            }
        }

        fn range(&self, attr: &str) -> Option<(usize, usize)> {
            let raw = self.raw(attr)?;
            let mut r = CFRange::default();
            // SAFETY: `raw` is checked to be an AXValue before it is read as one.
            let ok = unsafe {
                let is_value = CFGetTypeID(raw) == AXValueGetTypeID();
                let ok = is_value && AXValueGetValue(raw, K_AX_VALUE_CFRANGE_TYPE, &mut r as *mut CFRange as *mut c_void);
                CFRelease(raw);
                ok
            };
            if !ok || r.location < 0 || r.length < 0 {
                return None;
            }
            Some((r.location as usize, r.length as usize))
        }

        fn pid(&self) -> Option<i32> {
            let mut pid = 0i32;
            // SAFETY: plain out-parameter call.
            (unsafe { AXUIElementGetPid(self.0, &mut pid) } == K_AX_ERROR_SUCCESS && pid > 0).then_some(pid)
        }
    }

    fn non_empty(s: Option<String>) -> Option<String> {
        s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    /// Containers whose AXValue is not the text being edited; everything else may be asked.
    const NON_TEXT_ROLES: &[&str] = &["AXWebArea", "AXGroup", "AXScrollArea", "AXWindow", "AXApplication", "AXSplitGroup", "AXToolbar"];

    pub fn capture() -> Option<Context> {
        // SAFETY: system-wide element, owned by us.
        let system = unsafe {
            let s = AXUIElementCreateSystemWide();
            if s.is_null() {
                return None;
            }
            AXUIElementSetMessagingTimeout(s, MESSAGING_TIMEOUT);
            Elem(s)
        };
        let app = system.element("AXFocusedApplication")?;
        let pid = app.pid();
        let front = pid.and_then(crate::pasteboard::app_for_pid).or_else(crate::pasteboard::frontmost_app);
        let mut ctx = Context {
            level: 0,
            app_bundle_id: front.as_ref().and_then(|f| f.bundle_id.clone()).unwrap_or_default(),
            app_name: front.and_then(|f| f.name),
            ..Default::default()
        };
        ctx.window_title = app.element("AXFocusedWindow").and_then(|w| non_empty(w.string("AXTitle")));
        let Some(el) = app.element("AXFocusedUIElement") else { return Some(ctx) };
        ctx.role = non_empty(el.string("AXRole"));
        ctx.subrole = non_empty(el.string("AXSubrole"));
        if ctx.role.is_some() {
            ctx.level = 1;
        }
        if ctx.role.as_deref() == Some(SECURE_ROLE) || ctx.subrole.as_deref() == Some(SECURE_ROLE) {
            ctx.secure = Some(true);
            return Some(ctx);
        }
        ctx.label = non_empty(el.string("AXTitle"))
            .or_else(|| non_empty(el.string("AXDescription")))
            .or_else(|| non_empty(el.string("AXPlaceholderValue")));
        let textual = ctx.role.as_deref().map(|r| !NON_TEXT_ROLES.contains(&r)).unwrap_or(false);
        if textual {
            if let Some((loc, len)) = el.range("AXSelectedTextRange") {
                if let Some(value) = el.string("AXValue") {
                    let (before, after) = around_caret(&value, loc, len);
                    ctx.before = Some(before);
                    ctx.after = Some(after);
                    ctx.level = 2;
                }
            }
        }
        Some(ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caret_windows() {
        let (b, a) = around_caret("hello world", 5, 0);
        assert_eq!((b.as_str(), a.as_str()), ("hello", " world"));
        let (b, a) = around_caret("héllo wörld", 6, 1);
        assert_eq!((b.as_str(), a.as_str()), ("héllo ", "örld"));
        let long = "x".repeat(1000);
        let (b, a) = around_caret(&long, 500, 0);
        assert_eq!(b.chars().count(), CONTEXT_CHARS);
        assert_eq!(a.chars().count(), CONTEXT_CHARS);
        // Out-of-range locations clamp instead of panicking.
        let (b, a) = around_caret("ab", 10, 10);
        assert_eq!((b.as_str(), a.as_str()), ("ab", ""));
        // Astral characters are two UTF-16 units.
        let (b, a) = around_caret("a😀b", 3, 0);
        assert_eq!((b.as_str(), a.as_str()), ("a😀", "b"));
    }

    #[test]
    fn context_serialises_like_core() {
        let c = Context { level: 2, app_bundle_id: "com.apple.Notes".into(), role: Some("AXTextArea".into()), before: Some("hi ".into()), ..Default::default() };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["appBundleId"], "com.apple.Notes");
        assert_eq!(v["level"], 2);
        assert!(v.get("secure").is_none());
        assert!(v.get("after").is_none());
    }
}
