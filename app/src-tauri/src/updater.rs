//! In-app updates through `tauri-plugin-updater`, wired behind configuration:
//! the plugin is registered only when the build's `plugins.updater` carries
//! a non-empty `pubkey` (the sidecar/release config; `tauri.sidecar.conf.json`),
//! so `tauri dev` and unsigned builds never contact the endpoint. When it is
//! on, a check runs shortly after launch and once a day; the tray's
//! "Check for updates…" runs one by hand and reports either way.

use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::log;

const FIRST_CHECK: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdaterConfig {
    pub enabled: bool,
    pub endpoint: String,
}

/// Read `plugins.updater` from the generated config, before the app exists.
pub fn configured(config: &tauri::Config) -> UpdaterConfig {
    let u = config.plugins.0.get("updater");
    let pubkey = u.and_then(|u| u.get("pubkey")).and_then(|p| p.as_str()).unwrap_or("").trim();
    let endpoint = u
        .and_then(|u| u.get("endpoints"))
        .and_then(|e| e.get(0))
        .and_then(|e| e.as_str())
        .unwrap_or("")
        .to_string();
    UpdaterConfig { enabled: !pubkey.is_empty() && !endpoint.is_empty(), endpoint }
}

fn tell(app: &AppHandle, title: &str, text: impl Into<String>) {
    app.dialog().message(text).title(title).kind(MessageDialogKind::Info).show(|_| {});
}

/// Launch: the first check after a short delay, then daily. Silent when disabled.
pub fn start(app: &AppHandle) {
    if !app.state::<UpdaterConfig>().enabled {
        log::line("updater: not configured in this build (no pubkey); skipping");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(FIRST_CHECK).await;
        loop {
            check(app.clone(), false).await;
            tokio_sleep(EVERY).await;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// One check. `manual` (the tray item) reports every outcome in a dialog.
pub async fn check(app: AppHandle, manual: bool) {
    let cfg = app.state::<UpdaterConfig>().inner().clone();
    if !cfg.enabled {
        if manual {
            tell(&app, "Peesuto", "Updates are not configured in this build.");
        }
        return;
    }
    let current = app.package_info().version.to_string();
    let updater = {
        use tauri_plugin_updater::UpdaterExt;
        match app.updater() {
            Ok(u) => u,
            Err(e) => {
                log::line(format!("updater: {e}"));
                if manual {
                    tell(&app, "Peesuto", format!("Could not check for updates: {e}"));
                }
                return;
            }
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::line(format!("updater: {version} available (running {current})"));
            let app2 = app.clone();
            app.dialog()
                .message(format!("Peesuto {version} is available; you have {current}.\n\nInstall it and relaunch?"))
                .title("Update available")
                .buttons(MessageDialogButtons::OkCancelCustom("Install and relaunch".into(), "Later".into()))
                .show(move |ok| {
                    if !ok {
                        return;
                    }
                    tauri::async_runtime::spawn(async move {
                        match update.download_and_install(|_, _| {}, || {}).await {
                            Ok(()) => {
                                log::line(format!("updater: {version} installed; relaunching"));
                                app2.restart();
                            }
                            Err(e) => {
                                log::line(format!("updater: install failed: {e}"));
                                tell(&app2, "Update failed", format!("The update could not be installed: {e}"));
                            }
                        }
                    });
                });
        }
        Ok(None) => {
            log::line(format!("updater: up to date ({current})"));
            if manual {
                tell(&app, "Peesuto", format!("You have the latest version ({current})."));
            }
        }
        Err(e) => {
            log::line(format!("updater: check failed: {e}"));
            if manual {
                tell(&app, "Peesuto", format!("Could not check for updates: {e}"));
            }
        }
    }
}

#[tauri::command]
pub async fn updates_check(app: AppHandle) {
    check(app, true).await;
}

#[tauri::command]
pub fn updates_config(app: AppHandle) -> UpdaterConfig {
    app.state::<UpdaterConfig>().inner().clone()
}
