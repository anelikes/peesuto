//! Global shortcuts, registered from Rust so the webviews need no shortcut
//! permission: the history shortcut (smart paste) from Settings, and one per
//! action that declares `trigger.hotkey`. Conflicts — an action's key equal
//! to the history shortcut or to another action's, or one the system
//! refuses — are skipped and reported to Settings.

use tauri::{plugin::TauriPlugin, AppHandle, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::actions::{ActionSpec, HotkeyReport, RunOptions, Source};

pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new().build()
}

/// Register the history shortcut and every action hotkey, replacing whatever was registered.
pub fn register_all(app: &AppHandle, main: &str, actions: &[ActionSpec]) -> Vec<HotkeyReport> {
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        crate::log::line(format!("hotkeys: unregister_all: {e}"));
    }
    let mut reports = Vec::new();
    let main_ok = gs
        .on_shortcut(main, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                crate::windows::toggle_history(app);
            }
        })
        .map_err(|e| e.to_string());
    reports.push(HotkeyReport { action: "paste-smart".into(), hotkey: main.into(), ok: main_ok.is_ok(), problem: main_ok.err() });

    for a in actions {
        if a.needs == "decider" {
            continue; // smart paste is the history shortcut itself
        }
        let Some(h) = a.hotkey() else { continue };
        let problem = if gs.is_registered(h) {
            Some(if same(h, main) { "same as the history shortcut".to_string() } else { "already used by another action".to_string() })
        } else {
            let id = a.id.clone();
            gs.on_shortcut(h, move |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let app = app.clone();
                    let id = id.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::actions::run(app, id, Source::Clipboard, RunOptions::default()).await;
                    });
                }
            })
            .err()
            .map(|e| e.to_string())
        };
        reports.push(HotkeyReport { action: a.id.clone(), hotkey: h.to_string(), ok: problem.is_none(), problem });
    }
    reports
}

fn same(a: &str, b: &str) -> bool {
    a.parse::<tauri_plugin_global_shortcut::Shortcut>().ok().map(|x| x.id()) == b.parse::<tauri_plugin_global_shortcut::Shortcut>().ok().map(|x| x.id())
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
