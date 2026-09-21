//! Clipboard history: a background thread polls the pasteboard's changeCount
//! every 250 ms and records new text items, and the `history` panel reads
//! them through the commands below.
//!
//! Storage is behind `HistoryStore`; the only implementation today keeps
//! items in memory. TODO(M1): SQLite with field-level encryption (key in the
//! Keychain), retention, image thumbnails — swap `MemoryStore` for it in
//! `History::new`.

use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::pasteboard;

pub const POLL: Duration = Duration::from_millis(250);
pub const CAPACITY: usize = 500;
pub const EVENT: &str = "history:changed";

/// Apps whose copies never enter the history.
pub const BLACKLIST: &[&str] = &[
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.apple.keychainaccess",
];

#[derive(Clone, Debug, Serialize)]
pub struct ClipItem {
    pub id: u64,
    /// text | file
    pub kind: String,
    pub text: String,
    /// First line, collapsed, for the list.
    pub preview: String,
    /// Other representations that were on the pasteboard: rtf, html, image, file-url.
    pub types: Vec<String>,
    pub app_bundle_id: Option<String>,
    pub app_name: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    pub pinned: bool,
}

pub trait HistoryStore: Send {
    /// Pinned first, then newest first; `query` is a case-insensitive substring filter.
    fn list(&self, query: &str) -> Vec<ClipItem>;
    fn get(&self, id: u64) -> Option<ClipItem>;
    /// Insert at the top; an existing item with the same text moves up instead.
    fn insert(&mut self, item: ClipItem) -> ClipItem;
    fn delete(&mut self, id: u64) -> bool;
    fn pin(&mut self, id: u64, pinned: bool) -> bool;
    fn clear(&mut self);
}

#[derive(Default)]
pub struct MemoryStore {
    /// Newest first.
    items: Vec<ClipItem>,
    next_id: u64,
}

impl HistoryStore for MemoryStore {
    fn list(&self, query: &str) -> Vec<ClipItem> {
        let q = query.trim().to_lowercase();
        let matches = |i: &&ClipItem| q.is_empty() || i.text.to_lowercase().contains(&q);
        let pinned = self.items.iter().filter(|i| i.pinned).filter(matches);
        let rest = self.items.iter().filter(|i| !i.pinned).filter(matches);
        pinned.chain(rest).cloned().collect()
    }

    fn get(&self, id: u64) -> Option<ClipItem> {
        self.items.iter().find(|i| i.id == id).cloned()
    }

    fn insert(&mut self, mut item: ClipItem) -> ClipItem {
        if let Some(pos) = self.items.iter().position(|i| i.text == item.text) {
            let mut existing = self.items.remove(pos);
            existing.created_at = item.created_at;
            if existing.app_bundle_id.is_none() {
                existing.app_bundle_id = item.app_bundle_id;
                existing.app_name = item.app_name;
            }
            self.items.insert(0, existing.clone());
            return existing;
        }
        self.next_id += 1;
        item.id = self.next_id;
        self.items.insert(0, item.clone());
        while self.items.len() > CAPACITY {
            // Drop the oldest unpinned item.
            match self.items.iter().rposition(|i| !i.pinned) {
                Some(p) => {
                    self.items.remove(p);
                }
                None => break,
            }
        }
        item
    }

    fn delete(&mut self, id: u64) -> bool {
        let before = self.items.len();
        self.items.retain(|i| i.id != id);
        self.items.len() != before
    }

    fn pin(&mut self, id: u64, pinned: bool) -> bool {
        match self.items.iter_mut().find(|i| i.id == id) {
            Some(i) => {
                i.pinned = pinned;
                true
            }
            None => false,
        }
    }

    fn clear(&mut self) {
        self.items.clear();
    }
}

pub struct History(pub Mutex<Box<dyn HistoryStore>>);

impl History {
    pub fn new() -> Self {
        History(Mutex::new(Box::new(MemoryStore::default())))
    }

    pub fn get(&self, id: u64) -> Option<ClipItem> {
        self.0.lock().ok().and_then(|s| s.get(id))
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

fn notify(app: &AppHandle) {
    let _ = app.emit_to("history", EVENT, ());
}

/// Turn a pasteboard reading into a history item, or `None` when it must be skipped.
fn item_from(snap: &pasteboard::Snapshot, front: Option<&pasteboard::FrontApp>) -> Option<ClipItem> {
    if snap.concealed || snap.transient {
        return None;
    }
    if let Some(b) = front.and_then(|f| f.bundle_id.as_deref()) {
        if BLACKLIST.contains(&b) {
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
    let (kind, text) = match snap.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => ("text", t.to_string()),
        // A file copy in Finder carries the names as text too; when it does not, keep the paths.
        None if !snap.file_paths.is_empty() => ("file", snap.file_paths.join("\n")),
        // TODO: image-only copies (screenshots) once thumbnails have a home on disk.
        None => return None,
    };
    Some(ClipItem {
        id: 0,
        kind: kind.into(),
        preview: preview_of(&text),
        text,
        types,
        app_bundle_id: front.and_then(|f| f.bundle_id.clone()),
        app_name: front.and_then(|f| f.name.clone()),
        created_at: now_ms(),
        pinned: false,
    })
}

/// Start the polling thread. Returns immediately.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("pasteboard-poll".into()).spawn(move || {
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
            let Some(item) = item_from(&snap, front.as_ref()) else { continue };
            if let Ok(mut store) = app.state::<History>().0.lock() {
                store.insert(item);
            }
            notify(&app);
        }
    });
    if let Err(e) = spawned {
        eprintln!("pocket-paste: pasteboard poller: {e}");
    }
}

// ---- commands ----

#[tauri::command]
pub fn history_list(history: State<'_, History>, query: Option<String>) -> Vec<ClipItem> {
    history.0.lock().map(|s| s.list(query.as_deref().unwrap_or(""))).unwrap_or_default()
}

#[tauri::command]
pub fn history_delete(app: AppHandle, history: State<'_, History>, id: u64) -> bool {
    let ok = history.0.lock().map(|mut s| s.delete(id)).unwrap_or(false);
    notify(&app);
    ok
}

#[tauri::command]
pub fn history_pin(app: AppHandle, history: State<'_, History>, id: u64, pinned: bool) -> bool {
    let ok = history.0.lock().map(|mut s| s.pin(id, pinned)).unwrap_or(false);
    notify(&app);
    ok
}

#[tauri::command]
pub fn history_clear(app: AppHandle, history: State<'_, History>) {
    if let Ok(mut s) = history.0.lock() {
        s.clear();
    }
    notify(&app);
}
