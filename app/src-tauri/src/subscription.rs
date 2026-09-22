//! The hosted subscription (`docs/subscription.md`, `proxy/README.md`) and
//! packs. The license key is the hosted bearer token, kept in the Keychain
//! under `pocket-paste/hosted` — the same item the `hosted` decider and
//! generator use — and the base URL in Settings. The shell makes these
//! requests itself (`GET /v1/me`, `GET /v1/packs`, the pack zip): its own
//! egress, so every request writes one line to `<app data>/egress.log` in
//! the shape Core uses (`{at, host, purpose, bytesOut, bytesIn, status, ms}`),
//! never a body, and the Offline switch refuses them like Core's.
//!
//! A pack is installed by downloading the zip named in the index, checking
//! its SHA-256 against the index, and unpacking it into
//! `<app data>/packs/<id>/` (the zip's root must hold `pack.json`); Core is
//! then asked to reload and its problems are shown.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

use crate::{
    daemon, log,
    providers::{self, Decider, Generator, DEFAULT_HOSTED_URL, EGRESS_LOG, REF_HOSTED_TOKEN},
    secrets,
    settings::{Settings, STORE},
    sidecar::PasteError,
};

pub const PACKS_DIR: &str = "packs";
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PACK_BYTES: usize = 50 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase() | b[0].is_ascii_digit()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `https://host/` or `https://host/v1` → `https://host`.
fn base_of(url: &str) -> String {
    let mut b = url.trim().trim_end_matches('/').to_string();
    if b.ends_with("/v1") {
        b.truncate(b.len() - 3);
    }
    b
}

fn base_url(app: &AppHandle) -> String {
    let s = Settings::load(app).hosted_url;
    let b = base_of(if s.trim().is_empty() { DEFAULT_HOSTED_URL } else { &s });
    if b.is_empty() { base_of(DEFAULT_HOSTED_URL) } else { b }
}

fn key(app: &AppHandle) -> Option<String> {
    let _ = app;
    secrets::get(REF_HOSTED_TOKEN).ok().flatten().filter(|k| !k.trim().is_empty())
}

fn is_local(host: &str) -> bool {
    let h = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    matches!(h.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "[::1]") || h.ends_with(".localhost") || h.starts_with("127.")
}

fn record_egress(app: &AppHandle, line: &Value) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(EGRESS_LOG)) {
        let _ = writeln!(f, "{line}");
    }
}

/// GET `url`, optionally with the bearer; one egress line whatever happens.
async fn get(app: &AppHandle, url: &str, bearer: Option<&str>, purpose: &str, max_bytes: usize) -> Result<(u16, Vec<u8>), PasteError> {
    if providers::load(app).offline {
        return Err(PasteError::new("provider:offline", "Offline mode is on, so nothing was sent."));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(PasteError::new("provider:config", format!("not an http(s) URL: {url}")));
    }
    let host = providers::host_of(url);
    let mut line = json!({
        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "host": host, "purpose": purpose, "bytesOut": 0, "bytesIn": 0, "status": 0, "ms": 0,
    });
    if is_local(&host) {
        line["local"] = json!(true);
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(format!("pocket-paste/{}", app.package_info().version))
        .build()
        .map_err(|e| PasteError::new("error", format!("http client: {e}")))?;
    let mut req = client.get(url);
    if let Some(k) = bearer {
        req = req.bearer_auth(k);
    }
    let t0 = Instant::now();
    let outcome: Result<(u16, Vec<u8>), reqwest::Error> = async {
        let res = req.send().await?;
        let status = res.status().as_u16();
        let bytes = res.bytes().await?;
        Ok((status, bytes.to_vec()))
    }
    .await;
    line["ms"] = json!(t0.elapsed().as_millis() as u64);
    match outcome {
        Ok((status, bytes)) => {
            line["status"] = json!(status);
            line["bytesIn"] = json!(bytes.len());
            record_egress(app, &line);
            if bytes.len() > max_bytes {
                return Err(PasteError::new("provider:bad-response", format!("{host} answered with {} bytes, more than allowed", bytes.len())));
            }
            Ok((status, bytes))
        }
        Err(e) => {
            let timeout = e.is_timeout();
            line["error"] = json!(if timeout { "timeout" } else { "network" });
            record_egress(app, &line);
            Err(PasteError::new(
                if timeout { "provider:timeout" } else { "provider:network" },
                if timeout { format!("{host} did not answer within {} s.", TIMEOUT.as_secs()) } else { format!("Offline or unreachable: {host} ({e}).") },
            ))
        }
    }
}

/// A `/v1/*` call with the license key; the proxy's statuses as messages.
async fn hosted(app: &AppHandle, route: &str) -> Result<Value, PasteError> {
    let key = key(app).ok_or_else(|| PasteError::new("provider:config", "Enter a license key first."))?;
    let url = format!("{}/v1/{route}", base_url(app));
    let (status, body) = get(app, &url, Some(&key), "subscription", 1024 * 1024).await?;
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    match status {
        200..=299 => Ok(v),
        401 => Err(PasteError::new("provider:auth", "That license key is not recognised (or the subscription is cancelled).")),
        402 => Err(PasteError::new("provider:quota", "This month's quota is used up.")),
        429 => Err(PasteError::new("provider:quota", "Too many requests; try again in a minute.")),
        s => Err(PasteError::new("provider:bad-response", format!("{} answered {s}: {}", providers::host_of(&url), v.get("error").and_then(|e| e.as_str()).unwrap_or("")))),
    }
}

// ---- commands: subscription ----

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionForm {
    pub key: String,
    pub base_url: String,
    pub default_base_url: String,
    /// Both tracks already point at hosted.
    pub hosted_active: bool,
}

#[tauri::command]
pub fn subscription_get(app: AppHandle) -> SubscriptionForm {
    let cfg = providers::load(&app);
    SubscriptionForm {
        key: key(&app).unwrap_or_default(),
        base_url: base_url(&app),
        default_base_url: base_of(DEFAULT_HOSTED_URL),
        hosted_active: matches!(cfg.decider, Decider::Hosted { .. }) && matches!(cfg.generator, Generator::Hosted { .. }),
    }
}

/// Store the key and base URL, then `GET /v1/me`.
#[tauri::command]
pub async fn subscription_activate(app: AppHandle, key: String, base_url: String) -> Result<Value, PasteError> {
    let e = |m: String| PasteError::new("error", m);
    secrets::set(REF_HOSTED_TOKEN, key.trim()).map_err(e)?;
    let store = app.store(STORE).map_err(|x| e(x.to_string()))?;
    store.set("hosted_url", json!(base_of(&base_url)));
    store.save().map_err(|x| e(x.to_string()))?;
    let me = hosted(&app, "me").await?;
    log::line(format!("subscription: plan {} · {}/{} used", me["plan"].as_str().unwrap_or("?"), me["used"], me["quota"]));
    Ok(me)
}

/// Point both tracks at hosted with the stored key, write providers.json, push `config.set`.
#[tauri::command]
pub async fn subscription_use_hosted(app: AppHandle) -> Result<Value, PasteError> {
    if key(&app).is_none() {
        return Err(PasteError::new("provider:config", "Enter and activate a license key first."));
    }
    let base = base_url(&app);
    let url = if base == base_of(DEFAULT_HOSTED_URL) { None } else { Some(base) };
    let mut cfg = providers::load(&app);
    cfg.decider = Decider::Hosted { token_ref: REF_HOSTED_TOKEN.into(), url: url.clone() };
    cfg.generator = Generator::Hosted { token_ref: REF_HOSTED_TOKEN.into(), url };
    providers::save(&app, &cfg).map_err(|m| PasteError::new("error", m))?;
    daemon::apply_config(&app).await
}

// ---- packs ----

fn packs_dir(app: &AppHandle) -> Result<PathBuf, PasteError> {
    app.path().app_data_dir().map(|d| d.join(PACKS_DIR)).map_err(|e| PasteError::new("error", format!("no application data directory: {e}")))
}

fn manifest_id(json: &[u8]) -> Result<String, PasteError> {
    let v: Value = serde_json::from_slice(json).map_err(|e| PasteError::new("action:spec", format!("pack.json is not JSON: {e}")))?;
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
    if !valid_id(id) {
        return Err(PasteError::new("action:spec", "pack.json: id must be lowercase letters, digits and dashes"));
    }
    Ok(id.to_string())
}

/// Unpack `zip` into `<packs>/<id>/`, replacing what is there. The archive's
/// root must hold `pack.json`, and its `id` must be `expected` when given.
fn unpack(zip: &[u8], expected: Option<&str>, packs: &Path) -> Result<String, PasteError> {
    let bad = |m: String| PasteError::new("action:spec", m);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| bad(format!("not a zip file: {e}")))?;
    let mut manifest: Option<Vec<u8>> = None;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| bad(format!("zip entry {i}: {e}")))?;
        if f.name() == "pack.json" {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| bad(format!("pack.json: {e}")))?;
            manifest = Some(buf);
        }
    }
    let manifest = manifest.ok_or_else(|| bad("the zip's root has no pack.json (a pack is a zip of the pack directory's contents)".into()))?;
    let id = manifest_id(&manifest)?;
    if let Some(exp) = expected {
        if exp != id {
            return Err(bad(format!("the zip is pack “{id}”, not “{exp}”")));
        }
    }
    let staging = packs.join(format!(".installing-{id}-{}", crate::store::new_id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| bad(format!("cannot create {}: {e}", staging.display())))?;
    let result = (|| -> Result<(), PasteError> {
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).map_err(|e| bad(format!("zip entry {i}: {e}")))?;
            let Some(rel) = f.enclosed_name() else { return Err(bad(format!("unsafe path in zip: {}", f.name()))) };
            let dest = staging.join(rel);
            if f.is_dir() {
                std::fs::create_dir_all(&dest).map_err(|e| bad(e.to_string()))?;
                continue;
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| bad(e.to_string()))?;
            }
            let mut out = std::fs::File::create(&dest).map_err(|e| bad(format!("{}: {e}", dest.display())))?;
            std::io::copy(&mut f, &mut out).map_err(|e| bad(format!("{}: {e}", dest.display())))?;
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let final_dir = packs.join(&id);
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir).map_err(|e| bad(format!("cannot move the pack into place: {e}")))?;
    Ok(id)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// Ask Core to reload and hand back its problems (all of them; the pane shows them).
async fn reload(app: &AppHandle) -> Result<Vec<Value>, PasteError> {
    let v = daemon::daemon_actions(app.clone(), Some(true)).await?;
    crate::actions::refresh(app, false).await;
    Ok(v["problems"].as_array().cloned().unwrap_or_default())
}

#[derive(Serialize)]
pub struct InstallReport {
    pub id: String,
    pub problems: Vec<Value>,
    pub path: String,
}

#[tauri::command]
pub async fn packs_index(app: AppHandle) -> Result<Vec<Value>, PasteError> {
    let v = hosted(&app, "packs").await?;
    Ok(v.get("packs").and_then(|p| p.as_array()).cloned().unwrap_or_default())
}

/// Download `url`, check `sha256`, unpack into `<packs>/<id>/`, reload Core.
#[tauri::command]
pub async fn packs_install(app: AppHandle, id: String, url: String, sha256: String) -> Result<InstallReport, PasteError> {
    if !valid_id(&id) {
        return Err(PasteError::new("action:spec", format!("bad pack id {id:?}")));
    }
    let (status, bytes) = get(&app, &url, None, "pack", MAX_PACK_BYTES).await?;
    if !(200..=299).contains(&status) {
        return Err(PasteError::new("provider:bad-response", format!("{} answered {status} for the pack", providers::host_of(&url))));
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != sha256.trim().to_ascii_lowercase() {
        log::line(format!("packs: {id}: checksum mismatch (index {}, file {})", sha256, digest));
        return Err(PasteError::new("action:spec", "The download does not match the checksum in the pack index; nothing was installed."));
    }
    let packs = packs_dir(&app)?;
    std::fs::create_dir_all(&packs).map_err(|e| PasteError::new("error", e.to_string()))?;
    let size = bytes.len();
    let installed = tauri::async_runtime::spawn_blocking(move || unpack(&bytes, Some(&id), &packs))
        .await
        .map_err(|e| PasteError::new("error", e.to_string()))??;
    log::line(format!("packs: installed {installed} ({size} bytes)"));
    let problems = reload(&app).await?;
    Ok(InstallReport { path: packs_dir(&app)?.join(&installed).display().to_string(), id: installed, problems })
}

/// Core's view (`health.packs`).
#[tauri::command]
pub async fn packs_installed(app: AppHandle) -> Result<Vec<Value>, PasteError> {
    let v = daemon::daemon_health(app).await?;
    Ok(v.get("packs").and_then(|p| p.as_array()).cloned().unwrap_or_default())
}

#[tauri::command]
pub async fn packs_remove(app: AppHandle, id: String) -> Result<Vec<Value>, PasteError> {
    if !valid_id(&id) {
        return Err(PasteError::new("action:spec", format!("bad pack id {id:?}")));
    }
    let dir = packs_dir(&app)?.join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| PasteError::new("error", format!("cannot remove {}: {e}", dir.display())))?;
    }
    log::line(format!("packs: removed {id}"));
    reload(&app).await
}

#[tauri::command]
pub fn packs_open_folder(app: AppHandle) -> Result<String, String> {
    let dir = packs_dir(&app).map_err(|e| e.message)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// Debug builds only: copy a pack directory (one with a `pack.json`) into place.
#[tauri::command]
pub async fn packs_install_from_folder(app: AppHandle, path: String) -> Result<InstallReport, PasteError> {
    if !cfg!(debug_assertions) {
        return Err(PasteError::new("usage", "Installing from a folder is a debug-build aid."));
    }
    let from = PathBuf::from(path.trim());
    let manifest = std::fs::read(from.join("pack.json")).map_err(|e| PasteError::new("action:spec", format!("{}: no pack.json ({e})", from.display())))?;
    let id = manifest_id(&manifest)?;
    let packs = packs_dir(&app)?;
    let dest = packs.join(&id);
    let _ = std::fs::remove_dir_all(&dest);
    copy_dir(&from, &dest).map_err(|e| PasteError::new("error", format!("copy failed: {e}")))?;
    log::line(format!("packs: installed {id} from {}", from.display()));
    let problems = reload(&app).await?;
    Ok(InstallReport { path: dest.display().to_string(), id, problems })
}

/// Dev aid for `POCKET_PASTE_AUTORUN=pack-test:<dir>`: install, reload, list, render with `palette: "neon"`.
pub async fn pack_test(app: AppHandle, dir: String) {
    match packs_install_from_folder(app.clone(), dir).await {
        Ok(r) => log::line(format!("pack-test: installed {} · {} problem(s) {}", r.id, r.problems.len(), Value::Array(r.problems))),
        Err(e) => {
            log::line(format!("pack-test: install failed: {} — {}", e.kind, e.message));
            return;
        }
    }
    match packs_installed(app.clone()).await {
        Ok(p) => log::line(format!("pack-test: health.packs = {}", Value::Array(p))),
        Err(e) => log::line(format!("pack-test: health failed: {}", e.message)),
    }
    let dsl = json!({"text": "Neon pack test — a palette from a style pack", "kind": "plain", "layout": "center", "palette": "neon", "aspect": "chat", "scale": 1, "tone": 1, "emphasis": -1, "animate": false});
    match daemon::daemon_render(app, dsl, None).await {
        Ok(v) => log::line(format!("pack-test: render ok → {} ({}, {} frame(s), {} ms)", v["path"], v["format"], v["frames"], v["ms"]["total"])),
        Err(e) => log::line(format!("pack-test: render failed: {} — {}", e.kind, e.message)),
    }
}

/// Dev aid for `POCKET_PASTE_AUTORUN=hosted-test:<base url>`: the whole
/// subscription path against a proxy (the fake one in a test, or the real
/// one): /v1/me with a wrong and a right key, /v1/packs, an install with a
/// bad checksum and a good one, remove. Logs outcomes only.
pub async fn hosted_test(app: AppHandle, base: String) {
    let say = |m: String| log::line(format!("hosted-test: {m}"));
    match subscription_activate(app.clone(), "wrong-key".into(), base.clone()).await {
        Ok(v) => say(format!("wrong key unexpectedly accepted: {v}")),
        Err(e) => say(format!("wrong key → {} — {}", e.kind, e.message)),
    }
    match subscription_activate(app.clone(), "good-key-123".into(), base.clone()).await {
        Ok(v) => say(format!("good key → plan {} · {}/{} · resets {}", v["plan"], v["used"], v["quota"], v["resetsAt"])),
        Err(e) => say(format!("good key failed: {} — {}", e.kind, e.message)),
    }
    let index = match packs_index(app.clone()).await {
        Ok(i) => {
            say(format!("index: {} pack(s): {}", i.len(), i.iter().map(|p| p["id"].as_str().unwrap_or("?")).collect::<Vec<_>>().join(", ")));
            i
        }
        Err(e) => {
            say(format!("index failed: {} — {}", e.kind, e.message));
            Vec::new()
        }
    };
    for p in &index {
        let (id, url, sha) = (p["id"].as_str().unwrap_or("").to_string(), p["url"].as_str().unwrap_or("").to_string(), p["sha256"].as_str().unwrap_or("").to_string());
        match packs_install(app.clone(), id.clone(), url, sha).await {
            Ok(r) => say(format!("install {id} → ok, {} problem(s)", r.problems.len())),
            Err(e) => say(format!("install {id} → {} — {}", e.kind, e.message)),
        }
    }
    match packs_installed(app.clone()).await {
        Ok(p) => say(format!("health.packs = {}", Value::Array(p))),
        Err(e) => say(format!("health failed: {}", e.message)),
    }
    match packs_remove(app.clone(), "example-neon".into()).await {
        Ok(p) => say(format!("remove example-neon → ok, {} problem(s)", p.len())),
        Err(e) => say(format!("remove failed: {} — {}", e.kind, e.message)),
    }
    match packs_installed(app.clone()).await {
        Ok(p) => say(format!("health.packs after remove = {}", Value::Array(p))),
        Err(e) => say(format!("health failed: {}", e.message)),
    }
    // Unreachable host: the network error path and its egress line.
    let _ = secrets::set(REF_HOSTED_TOKEN, "good-key-123");
    match get(&app, "http://127.0.0.1:9/v1/me", Some("good-key-123"), "subscription", 1024).await {
        Ok((s, _)) => say(format!("unreachable host unexpectedly answered {s}")),
        Err(e) => say(format!("unreachable → {} — {}", e.kind, e.message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(body.as_bytes()).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn ids_and_bases() {
        assert!(valid_id("example-neon"));
        assert!(!valid_id("Example"));
        assert!(!valid_id("-x"));
        assert!(!valid_id(""));
        assert_eq!(base_of("https://api.peesuto.com/"), "https://api.peesuto.com");
        assert_eq!(base_of("http://127.0.0.1:8790/v1"), "http://127.0.0.1:8790");
        assert!(is_local("127.0.0.1:8790"));
        assert!(!is_local("api.peesuto.com"));
    }

    #[test]
    fn unpack_requires_root_manifest_and_replaces() {
        let dir = std::env::temp_dir().join(format!("pocket-paste-packs-{}", crate::store::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = zip_of(&[("pack.json", r#"{"id":"example-neon","name":"N","version":"1.0.0","kind":"styles"}"#), ("catalog.json", "{}")]);
        assert_eq!(unpack(&good, Some("example-neon"), &dir).unwrap(), "example-neon");
        assert!(dir.join("example-neon/catalog.json").exists());
        std::fs::write(dir.join("example-neon/stale.txt"), "old").unwrap();
        unpack(&good, None, &dir).unwrap();
        assert!(!dir.join("example-neon/stale.txt").exists(), "replaced, not merged");
        let nested = zip_of(&[("example-neon/pack.json", r#"{"id":"example-neon"}"#)]);
        assert!(unpack(&nested, None, &dir).unwrap_err().message.contains("no pack.json"));
        let wrong = zip_of(&[("pack.json", r#"{"id":"other"}"#)]);
        assert!(unpack(&wrong, Some("example-neon"), &dir).unwrap_err().message.contains("not"));
        let unsafe_zip = zip_of(&[("pack.json", r#"{"id":"x1"}"#), ("../escape.txt", "no")]);
        assert!(unpack(&unsafe_zip, None, &dir).is_err());
        assert!(!dir.join("x1").exists());
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".installing")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
