//! The two provider tracks: what `core/src/provider/config.ts` calls
//! `ProvidersConfig`, kept in `<app data>/providers.json` in exactly that
//! shape — kinds, URLs, model names, the offline switch, and for every
//! credential only a `*Ref` naming a Keychain item (`SECRET_REFS`). The
//! secrets themselves are read from the Keychain here and handed to Core
//! in memory with `config.set` (`daemon.rs`); they never land in the file.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

use crate::secrets;

pub const FILE: &str = "providers.json";
pub const EGRESS_LOG: &str = "egress.log";
pub const ANSWER_CACHE_DIR: &str = "answers";

/// `SECRET_REFS` in core/src/provider/config.ts: the Keychain item names.
pub const REF_PROXY_TOKEN: &str = "pocket-paste/proxy";
pub const REF_CLOUDFLARE_TOKEN: &str = "pocket-paste/cloudflare";
pub const REF_HOSTED_TOKEN: &str = "pocket-paste/hosted";
pub const REF_GENERATOR_API_KEY: &str = "pocket-paste/generator";

pub const DEFAULT_HOSTED_URL: &str = "https://jev.pocketpaste.dev";
pub const CLOUDFLARE_HOST: &str = "api.cloudflare.com";
pub const ANTHROPIC_HOST: &str = "api.anthropic.com";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Decider {
    None,
    Proxy {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_ref: Option<String>,
    },
    Cloudflare {
        account_id: String,
        token_ref: String,
    },
    Hosted {
        token_ref: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Generator {
    None,
    OpenaiCompatible {
        base_url: String,
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_key_ref: Option<String>,
    },
    Anthropic {
        api_key_ref: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    Hosted {
        token_ref: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
}

/// The file's shape (`ProvidersConfig`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProvidersConfig {
    pub decider: Decider,
    pub generator: Generator,
    #[serde(default)]
    pub offline: bool,
}

impl Default for ProvidersConfig {
    fn default() -> Self {
        ProvidersConfig { decider: Decider::None, generator: Generator::None, offline: false }
    }
}

/// What the settings window edits: the config plus the four secrets, which
/// go to the Keychain on `providers_set` and come back from it on `providers_get`.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersForm {
    pub config: ProvidersConfig,
    pub proxy_token: String,
    pub cloudflare_token: String,
    pub hosted_token: String,
    pub generator_api_key: String,
}

pub fn file_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(FILE))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> ProvidersConfig {
    let Some(path) = file_path(app) else { return ProvidersConfig::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            crate::log::line(format!("{}: unreadable, using defaults: {e}", path.display()));
            ProvidersConfig::default()
        }),
        Err(_) => ProvidersConfig::default(),
    }
}

fn in_keychain(name: &str) -> bool {
    secrets::get(name).ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
}

/// Write the file owner-readable only. Refs are normalised to the conventional names first.
pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &ProvidersConfig) -> Result<(), String> {
    let path = file_path(app).ok_or("no application data directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&normalised(cfg, in_keychain)).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{text}\n")).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The refs a config should carry: always the conventional names, so the
/// file and the Keychain agree whatever the settings window sent. The two
/// optional credentials (proxy token, OpenAI-compatible key) are named only
/// when `has(ref)` says the Keychain holds them — Core treats a named ref
/// with no secret behind it as a configuration error.
pub fn normalised(cfg: &ProvidersConfig, has: impl Fn(&str) -> bool) -> ProvidersConfig {
    let optional = |name: &str| has(name).then(|| name.to_string());
    let decider = match &cfg.decider {
        Decider::None => Decider::None,
        Decider::Proxy { url, .. } => Decider::Proxy { url: url.trim().to_string(), token_ref: optional(REF_PROXY_TOKEN) },
        Decider::Cloudflare { account_id, .. } => Decider::Cloudflare { account_id: account_id.trim().to_string(), token_ref: REF_CLOUDFLARE_TOKEN.into() },
        Decider::Hosted { url, .. } => Decider::Hosted { token_ref: REF_HOSTED_TOKEN.into(), url: clean(url) },
    };
    let generator = match &cfg.generator {
        Generator::None => Generator::None,
        Generator::OpenaiCompatible { base_url, model, .. } => Generator::OpenaiCompatible {
            base_url: base_url.trim().to_string(),
            model: model.trim().to_string(),
            api_key_ref: optional(REF_GENERATOR_API_KEY),
        },
        Generator::Anthropic { model, .. } => Generator::Anthropic { api_key_ref: REF_GENERATOR_API_KEY.into(), model: clean(model) },
        Generator::Hosted { url, .. } => Generator::Hosted { token_ref: REF_HOSTED_TOKEN.into(), url: clean(url) },
    };
    ProvidersConfig { decider, generator, offline: cfg.offline }
}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The secrets the config refers to, read from the Keychain. A missing
/// Keychain item for a configured track is left out; Core reports
/// `provider:config` when it needs it.
pub fn secrets_for(cfg: &ProvidersConfig) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    let mut take = |name: &str| {
        if let Some(v) = secrets::get(name).ok().flatten().filter(|v| !v.is_empty()) {
            m.insert(name.to_string(), Value::String(v));
        }
    };
    match &cfg.decider {
        Decider::Proxy { token_ref: Some(r), .. } => take(r),
        Decider::Cloudflare { token_ref, .. } | Decider::Hosted { token_ref, .. } => take(token_ref),
        _ => {}
    }
    match &cfg.generator {
        Generator::OpenaiCompatible { api_key_ref: Some(r), .. } => take(r),
        Generator::Anthropic { api_key_ref, .. } => take(api_key_ref),
        Generator::Hosted { token_ref, .. } => take(token_ref),
        _ => {}
    }
    m
}

/// The `config.set` request body for Core.
pub fn core_config<R: Runtime>(app: &AppHandle<R>) -> Value {
    let cfg = normalised(&load(app), in_keychain);
    let egress = app.path().app_data_dir().ok().map(|d| d.join(EGRESS_LOG).display().to_string());
    json!({
        "cmd": "config.set",
        "decider": cfg.decider,
        "generator": cfg.generator,
        "offline": cfg.offline,
        "secrets": secrets_for(&cfg),
        "egressLog": egress,
    })
}

pub fn host_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or(rest).to_string()
}

/// Where each track sends its requests, by host, for the privacy pane.
pub fn destinations(cfg: &ProvidersConfig) -> Vec<(String, String)> {
    let mut out = Vec::new();
    match &cfg.decider {
        Decider::None => out.push(("decider".into(), "nowhere (heuristic)".into())),
        Decider::Proxy { url, .. } => out.push(("decider".into(), host_of(url))),
        Decider::Cloudflare { .. } => out.push(("decider".into(), CLOUDFLARE_HOST.into())),
        Decider::Hosted { url, .. } => out.push(("decider".into(), host_of(url.as_deref().unwrap_or(DEFAULT_HOSTED_URL)))),
    }
    match &cfg.generator {
        Generator::None => out.push(("generator".into(), "nowhere (not configured)".into())),
        Generator::OpenaiCompatible { base_url, .. } => out.push(("generator".into(), host_of(base_url))),
        Generator::Anthropic { .. } => out.push(("generator".into(), ANTHROPIC_HOST.into())),
        Generator::Hosted { url, .. } => out.push(("generator".into(), host_of(url.as_deref().unwrap_or(DEFAULT_HOSTED_URL)))),
    }
    out
}

fn short(kind: &str, host: &str) -> String {
    format!("{kind} → {host}")
}

// ---- commands ----

#[tauri::command]
pub fn providers_get(app: AppHandle) -> ProvidersForm {
    let config = load(&app);
    let s = |n: &str| secrets::get(n).ok().flatten().unwrap_or_default();
    ProvidersForm {
        config,
        proxy_token: s(REF_PROXY_TOKEN),
        cloudflare_token: s(REF_CLOUDFLARE_TOKEN),
        hosted_token: s(REF_HOSTED_TOKEN),
        generator_api_key: s(REF_GENERATOR_API_KEY),
    }
}

/// Store the secrets, write the file, and push the new config to Core.
#[tauri::command]
pub async fn providers_set(app: AppHandle, form: ProvidersForm) -> Result<Value, crate::sidecar::PasteError> {
    let e = |m: String| crate::sidecar::PasteError::new("error", m);
    secrets::set(REF_PROXY_TOKEN, form.proxy_token.trim()).map_err(e)?;
    secrets::set(REF_CLOUDFLARE_TOKEN, form.cloudflare_token.trim()).map_err(e)?;
    secrets::set(REF_HOSTED_TOKEN, form.hosted_token.trim()).map_err(e)?;
    secrets::set(REF_GENERATOR_API_KEY, form.generator_api_key.trim()).map_err(e)?;
    save(&app, &form.config).map_err(e)?;
    crate::daemon::apply_config(&app).await
}

#[derive(Serialize)]
pub struct PrivacyInfo {
    pub destinations: Vec<String>,
    pub egress_log: String,
    pub egress_lines: Vec<String>,
    pub answer_cache: String,
    pub offline: bool,
}

/// The privacy pane: hosts per track, the tail of the egress log, the cache path.
#[tauri::command]
pub fn privacy_info(app: AppHandle) -> Result<PrivacyInfo, String> {
    let cfg = load(&app);
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let log = data.join(EGRESS_LOG);
    let lines = std::fs::read_to_string(&log)
        .map(|t| {
            let all: Vec<&str> = t.lines().filter(|l| !l.trim().is_empty()).collect();
            all.iter().rev().take(50).rev().map(|s| s.to_string()).collect()
        })
        .unwrap_or_default();
    Ok(PrivacyInfo {
        destinations: destinations(&cfg).iter().map(|(k, h)| short(k, h)).collect(),
        egress_log: log.display().to_string(),
        egress_lines: lines,
        answer_cache: data.join(ANSWER_CACHE_DIR).display().to_string(),
        offline: cfg.offline,
    })
}

#[tauri::command]
pub fn egress_log_clear(app: AppHandle) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match std::fs::remove_file(data.join(EGRESS_LOG)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn answer_cache_clear(app: AppHandle) -> Result<u64, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = data.join(ANSWER_CACHE_DIR);
    let mut n = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let ok = if p.is_dir() { std::fs::remove_dir_all(&p).is_ok() } else { std::fs::remove_file(&p).is_ok() };
            if ok {
                n += 1;
            }
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_shape_matches_core() {
        let cfg = ProvidersConfig {
            decider: Decider::Cloudflare { account_id: "acc".into(), token_ref: REF_CLOUDFLARE_TOKEN.into() },
            generator: Generator::OpenaiCompatible { base_url: "http://localhost:11434/v1".into(), model: "llama3".into(), api_key_ref: None },
            offline: true,
        };
        let v = serde_json::to_value(&cfg).unwrap();
        assert_eq!(v["decider"]["kind"], "cloudflare");
        assert_eq!(v["decider"]["accountId"], "acc");
        assert_eq!(v["decider"]["tokenRef"], REF_CLOUDFLARE_TOKEN);
        assert_eq!(v["generator"]["kind"], "openai-compatible");
        assert_eq!(v["generator"]["baseUrl"], "http://localhost:11434/v1");
        assert!(v["generator"].get("apiKeyRef").is_none());
        assert_eq!(v["offline"], true);
        let back: ProvidersConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn normalised_pins_refs_and_never_carries_secrets() {
        let cfg = ProvidersConfig {
            decider: Decider::Proxy { url: " http://localhost:8787/ ".into(), token_ref: None },
            generator: Generator::Anthropic { api_key_ref: "whatever".into(), model: Some(" ".into()) },
            offline: false,
        };
        let n = normalised(&cfg, |_| true);
        assert_eq!(n.decider, Decider::Proxy { url: "http://localhost:8787/".into(), token_ref: Some(REF_PROXY_TOKEN.into()) });
        assert_eq!(n.generator, Generator::Anthropic { api_key_ref: REF_GENERATOR_API_KEY.into(), model: None });
        // Without the optional secrets in the Keychain the refs are left out (Core would reject a dangling ref).
        let n = normalised(&cfg, |_| false);
        assert_eq!(n.decider, Decider::Proxy { url: "http://localhost:8787/".into(), token_ref: None });
        let oai = ProvidersConfig { generator: Generator::OpenaiCompatible { base_url: "http://localhost:11434/v1".into(), model: "m".into(), api_key_ref: Some("x".into()) }, ..ProvidersConfig::default() };
        assert_eq!(normalised(&oai, |_| false).generator, Generator::OpenaiCompatible { base_url: "http://localhost:11434/v1".into(), model: "m".into(), api_key_ref: None });
        let text = serde_json::to_string(&n).unwrap();
        for k in ["\"token\"", "\"apiKey\"", "\"api_key\"", "\"secret\"", "\"password\""] {
            assert!(!text.contains(k), "{k} in {text}");
        }
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://api.example.com/v1/ask?x=1"), "api.example.com");
        assert_eq!(host_of("http://localhost:11434/v1"), "localhost:11434");
        let d = destinations(&ProvidersConfig::default());
        assert_eq!(d.len(), 2);
    }
}
