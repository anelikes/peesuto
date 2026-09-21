//! Clipboard history: a background thread polls the pasteboard's changeCount
//! every 250 ms and records new items — text, file lists, and images when
//! there is no text — through `HistoryStore` (`store.rs`), and the `history`
//! panel reads them through the commands below. Exclusions are applied
//! before anything is stored: the concealed and transient pasteboard types,
//! and the app blacklist from Settings. Retention runs at launch and hourly.

use base64::Engine;
use serde::Serialize;
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    pasteboard, secrets,
    settings::Settings,
    store::{self, ClipItem, HistoryStore, LockedStore, MemoryStore, NewItem, Opened, SqliteStore, StoreStatus},
};

pub const POLL: Duration = Duration::from_millis(250);
pub const EVENT: &str = "history:changed";
/// The panel's page and the search window.
pub const LIST_LIMIT: usize = 500;
/// How many of the newest items a pick considers.
pub const PICK_CANDIDATES: usize = 50;
const PURGE_EVERY: Duration = Duration::from_secs(3600);
/// Larger pasteboard images are not recorded.
const MAX_IMAGE_BYTES: usize = 40 * 1024 * 1024;

pub struct History(pub Mutex<Box<dyn HistoryStore>>);

impl History {
    /// Starts as "opening"; `start` opens the real store on the poller
    /// thread, because reading the key can block on a Keychain prompt (every
    /// rebuilt dev binary is a new identity to the Keychain) and `setup`
    /// must not hang on it.
    pub fn pending() -> History {
        History(Mutex::new(Box::new(LockedStore { detail: String::new() })))
    }

    fn open_now(app: &AppHandle) -> Box<dyn HistoryStore> {
        match app.path().app_data_dir() {
            Ok(dir) => open_store(&dir),
            Err(e) => {
                crate::log::line(format!("history: no app data directory ({e}); keeping history in memory"));
                Box::new(MemoryStore::default())
            }
        }
    }

    fn replace(&self, store: Box<dyn HistoryStore>) {
        if let Ok(mut s) = self.0.lock() {
            *s = store;
        }
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut dyn HistoryStore) -> T) -> Option<T> {
        self.0.lock().ok().map(|mut s| f(s.as_mut()))
    }

    pub fn get(&self, id: &str) -> Option<ClipItem> {
        self.with(|s| s.get(id)).flatten()
    }

    pub fn recent(&self, n: usize) -> Vec<ClipItem> {
        self.with(|s| s.recent(n)).unwrap_or_default()
    }

    pub fn status(&self) -> StoreStatus {
        self.with(|s| s.status()).unwrap_or(StoreStatus::Memory)
    }
}

fn decode_key(b64: &str) -> Result<store::Key, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("history key is not base64: {e}"))?;
    bytes.try_into().map_err(|_| "history key has the wrong length".to_string())
}

/// Debug builds only: `POCKET_PASTE_HISTORY_KEY=<base64 32 bytes>` stands in
/// for the Keychain item, so an unattended `tauri dev` run never hits the
/// Keychain prompt a freshly built binary would get.
fn key_from_env() -> Option<Result<store::Key, String>> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let v = std::env::var("POCKET_PASTE_HISTORY_KEY").ok().filter(|v| !v.trim().is_empty())?;
    crate::log::line("history: key from POCKET_PASTE_HISTORY_KEY (debug build)");
    Some(decode_key(&v))
}

fn key_from_keychain() -> Result<Option<store::Key>, String> {
    if let Some(k) = key_from_env() {
        return k.map(Some);
    }
    let Some(b64) = secrets::get(store::KEY_SECRET)? else { return Ok(None) };
    decode_key(&b64).map(Some)
}

fn new_key_in_keychain() -> Result<store::Key, String> {
    let key = store::new_key();
    secrets::set(store::KEY_SECRET, &base64::engine::general_purpose::STANDARD.encode(key))?;
    crate::log::line("history: created a new key in the Keychain");
    Ok(key)
}

fn open_store(app_data: &Path) -> Box<dyn HistoryStore> {
    let key = match key_from_keychain() {
        Ok(k) => k,
        Err(e) => {
            crate::log::line(format!("history: Keychain: {e}"));
            return Box::new(LockedStore { detail: format!("The history key could not be read from the Keychain: {e}") });
        }
    };
    let key = match key {
        Some(k) => k,
        None if app_data.join(store::DB_NAME).exists() => {
            crate::log::line("history: database present but its key is not in the Keychain; locked");
            return Box::new(LockedStore { detail: "The history database is here, but its key is no longer in the Keychain.".into() });
        }
        None => match new_key_in_keychain() {
            Ok(k) => k,
            Err(e) => {
                crate::log::line(format!("history: could not create the key in the Keychain ({e}); keeping history in memory"));
                return Box::new(MemoryStore::default());
            }
        },
    };
    match SqliteStore::open_with(app_data, Some(&key)) {
        Ok(Opened::Store(s)) => Box::new(s),
        Ok(Opened::Locked) => Box::new(LockedStore { detail: "The history database is locked.".into() }),
        Err(e) => {
            crate::log::line(format!("history: could not open the database ({e}); keeping history in memory"));
            Box::new(MemoryStore::default())
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn preview_of(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let collapsed: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut p: String = collapsed.chars().take(160).collect();
    if collapsed.chars().count() > 160 {
        p.push('…');
    }
    p
}

pub fn notify(app: &AppHandle) {
    let _ = app.emit_to("history", EVENT, ());
}

/// Turn a pasteboard reading into a history item, or `None` when it must be skipped.
fn item_from(snap: &pasteboard::Snapshot, front: Option<&pasteboard::FrontApp>, blacklist: &[String]) -> Option<NewItem> {
    if snap.concealed || snap.transient {
        return None;
    }
    if let Some(b) = front.and_then(|f| f.bundle_id.as_deref()) {
        if blacklist.iter().any(|x| x == b) {
            return None;
        }
    }
    let mut types: Vec<String> = Vec::new();
    for (uti, tag) in [
        ("public.rtf", "rtf"),
        ("public.html", "html"),
        ("public.png", "image"),
        ("public.tiff", "image"),
        ("public.file-url", "file-url"),
    ] {
        if snap.types.iter().any(|t| t == uti) && !types.iter().any(|t| t == tag) {
            types.push(tag.to_string());
        }
    }
    let base = NewItem {
        app_bundle_id: front.and_then(|f| f.bundle_id.clone()),
        app_name: front.and_then(|f| f.name.clone()),
        types,
        created_at: now_ms(),
        ..Default::default()
    };
    if let Some(t) = snap.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        return Some(NewItem { kind: "text".into(), preview: preview_of(t), text: Some(t.to_string()), ..base });
    }
    // A file copy in Finder carries the names as text too; when it does not, keep the paths.
    if !snap.file_paths.is_empty() {
        let joined = snap.file_paths.join("\n");
        return Some(NewItem { kind: "file".into(), preview: preview_of(&joined), text: Some(joined), ..base });
    }
    if let Some(img) = snap.image.as_ref().filter(|b| !b.is_empty() && b.len() <= MAX_IMAGE_BYTES) {
        return Some(NewItem { kind: "image".into(), preview: "Image".into(), image_png: Some(img.clone()), ..base });
    }
    None
}

/// Drop what is older than the retention setting. Returns how many went.
pub fn purge(app: &AppHandle) -> usize {
    let days = Settings::load(app).retention_days;
    if days == 0 {
        return 0;
    }
    let cutoff = now_ms() - (days as i64) * 86_400_000;
    let n = app.state::<History>().with(|s| s.purge(cutoff)).unwrap_or(0);
    if n > 0 {
        crate::log::line(format!("history: retention removed {n} item(s) older than {days} day(s)"));
        notify(app);
    }
    n
}

/// Open the store, then start polling, plus the hourly retention sweep. Returns immediately.
pub fn start(app: &AppHandle) {
    let poll_app = app.clone();
    let spawned = std::thread::Builder::new().name("pasteboard-poll".into()).spawn(move || {
        let app = poll_app;
        let t0 = std::time::Instant::now();
        let store = History::open_now(&app);
        crate::log::line(format!("history: {:?} after {} ms", store.status(), t0.elapsed().as_millis()));
        app.state::<History>().replace(store);
        purge(&app);
        notify(&app);
        let mut last = pasteboard::change_count();
        loop {
            std::thread::sleep(POLL);
            let count = pasteboard::change_count();
            if count == last {
                continue;
            }
            let snap = pasteboard::snapshot();
            // The snapshot's own count: a change between the two reads is not missed.
            last = snap.change_count.max(count);
            let front = pasteboard::frontmost_app();
            let blacklist = Settings::load(&app).blacklist;
            let Some(item) = item_from(&snap, front.as_ref(), &blacklist) else { continue };
            let stored = app.state::<History>().with(|s| s.insert(item)).flatten();
            if stored.is_some() {
                notify(&app);
            }
        }
    });
    if let Err(e) = spawned {
        crate::log::line(format!("pasteboard poller: {e}"));
    }
    let purge_app = app.clone();
    let _ = std::thread::Builder::new().name("history-retention".into()).spawn(move || loop {
        std::thread::sleep(PURGE_EVERY);
        purge(&purge_app);
    });
}

// ---- commands ----

#[tauri::command]
pub fn history_list(history: State<'_, History>, query: Option<String>, limit: Option<usize>) -> Vec<ClipItem> {
    history.with(|s| s.list(query.as_deref().unwrap_or(""), limit.unwrap_or(LIST_LIMIT).min(LIST_LIMIT))).unwrap_or_default()
}

#[tauri::command]
pub fn history_get(history: State<'_, History>, id: String) -> Option<ClipItem> {
    history.get(&id)
}

/// The newest items regardless of pins: the pick's candidates.
#[tauri::command]
pub fn history_recent(history: State<'_, History>, limit: Option<usize>) -> Vec<ClipItem> {
    history.recent(limit.unwrap_or(PICK_CANDIDATES).min(LIST_LIMIT))
}

#[tauri::command]
pub fn history_delete(app: AppHandle, history: State<'_, History>, id: String) -> bool {
    let ok = history.with(|s| s.delete(&id)).unwrap_or(false);
    notify(&app);
    ok
}

#[tauri::command]
pub fn history_pin(app: AppHandle, history: State<'_, History>, id: String, pinned: bool) -> bool {
    let ok = history.with(|s| s.pin(&id, pinned)).unwrap_or(false);
    notify(&app);
    ok
}

#[tauri::command]
pub fn history_clear(app: AppHandle, history: State<'_, History>) {
    history.with(|s| s.clear());
    notify(&app);
}

/// The 256 px thumbnail of an image item, base64 PNG for a `data:` URL.
#[tauri::command]
pub fn history_thumbnail(history: State<'_, History>, id: String) -> Result<String, String> {
    history
        .with(|s| s.thumbnail(&id))
        .flatten()
        .map(|png| base64::engine::general_purpose::STANDARD.encode(png))
        .ok_or_else(|| "no thumbnail".to_string())
}

#[derive(Serialize)]
pub struct HistoryStatus {
    #[serde(flatten)]
    pub store: StoreStatus,
    pub retention_days: u32,
}

#[tauri::command]
pub fn history_status(app: AppHandle, history: State<'_, History>) -> HistoryStatus {
    HistoryStatus { store: history.status(), retention_days: Settings::load(&app).retention_days }
}

/// Locked store: delete the database and its images, make a new key, start over.
#[tauri::command]
pub fn history_start_fresh(app: AppHandle, history: State<'_, History>) -> Result<StoreStatus, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    SqliteStore::wipe(&dir);
    let _ = secrets::set(store::KEY_SECRET, "");
    let fresh = open_store(&dir);
    let status = fresh.status();
    if let Ok(mut s) = history.0.lock() {
        *s = fresh;
    }
    crate::log::line(format!("history: started fresh: {status:?}"));
    notify(&app);
    Ok(status)
}
