//! Settings live in the store plugin's `settings.json` (shared with the
//! settings webview, which writes it); the API token lives in the Keychain
//! (`secrets.rs`). Missing or empty keys fall back to the defaults here.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE: &str = "settings.json";
pub const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+V";
pub const DEFAULT_REPO: &str = "/Users/nya/codes/github/pocket-paste";
/// Keychain item that holds the provider token.
pub const TOKEN_SECRET: &str = "provider_token";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub hotkey: String,
    /// chat | doc | social
    pub aspect: String,
    /// none | proxy — `cloudflare` and `hosted` are reserved and act as `none` until the CLI grows them.
    pub provider_kind: String,
    pub provider_url: String,
    /// dev | bundled
    pub sidecar_mode: String,
    pub dev_repo_path: String,
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            hotkey: DEFAULT_HOTKEY.into(),
            aspect: "chat".into(),
            provider_kind: "none".into(),
            provider_url: String::new(),
            sidecar_mode: "dev".into(),
            dev_repo_path: DEFAULT_REPO.into(),
            onboarded: false,
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
            provider_kind: text("provider_kind", &d.provider_kind),
            provider_url: text("provider_url", &d.provider_url),
            sidecar_mode: text("sidecar_mode", &d.sidecar_mode),
            dev_repo_path: text("dev_repo_path", &d.dev_repo_path),
            onboarded: store.get("onboarded").and_then(|v| v.as_bool()).unwrap_or(false),
        }
    }
}
