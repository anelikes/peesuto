//! Showing and hiding the three windows. The two panels pop out under the
//! tray icon (or at the top-right corner while the tray position is unknown)
//! and hide again on blur (`lib.rs`).

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_positioner::{Position, WindowExt};

pub const HISTORY: &str = "history";
pub const RESULT: &str = "result";
pub const SETTINGS: &str = "settings";

fn pop<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    if w.move_window_constrained(Position::TrayBottomCenter).is_err() {
        let _ = w.move_window(Position::TopRight);
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// The shortcut: open the history panel, or close it if it is already up.
pub fn toggle_history(app: &AppHandle) {
    let visible = app.get_webview_window(HISTORY).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    if visible {
        hide_history(app);
    } else {
        show_history(app);
    }
}

pub fn show_history(app: &AppHandle) {
    crate::paste::remember_frontmost(app);
    pop(app, HISTORY);
}

pub fn hide(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
}

pub fn hide_history(app: &AppHandle) {
    hide(app, HISTORY);
}

pub fn show_result(app: &AppHandle) {
    pop(app, RESULT);
}

pub fn show_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(SETTINGS) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn hide_history_cmd(app: AppHandle) {
    hide_history(&app);
}

#[tauri::command]
pub fn hide_result(app: AppHandle) {
    hide(&app, RESULT);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    show_settings(&app);
}
