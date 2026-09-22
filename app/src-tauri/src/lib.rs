//! Peesuto's shell: a menu-bar clipboard with actions.
//!
//! The shell owns everything that needs the system — tray, global shortcut,
//! pasteboard polling and writing, paste simulation, windows, Keychain — and
//! delegates every judgement to Core (`core/`), one long-lived process spoken
//! to over JSON lines (`daemon.rs`; `sidecar.rs` says where it lives). Three
//! webviews: `history` (the panel behind the shortcut, with the smart pick),
//! `result` (what an action produced) and `settings`. They talk to the shell
//! through the commands registered below and the events `history:changed`,
//! `history:open` and `result:state`.

mod actions;
mod clipboard;
mod context;
mod daemon;
mod hotkeys;
mod log;
mod locale;
mod paste;
mod pasteboard;
mod providers;
mod secrets;
mod settings;
mod sidecar;
mod store;
mod subscription;
mod tray;
mod updater;
mod windows;

use std::sync::atomic::Ordering;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let updater_config = updater::configured(context.config());
    let mut builder = tauri::Builder::default();
    // Only a build whose config carries a pubkey talks to the update endpoint.
    if updater_config.enabled {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .manage(updater_config)
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
        .manage(actions::ResultWindow::default())
        .manage(paste::Focus::default())
        .manage(daemon::Shared::default())
        .manage(actions::Registry::default())
        .manage(context::Current::default())
        .invoke_handler(tauri::generate_handler![
            locale::locale_get,
            locale::locale_set,
            clipboard::history_list,
            clipboard::history_get,
            clipboard::history_recent,
            clipboard::history_delete,
            clipboard::history_pin,
            clipboard::history_clear,
            clipboard::history_thumbnail,
            clipboard::history_status,
            clipboard::history_start_fresh,
            paste::paste_item,
            paste::paste_text,
            paste::paste_file,
            paste::paste_card,
            paste::accessibility_status,
            paste::accessibility_prompt,
            context::pick_session,
            context::context_probe,
            actions::action_run,
            actions::action_rerun,
            actions::actions_list,
            actions::actions_reload,
            actions::actions_open_folder,
            actions::actions_new,
            actions::copy_card,
            actions::save_card,
            actions::result_state,
            actions::result_hold,
            actions::app_info,
            actions::settings_apply,
            windows::hide_history_cmd,
            windows::hide_result,
            windows::open_settings,
            secrets::secret_get,
            secrets::secret_set,
            daemon::daemon_status,
            daemon::daemon_health,
            daemon::daemon_pick,
            daemon::daemon_run_action,
            daemon::daemon_actions,
            daemon::daemon_apply_config,
            daemon::daemon_restart,
            daemon::daemon_render,
            providers::providers_get,
            providers::providers_set,
            providers::privacy_info,
            providers::egress_log_clear,
            providers::answer_cache_clear,
            subscription::subscription_get,
            subscription::subscription_activate,
            subscription::subscription_use_hosted,
            subscription::packs_index,
            subscription::packs_install,
            subscription::packs_installed,
            subscription::packs_remove,
            subscription::packs_open_folder,
            subscription::packs_install_from_folder,
            updater::updates_check,
            updater::updates_config,
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Ok(dir) = app.path().app_data_dir() {
                log::init(&dir);
            }
            app.manage(clipboard::History::pending());
            let s = settings::Settings::load(app.handle());
            tray::build(app.handle(), &s.hotkey)?;
            // The history shortcut now; the action hotkeys once Core lists the actions.
            actions::apply_triggers(app.handle());
            clipboard::start(app.handle());
            daemon::start(app.handle());
            updater::start(app.handle());
            if !s.onboarded {
                windows::show_settings(app.handle());
            }
            actions::autorun_if_requested(app.handle());
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
                if !window.state::<actions::ResultWindow>().hold.load(Ordering::SeqCst) {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        // With every window hidden Tauri would exit; the tray keeps us alive.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => app.state::<daemon::Shared>().stop(),
        _ => {}
    });
}
