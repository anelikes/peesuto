//! Settings live in the store plugin's `settings.json` (shared with the
//! settings webview, which writes it). Provider configuration is not here:
//! it is `providers.json` (`providers.rs`), the file Core reads, with the
//! credentials in the Keychain. Missing or empty keys fall back to the
//! defaults here.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE: &str = "settings.json";
pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+V";
pub const DEFAULT_REPO: &str = "/Users/nya/codes/github/pocket-paste";
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// Apps whose copies never enter the history (the user list starts from these).
pub const DEFAULT_BLACKLIST: &[&str] = &[
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub hotkey: String,
    /// chat | doc | social
    pub aspect: String,
    /// dev | bundled
    pub sidecar_mode: String,
    pub dev_repo_path: String,
    pub onboarded: bool,
    /// Days to keep unpinned items; 0 keeps everything.
    pub retention_days: u32,
    /// Bundle ids whose copies are never recorded.
    pub blacklist: Vec<String>,
    /// Run the pick when the panel opens from the hotkey.
    pub smart_paste: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: DEFAULT_HOTKEY.into(),
            aspect: "chat".into(),
            sidecar_mode: "dev".into(),
            dev_repo_path: DEFAULT_REPO.into(),
            onboarded: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            blacklist: DEFAULT_BLACKLIST.iter().map(|s| s.to_string()).collect(),
            smart_paste: true,
        }
    }
}

impl Settings {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Settings {
        let d = Settings::default();
        let Ok(store) = app.store(STORE) else { return d };
        let text = |key: &str, default: &str| -> String {
            store
                .get(key)
                .and_then(|v| v.as_str().map(String::from))
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| default.to_string())
        };
        Settings {
            hotkey: text("hotkey", &d.hotkey),
            aspect: text("aspect", &d.aspect),
            sidecar_mode: text("sidecar_mode", &d.sidecar_mode),
            dev_repo_path: text("dev_repo_path", &d.dev_repo_path),
            onboarded: store.get("onboarded").and_then(|v| v.as_bool()).unwrap_or(false),
            retention_days: store.get("retention_days").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(d.retention_days),
            blacklist: store
                .get("blacklist")
                .and_then(|v| v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()))
                .unwrap_or(d.blacklist),
            smart_paste: store.get("smart_paste").and_then(|v| v.as_bool()).unwrap_or(true),
        }
    }
}
