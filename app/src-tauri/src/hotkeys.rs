//! The global shortcut opens the history panel. It is registered from Rust so
//! the webviews need no shortcut permission; the settings window changes it
//! through `apply_hotkey`.

use tauri::{plugin::TauriPlugin, AppHandle, Runtime, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::windows::toggle_history(app);
            }
        })
        .build()
}

/// Replace whatever is registered with `hotkey` (Tauri accelerator syntax, e.g. `CmdOrCtrl+Shift+V`).
pub fn register<R: Runtime>(app: &AppHandle<R>, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.register(hotkey).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    register(&app, &hotkey)?;
    crate::tray::set_hotkey_label(&app, &hotkey);
    Ok(())
}

/// `CmdOrCtrl+Shift+V` → `⌘⇧V`, for menu labels.
pub fn mac_symbols(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "cmd" | "command" | "super" | "meta" => "⌘".to_string(),
            "ctrl" | "control" => "⌃".to_string(),
            "alt" | "option" => "⌥".to_string(),
            "shift" => "⇧".to_string(),
            "space" => "␣".to_string(),
            "enter" | "return" => "↩".to_string(),
            "escape" | "esc" => "⎋".to_string(),
            "backspace" => "⌫".to_string(),
            "delete" => "⌦".to_string(),
            "tab" => "⇥".to_string(),
            "up" | "arrowup" => "↑".to_string(),
            "down" | "arrowdown" => "↓".to_string(),
            "left" | "arrowleft" => "←".to_string(),
            "right" | "arrowright" => "→".to_string(),
            _ => part.trim().to_ascii_uppercase(),
        })
        .collect()
}
