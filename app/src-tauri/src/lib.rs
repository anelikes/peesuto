//! Pocket Paste's shell: a menu-bar clipboard with actions.
//!
//! The shell owns everything that needs the system — tray, global shortcut,
//! pasteboard polling and writing, paste simulation, windows, Keychain — and
//! delegates every judgement to the `paste` CLI in `core/`, run as a sidecar
//! (`sidecar.rs`). Three webviews: `history` (the panel behind the shortcut),
//! `result` (a card from the "Paste as card" action) and `settings`. They talk
//! to the shell through the commands registered below and the events
//! `history:changed` and `result:state`.

mod card;
mod clipboard;
mod hotkeys;
mod paste;
mod pasteboard;
mod secrets;
mod settings;
mod sidecar;
mod tray;
mod windows;

use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent)
                .build(),
        )
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(hotkeys::plugin())
        .plugin(tauri_plugin_opener::init())
        .manage(card::CardState::default())
        .manage(clipboard::History::new())
        .manage(paste::Focus::default())
        .invoke_handler(tauri::generate_handler![
            clipboard::history_list,
            clipboard::history_delete,
            clipboard::history_pin,
            clipboard::history_clear,
            paste::paste_item,
            paste::paste_text,
            paste::paste_file,
            paste::paste_card,
            paste::accessibility_status,
            paste::accessibility_prompt,
            card::card_now,
            card::card_from_item,
            card::card_rerun,
            card::render_test,
            card::copy_card,
            card::save_card,
            card::result_state,
            card::result_hold,
            card::app_info,
            windows::hide_history_cmd,
            windows::hide_result,
            windows::open_settings,
            hotkeys::apply_hotkey,
            secrets::secret_get,
            secrets::secret_set,
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let s = settings::Settings::load(app.handle());
            tray::build(app.handle(), &s.hotkey)?;
            if let Err(e) = hotkeys::register(app.handle(), &s.hotkey) {
                eprintln!("pocket-paste: could not register {}: {e}", s.hotkey);
            }
            clipboard::start(app.handle());
            if !s.onboarded {
                windows::show_settings(app.handle());
            }
            card::autorun_if_requested(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Every window is long-lived: closing hides it.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The panels behave like menu-bar popovers and go away on blur —
            // the result window only while the frontend is not holding it
            // (a save dialog is up).
            WindowEvent::Focused(false) if window.label() == windows::HISTORY => {
                let _ = window.hide();
            }
            WindowEvent::Focused(false) if window.label() == windows::RESULT => {
                if !window.state::<card::CardState>().hold.load(Ordering::SeqCst) {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // With every window hidden Tauri would exit; the tray keeps us alive.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}
