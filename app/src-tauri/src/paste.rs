//! Paste simulation: put content on the pasteboard, give focus back to the
//! app the user came from, and press ⌘V for them with a CGEvent. The key
//! event needs Accessibility permission (`AXIsProcessTrusted`); without it
//! the content still lands on the pasteboard and the caller is told so, so
//! the UI can show the onboarding note.

use serde::Serialize;
use std::{path::Path, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};

use crate::{clipboard::History, pasteboard, windows};

/// The app that was frontmost before one of our panels took focus.
#[derive(Default)]
pub struct Focus {
    previous: Mutex<Option<pasteboard::FrontApp>>,
}

/// Call before showing a panel: remembers where focus should return to.
/// (Compared by pid: a `tauri dev` binary is not a bundle and has no bundle id.)
pub fn remember_frontmost(app: &AppHandle) {
    let Some(front) = pasteboard::frontmost_app() else { return };
    if front.pid == std::process::id() as i32 {
        return;
    }
    if let Ok(mut p) = app.state::<Focus>().previous.lock() {
        *p = Some(front);
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PasteFailure {
    /// accessibility | pasteboard | event | missing
    pub kind: String,
    pub message: String,
}

fn fail(kind: &str, message: impl Into<String>) -> PasteFailure {
    PasteFailure { kind: kind.into(), message: message.into() }
}

pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::trusted(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Write with `write`, then — if Accessibility allows it — hide `panel`,
/// bring the previous app back and press ⌘V. Without Accessibility the
/// content is on the pasteboard, the panel stays up, and the caller gets an
/// `accessibility` failure to show its note for.
async fn deliver(app: AppHandle, panel: &'static str, write: impl FnOnce() -> bool + Send + 'static) -> Result<(), PasteFailure> {
    let previous = app.state::<Focus>().previous.lock().ok().and_then(|p| p.clone());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if !write() {
            return Err(fail("pasteboard", "Could not write to the pasteboard."));
        }
        if !accessibility_trusted() {
            return Err(fail(
                "accessibility",
                "It is on the clipboard, but pasting for you needs Accessibility access. Press ⌘V yourself, or allow Peesuto in System Settings → Privacy & Security → Accessibility.",
            ));
        }
        windows::hide(&app, panel);
        if let Some(prev) = previous {
            pasteboard::activate_pid(prev.pid);
        }
        // Let the previous app come to the front before the key event.
        std::thread::sleep(Duration::from_millis(120));
        #[cfg(target_os = "macos")]
        {
            macos::press_cmd_v()
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(fail("event", "Paste simulation is only implemented on macOS."))
        }
    })
    .await;
    outcome.unwrap_or_else(|e| Err(fail("event", e.to_string())))
}

#[tauri::command]
pub async fn paste_item(app: AppHandle, id: String) -> Result<(), PasteFailure> {
    let history = app.state::<History>();
    let item = history.get(&id).ok_or_else(|| fail("missing", "That item is no longer in the history."))?;
    if item.kind == "image" {
        let png = history.with(|s| s.image(&id)).flatten().ok_or_else(|| fail("missing", "The image file is gone."))?;
        return deliver(app, windows::HISTORY, move || pasteboard::write_png(&png)).await;
    }
    let text = item.text.clone().unwrap_or_default();
    if item.kind == "file" {
        let first = text.lines().next().unwrap_or("").to_string();
        return deliver(app, windows::HISTORY, move || pasteboard::write_file(Path::new(&first), None)).await;
    }
    deliver(app, windows::HISTORY, move || pasteboard::write_text(&text)).await
}

#[tauri::command]
pub async fn paste_text(app: AppHandle, text: String) -> Result<(), PasteFailure> {
    deliver(app, windows::HISTORY, move || pasteboard::write_text(&text)).await
}

#[tauri::command]
pub async fn paste_file(app: AppHandle, path: String) -> Result<(), PasteFailure> {
    let uti = if path.to_lowercase().ends_with(".gif") { Some("com.compuserve.gif") } else { None };
    deliver(app, windows::HISTORY, move || pasteboard::write_file(Path::new(&path), uti)).await
}

/// The result window's Paste: the card as image (png) or file (gif), then ⌘V.
#[tauri::command]
pub async fn paste_card(app: AppHandle, path: String, format: String) -> Result<(), PasteFailure> {
    let writer = app.clone();
    deliver(app, windows::RESULT, move || crate::actions::copy_to_clipboard(&writer, Path::new(&path), &format).is_ok()).await
}

#[tauri::command]
pub fn accessibility_status() -> bool {
    accessibility_trusted()
}

/// Ask macOS to show its permission prompt (and list us under Accessibility).
#[tauri::command]
pub fn accessibility_prompt() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::trusted(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{fail, PasteFailure};
    use core_foundation::{
        base::TCFType,
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::CFString,
    };
    use core_graphics::{
        event::{CGEvent, CGEventFlags, CGEventTapLocation},
        event_source::{CGEventSource, CGEventSourceStateID},
    };

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    }

    pub fn trusted(prompt: bool) -> bool {
        if !prompt {
            // SAFETY: plain C call without arguments.
            return unsafe { AXIsProcessTrusted() } != 0;
        }
        let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        // SAFETY: the dictionary outlives the call.
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
    }

    const KEY_V: u16 = 9; // kVK_ANSI_V

    pub fn press_cmd_v() -> Result<(), PasteFailure> {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| fail("event", "Could not create an event source."))?;
        let down = CGEvent::new_keyboard_event(source.clone(), KEY_V, true)
            .map_err(|_| fail("event", "Could not create the key-down event."))?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        let up = CGEvent::new_keyboard_event(source, KEY_V, false)
            .map_err(|_| fail("event", "Could not create the key-up event."))?;
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        up.post(CGEventTapLocation::HID);
        Ok(())
    }
}
