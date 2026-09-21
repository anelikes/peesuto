//! Clipboard history storage. `HistoryStore` is what the poller and the
//! panel use; `SqliteStore` is the real one, `MemoryStore` serves tests.
//!
//! `SqliteStore` keeps `<app data>/history.sqlite` with every user-visible
//! field encrypted: `text` and `preview` are AES-256-GCM blobs (12-byte
//! nonce ‖ ciphertext) under a 32-byte key that lives only in the Keychain
//! (`KEY_SECRET`, base64). Image items keep the PNG and a 256 px thumbnail
//! as encrypted files under `<app data>/images/`. What stays in the clear is
//! what the exclusion rules and retention need: kind, app, time, pinned,
//! size. Search decrypts the newest `SEARCH_WINDOW` rows and filters them.
//!
//! When the Keychain item is gone but the database is still there the store
//! is *locked*: nothing can be read or recorded, the panel says so, and
//! `clipboard::history_start_fresh` deletes the database and makes a new key.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    io::Cursor,
    path::{Path, PathBuf},
};

pub const DB_NAME: &str = "history.sqlite";
pub const IMAGES_DIR: &str = "images";
/// Keychain item holding the base64 key.
pub const KEY_SECRET: &str = "pocket-paste/history-key";
pub const THUMB_PX: u32 = 256;
/// Rows a search decrypts (newest first).
pub const SEARCH_WINDOW: usize = 500;
/// Rows kept at most; the oldest unpinned go first.
pub const CAPACITY: usize = 500;
const NONCE_LEN: usize = 12;

pub type Key = [u8; 32];

/// One entry of the history, in the shape Core's `ClipItem` expects (camelCase),
/// plus what the panel shows (`appName`, `types`, `image`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub id: String,
    /// text | image | file
    pub kind: String,
    /// Full text for text and file items; absent for images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// First line, collapsed, for the list; `Image W×H` for images.
    pub preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    pub pinned: bool,
    /// Text bytes, or the PNG size.
    pub bytes: u64,
    /// Other representations that were on the pasteboard: rtf, html, image, file-url.
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
}

/// What the poller hands the store.
#[derive(Clone, Debug, Default)]
pub struct NewItem {
    pub kind: String,
    pub text: Option<String>,
    pub preview: String,
    pub app_bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub types: Vec<String>,
    /// PNG bytes for an image item.
    pub image_png: Option<Vec<u8>>,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum StoreStatus {
    Ok { items: usize },
    /// The database exists but its key is not in the Keychain.
    Locked { detail: String },
    Memory,
    /// Still opening: the Keychain may be asking the user to allow access.
    Opening,
}

pub trait HistoryStore: Send {
    fn status(&self) -> StoreStatus;
    /// Pinned first, then newest first; `query` is a case-insensitive substring filter.
    fn list(&self, query: &str, limit: usize) -> Vec<ClipItem>;
    /// Newest first regardless of pins: the pick's candidates.
    fn recent(&self, limit: usize) -> Vec<ClipItem>;
    fn get(&self, id: &str) -> Option<ClipItem>;
    /// Insert at the top; an existing item with the same text moves up instead.
    /// `None` when the store is locked.
    fn insert(&mut self, item: NewItem) -> Option<ClipItem>;
    fn delete(&mut self, id: &str) -> bool;
    fn pin(&mut self, id: &str, pinned: bool) -> bool;
    fn clear(&mut self);
    /// Remove unpinned items created before `cutoff_ms`; returns how many went.
    fn purge(&mut self, cutoff_ms: i64) -> usize;
    /// The 256 px PNG of an image item.
    fn thumbnail(&self, id: &str) -> Option<Vec<u8>>;
    /// The full PNG of an image item.
    fn image(&self, id: &str) -> Option<Vec<u8>>;
}

// ---- helpers shared by the stores ----

pub fn new_id() -> String {
    let mut b = [0u8; 12];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn new_key() -> Key {
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    k
}

fn matches(item: &ClipItem, q: &str) -> bool {
    if q.is_empty() {
        return true;
    }
    item.text.as_deref().map(|t| t.to_lowercase().contains(q)).unwrap_or(false) || item.preview.to_lowercase().contains(q)
}

/// Decode any supported image (PNG or TIFF) into PNG bytes plus its size.
pub fn to_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    if image::guess_format(bytes).ok() == Some(image::ImageFormat::Png) {
        return Some((bytes.to_vec(), w, h));
    }
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    Some((out, w, h))
}

pub fn image_preview(w: u32, h: u32) -> String {
    format!("Image {w}×{h}")
}

fn thumbnail_png(png: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(png).ok()?;
    let t = img.thumbnail(THUMB_PX, THUMB_PX);
    let mut out = Vec::new();
    t.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    Some(out)
}

// ---- crypto ----

pub struct Crypto {
    cipher: Aes256Gcm,
}

impl Crypto {
    pub fn new(key: &Key) -> Self {
        Crypto { cipher: Aes256Gcm::new(key.into()) }
    }

    /// nonce ‖ ciphertext
    pub fn seal(&self, plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let ct = self.cipher.encrypt(Nonce::from_slice(&nonce), plain).expect("aes-gcm encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    pub fn open(&self, blob: &[u8]) -> Option<Vec<u8>> {
        if blob.len() < NONCE_LEN {
            return None;
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        self.cipher.decrypt(Nonce::from_slice(nonce), ct).ok()
    }

    fn seal_str(&self, s: &str) -> Vec<u8> {
        self.seal(s.as_bytes())
    }

    fn open_str(&self, blob: &[u8]) -> Option<String> {
        self.open(blob).and_then(|b| String::from_utf8(b).ok())
    }
}

// ---- SQLite ----

pub struct SqliteStore {
    conn: Connection,
    crypto: Crypto,
    images: PathBuf,
}

/// Outcome of looking for the database with whatever key was available.
pub enum Opened {
    Store(SqliteStore),
    /// A database exists but no key was given.
    Locked,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text BLOB,
  preview BLOB NOT NULL,
  app_bundle_id TEXT,
  app_name TEXT,
  types TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  image_path TEXT,
  image_w INTEGER,
  image_h INTEGER
);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at DESC);
";

const COLUMNS: &str = "id, kind, text, preview, app_bundle_id, app_name, types, created_at, pinned, bytes, image_path, image_w, image_h";

impl SqliteStore {
    /// Open (creating) the database at `db` with `key`; image files go under `images`.
    pub fn open(db: &Path, images: &Path, key: &Key) -> Result<SqliteStore, String> {
        if let Some(dir) = db.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::create_dir_all(images).map_err(|e| e.to_string())?;
        let conn = Connection::open(db).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;").map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(SqliteStore { conn, crypto: Crypto::new(key), images: images.to_path_buf() })
    }

    /// `open` when a key is at hand; `Locked` when there is none but a database exists.
    pub fn open_with(app_data: &Path, key: Option<&Key>) -> Result<Opened, String> {
        let db = app_data.join(DB_NAME);
        match key {
            Some(k) => Self::open(&db, &app_data.join(IMAGES_DIR), k).map(Opened::Store),
            None if db.exists() => Ok(Opened::Locked),
            None => Err("no key".into()),
        }
    }

    /// Delete the database and every image file: the "start fresh" path.
    pub fn wipe(app_data: &Path) {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(app_data.join(format!("{DB_NAME}{suffix}")));
        }
        let _ = std::fs::remove_dir_all(app_data.join(IMAGES_DIR));
    }

    fn row(&self, r: &rusqlite::Row<'_>) -> rusqlite::Result<ClipItem> {
        let text: Option<Vec<u8>> = r.get(2)?;
        let preview: Vec<u8> = r.get(3)?;
        let types: String = r.get(6)?;
        let w: Option<u32> = r.get(11)?;
        let h: Option<u32> = r.get(12)?;
        Ok(ClipItem {
            id: r.get(0)?,
            kind: r.get(1)?,
            text: text.and_then(|t| self.crypto.open_str(&t)),
            preview: self.crypto.open_str(&preview).unwrap_or_else(|| "(unreadable)".into()),
            app_bundle_id: r.get(4)?,
            app_name: r.get(5)?,
            types: types.split(',').filter(|s| !s.is_empty()).map(String::from).collect(),
            created_at: r.get(7)?,
            pinned: r.get::<_, i64>(8)? != 0,
            bytes: r.get::<_, i64>(9)? as u64,
            image: w.zip(h).map(|(width, height)| ImageInfo { width, height }),
        })
    }

    fn select(&self, order: &str, limit: usize) -> Vec<ClipItem> {
        let sql = format!("SELECT {COLUMNS} FROM items ORDER BY {order} LIMIT ?1");
        let Ok(mut st) = self.conn.prepare(&sql) else { return Vec::new() };
        let rows = st.query_map(params![limit as i64], |r| self.row(r));
        rows.map(|it| it.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    fn image_files(&self, id: &str) -> [PathBuf; 2] {
        [self.images.join(format!("{id}.bin")), self.images.join(format!("{id}.thumb.bin"))]
    }

    fn remove_files(&self, id: &str) {
        for f in self.image_files(id) {
            let _ = std::fs::remove_file(f);
        }
    }

    fn read_file(&self, path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok().and_then(|b| self.crypto.open(&b))
    }

    /// An existing text item with the same content (only rows of the same size are decrypted).
    fn find_duplicate(&self, kind: &str, text: &str) -> Option<String> {
        let mut st = self
            .conn
            .prepare("SELECT id, text FROM items WHERE kind = ?1 AND bytes = ?2 ORDER BY created_at DESC")
            .ok()?;
        let rows = st
            .query_map(params![kind, text.len() as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<Vec<u8>>>(1)?)))
            .ok()?;
        for (id, blob) in rows.flatten() {
            if blob.and_then(|b| self.crypto.open_str(&b)).as_deref() == Some(text) {
                return Some(id);
            }
        }
        None
    }

    fn trim(&mut self) {
        let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap_or(0);
        let excess = count.saturating_sub(CAPACITY as i64);
        if excess <= 0 {
            return;
        }
        let ids: Vec<String> = self
            .conn
            .prepare("SELECT id FROM items WHERE pinned = 0 ORDER BY created_at ASC LIMIT ?1")
            .and_then(|mut st| st.query_map(params![excess], |r| r.get(0)).map(|it| it.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        for id in ids {
            self.delete(&id);
        }
    }
}

impl HistoryStore for SqliteStore {
    fn status(&self) -> StoreStatus {
        let items: i64 = self.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0)).unwrap_or(0);
        StoreStatus::Ok { items: items as usize }
    }

    fn list(&self, query: &str, limit: usize) -> Vec<ClipItem> {
        let q = query.trim().to_lowercase();
        let window = if q.is_empty() { limit } else { SEARCH_WINDOW };
        let mut all = self.select("pinned DESC, created_at DESC", window);
        if !q.is_empty() {
            all.retain(|i| matches(i, &q));
            all.truncate(limit);
        }
        all
    }

    fn recent(&self, limit: usize) -> Vec<ClipItem> {
        self.select("created_at DESC", limit)
    }

    fn get(&self, id: &str) -> Option<ClipItem> {
        let sql = format!("SELECT {COLUMNS} FROM items WHERE id = ?1");
        self.conn.query_row(&sql, params![id], |r| self.row(r)).optional().ok().flatten()
    }

    fn insert(&mut self, item: NewItem) -> Option<ClipItem> {
        if let Some(text) = item.text.as_deref() {
            if let Some(existing) = self.find_duplicate(&item.kind, text) {
                let _ = self.conn.execute(
                    "UPDATE items SET created_at = ?2, app_bundle_id = COALESCE(app_bundle_id, ?3), app_name = COALESCE(app_name, ?4) WHERE id = ?1",
                    params![existing, item.created_at, item.app_bundle_id, item.app_name],
                );
                return self.get(&existing);
            }
        }
        let id = new_id();
        let mut bytes = item.text.as_deref().map(|t| t.len() as i64).unwrap_or(0);
        let mut image_path: Option<String> = None;
        let mut size: Option<(u32, u32)> = None;
        let mut preview = item.preview.clone();
        if let Some(png) = item.image_png.as_deref() {
            let (png, w, h) = to_png(png)?;
            let thumb = thumbnail_png(&png)?;
            let [full, small] = self.image_files(&id);
            std::fs::write(&full, self.crypto.seal(&png)).ok()?;
            std::fs::write(&small, self.crypto.seal(&thumb)).ok()?;
            bytes = png.len() as i64;
            image_path = Some(format!("{id}.bin"));
            size = Some((w, h));
            preview = image_preview(w, h);
        }
        let ok = self
            .conn
            .execute(
                &format!("INSERT INTO items ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12)"),
                params![
                    id,
                    item.kind,
                    item.text.as_deref().map(|t| self.crypto.seal_str(t)),
                    self.crypto.seal_str(&preview),
                    item.app_bundle_id,
                    item.app_name,
                    item.types.join(","),
                    item.created_at,
                    bytes,
                    image_path,
                    size.map(|s| s.0),
                    size.map(|s| s.1),
                ],
            )
            .is_ok();
        if !ok {
            self.remove_files(&id);
            return None;
        }
        self.trim();
        self.get(&id)
    }

    fn delete(&mut self, id: &str) -> bool {
        let n = self.conn.execute("DELETE FROM items WHERE id = ?1", params![id]).unwrap_or(0);
        self.remove_files(id);
        n > 0
    }

    fn pin(&mut self, id: &str, pinned: bool) -> bool {
        self.conn.execute("UPDATE items SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64]).unwrap_or(0) > 0
    }

    fn clear(&mut self) {
        let _ = self.conn.execute("DELETE FROM items", []);
        if let Ok(entries) = std::fs::read_dir(&self.images) {
            for e in entries.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let _ = self.conn.execute_batch("VACUUM");
    }

    fn purge(&mut self, cutoff_ms: i64) -> usize {
        let ids: Vec<String> = self
            .conn
            .prepare("SELECT id FROM items WHERE pinned = 0 AND created_at < ?1")
            .and_then(|mut st| st.query_map(params![cutoff_ms], |r| r.get(0)).map(|it| it.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let n = ids.len();
        for id in ids {
            self.delete(&id);
        }
        n
    }

    fn thumbnail(&self, id: &str) -> Option<Vec<u8>> {
        let [_, small] = self.image_files(id);
        self.read_file(&small)
    }

    fn image(&self, id: &str) -> Option<Vec<u8>> {
        let [full, _] = self.image_files(id);
        self.read_file(&full)
    }
}

// ---- locked / opening ----

/// Stands in while the key is missing: reads nothing, records nothing.
/// With `detail` empty it is the "still opening" placeholder.
pub struct LockedStore {
    pub detail: String,
}

impl HistoryStore for LockedStore {
    fn status(&self) -> StoreStatus {
        if self.detail.is_empty() {
            StoreStatus::Opening
        } else {
            StoreStatus::Locked { detail: self.detail.clone() }
        }
    }
    fn list(&self, _: &str, _: usize) -> Vec<ClipItem> {
        Vec::new()
    }
    fn recent(&self, _: usize) -> Vec<ClipItem> {
        Vec::new()
    }
    fn get(&self, _: &str) -> Option<ClipItem> {
        None
    }
    fn insert(&mut self, _: NewItem) -> Option<ClipItem> {
        None
    }
    fn delete(&mut self, _: &str) -> bool {
        false
    }
    fn pin(&mut self, _: &str, _: bool) -> bool {
        false
    }
    fn clear(&mut self) {}
    fn purge(&mut self, _: i64) -> usize {
        0
    }
    fn thumbnail(&self, _: &str) -> Option<Vec<u8>> {
        None
    }
    fn image(&self, _: &str) -> Option<Vec<u8>> {
        None
    }
}

// ---- memory ----

#[derive(Default)]
pub struct MemoryStore {
    /// Newest first.
    items: Vec<ClipItem>,
    images: Vec<(String, Vec<u8>, Vec<u8>)>,
}

impl HistoryStore for MemoryStore {
    fn status(&self) -> StoreStatus {
        StoreStatus::Memory
    }

    fn list(&self, query: &str, limit: usize) -> Vec<ClipItem> {
        let q = query.trim().to_lowercase();
        let pinned = self.items.iter().filter(|i| i.pinned).filter(|i| matches(i, &q));
        let rest = self.items.iter().filter(|i| !i.pinned).filter(|i| matches(i, &q));
        pinned.chain(rest).take(limit).cloned().collect()
    }

    fn recent(&self, limit: usize) -> Vec<ClipItem> {
        self.items.iter().take(limit).cloned().collect()
    }

    fn get(&self, id: &str) -> Option<ClipItem> {
        self.items.iter().find(|i| i.id == id).cloned()
    }

    fn insert(&mut self, item: NewItem) -> Option<ClipItem> {
        if item.text.is_some() {
            if let Some(pos) = self.items.iter().position(|i| i.kind == item.kind && i.text == item.text) {
                let mut existing = self.items.remove(pos);
                existing.created_at = item.created_at;
                if existing.app_bundle_id.is_none() {
                    existing.app_bundle_id = item.app_bundle_id;
                    existing.app_name = item.app_name;
                }
                self.items.insert(0, existing.clone());
                return Some(existing);
            }
        }
        let id = new_id();
        let mut bytes = item.text.as_deref().map(|t| t.len() as u64).unwrap_or(0);
        let mut image = None;
        let mut preview = item.preview;
        if let Some(png) = item.image_png.as_deref() {
            let (png, width, height) = to_png(png)?;
            let thumb = thumbnail_png(&png)?;
            bytes = png.len() as u64;
            preview = image_preview(width, height);
            image = Some(ImageInfo { width, height });
            self.images.push((id.clone(), png, thumb));
        }
        let it = ClipItem {
            id,
            kind: item.kind,
            text: item.text,
            preview,
            app_bundle_id: item.app_bundle_id,
            app_name: item.app_name,
            created_at: item.created_at,
            pinned: false,
            bytes,
            types: item.types,
            image,
        };
        self.items.insert(0, it.clone());
        while self.items.len() > CAPACITY {
            match self.items.iter().rposition(|i| !i.pinned) {
                Some(p) => {
                    let gone = self.items.remove(p);
                    self.images.retain(|(id, _, _)| *id != gone.id);
                }
                None => break,
            }
        }
        Some(it)
    }

    fn delete(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|i| i.id != id);
        self.images.retain(|(i, _, _)| i != id);
        self.items.len() != before
    }

    fn pin(&mut self, id: &str, pinned: bool) -> bool {
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
        self.images.clear();
    }

    fn purge(&mut self, cutoff_ms: i64) -> usize {
        let before = self.items.len();
        self.items.retain(|i| i.pinned || i.created_at >= cutoff_ms);
        let keep: Vec<String> = self.items.iter().map(|i| i.id.clone()).collect();
        self.images.retain(|(id, _, _)| keep.contains(id));
        before - self.items.len()
    }

    fn thumbnail(&self, id: &str) -> Option<Vec<u8>> {
        self.images.iter().find(|(i, _, _)| i == id).map(|(_, _, t)| t.clone())
    }

    fn image(&self, id: &str) -> Option<Vec<u8>> {
        self.images.iter().find(|(i, _, _)| i == id).map(|(_, p, _)| p.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!("pocket-paste-store-{}", new_id()));
            std::fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn text_item(text: &str, at: i64) -> NewItem {
        NewItem {
            kind: "text".into(),
            text: Some(text.into()),
            preview: text.lines().next().unwrap_or("").into(),
            app_bundle_id: Some("com.apple.Notes".into()),
            app_name: Some("Notes".into()),
            types: vec!["rtf".into()],
            image_png: None,
            created_at: at,
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba([200, 30, 30, 255])));
        let mut out = Vec::new();
        img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png).unwrap();
        out
    }

    fn open(dir: &TempDir, key: &Key) -> SqliteStore {
        SqliteStore::open(&dir.0.join(DB_NAME), &dir.0.join(IMAGES_DIR), key).unwrap()
    }

    #[test]
    fn crypto_round_trip_and_tamper() {
        let c = Crypto::new(&new_key());
        let blob = c.seal(b"secret text");
        assert_eq!(c.open(&blob).unwrap(), b"secret text");
        let mut bad = blob.clone();
        bad[NONCE_LEN + 1] ^= 1;
        assert!(c.open(&bad).is_none());
        assert!(Crypto::new(&new_key()).open(&blob).is_none());
    }

    #[test]
    fn round_trip_without_plaintext_on_disk() {
        let dir = TempDir::new();
        let key = new_key();
        let marker = "MARKER-7f3a9c-do-not-leak";
        {
            let mut s = open(&dir, &key);
            let it = s.insert(text_item(&format!("{marker}\nsecond line"), 1_000)).unwrap();
            assert_eq!(it.kind, "text");
            assert_eq!(it.preview, marker);
            assert_eq!(it.bytes, (marker.len() + "\nsecond line".len()) as u64);
            assert_eq!(s.get(&it.id).unwrap(), it);
            assert_eq!(s.list("", 50).len(), 1);
            // Same text again moves up instead of duplicating.
            let again = s.insert(text_item(&format!("{marker}\nsecond line"), 2_000)).unwrap();
            assert_eq!(again.id, it.id);
            assert_eq!(again.created_at, 2_000);
            assert_eq!(s.list("", 50).len(), 1);
            s.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        }
        let raw = std::fs::read(dir.0.join(DB_NAME)).unwrap();
        assert!(!raw.windows(marker.len()).any(|w| w == marker.as_bytes()), "plaintext in the database file");
        // Reopen with the same key: still readable; another key: not.
        let s = open(&dir, &key);
        assert_eq!(s.list("", 50)[0].text.as_deref().unwrap().lines().next().unwrap(), marker);
        let other = open(&dir, &new_key());
        let items = other.list("", 50);
        assert_eq!(items.len(), 1);
        assert!(items[0].text.is_none());
        assert_eq!(items[0].preview, "(unreadable)");
    }

    #[test]
    fn search_pins_and_order() {
        let dir = TempDir::new();
        let mut s = open(&dir, &new_key());
        let a = s.insert(text_item("alpha beta", 1)).unwrap();
        let b = s.insert(text_item("gamma", 2)).unwrap();
        let c = s.insert(text_item("delta BETA", 3)).unwrap();
        let ids = |v: Vec<ClipItem>| v.into_iter().map(|i| i.id).collect::<Vec<_>>();
        assert_eq!(ids(s.list("", 50)), vec![c.id.clone(), b.id.clone(), a.id.clone()]);
        assert_eq!(ids(s.list("beta", 50)), vec![c.id.clone(), a.id.clone()]);
        assert!(s.pin(&a.id, true));
        assert_eq!(ids(s.list("", 50)), vec![a.id.clone(), c.id.clone(), b.id.clone()]);
        assert_eq!(ids(s.recent(2)), vec![c.id.clone(), b.id.clone()]);
        assert_eq!(ids(s.list("", 1)), vec![a.id.clone()]);
        assert!(s.delete(&b.id));
        assert!(!s.delete(&b.id));
        assert_eq!(s.status(), StoreStatus::Ok { items: 2 });
    }

    #[test]
    fn purge_keeps_pinned_and_recent() {
        let dir = TempDir::new();
        let mut s = open(&dir, &new_key());
        let old = s.insert(text_item("old", 100)).unwrap();
        let old_pinned = s.insert(text_item("old pinned", 100)).unwrap();
        s.pin(&old_pinned.id, true);
        let fresh = s.insert(text_item("fresh", 10_000)).unwrap();
        assert_eq!(s.purge(5_000), 1);
        assert!(s.get(&old.id).is_none());
        assert!(s.get(&old_pinned.id).is_some());
        assert!(s.get(&fresh.id).is_some());
    }

    #[test]
    fn images_are_encrypted_files_and_go_with_the_item() {
        let dir = TempDir::new();
        let mut s = open(&dir, &new_key());
        let it = s
            .insert(NewItem { kind: "image".into(), preview: "Image".into(), image_png: Some(png(600, 300)), created_at: 5, ..Default::default() })
            .unwrap();
        assert_eq!(it.image, Some(ImageInfo { width: 600, height: 300 }));
        assert_eq!(it.preview, "Image 600×300");
        assert!(it.text.is_none());
        let files = dir.0.join(IMAGES_DIR);
        assert_eq!(std::fs::read_dir(&files).unwrap().count(), 2);
        let raw = std::fs::read(files.join(format!("{}.bin", it.id))).unwrap();
        assert_ne!(&raw[..8], b"\x89PNG\r\n\x1a\n", "image file is not encrypted");
        let thumb = s.thumbnail(&it.id).unwrap();
        let t = image::load_from_memory(&thumb).unwrap();
        assert_eq!((t.width(), t.height()), (256, 128));
        assert_eq!(s.image(&it.id).unwrap().len() as u64, it.bytes);
        assert!(s.delete(&it.id));
        assert_eq!(std::fs::read_dir(&files).unwrap().count(), 0);
        s.insert(NewItem { kind: "image".into(), preview: "Image".into(), image_png: Some(png(8, 8)), created_at: 6, ..Default::default() }).unwrap();
        s.insert(text_item("t", 7)).unwrap();
        s.clear();
        assert_eq!(s.status(), StoreStatus::Ok { items: 0 });
        assert_eq!(std::fs::read_dir(&files).unwrap().count(), 0);
    }

    #[test]
    fn locked_when_the_key_is_gone() {
        let dir = TempDir::new();
        assert!(SqliteStore::open_with(&dir.0, None).is_err(), "nothing to lock yet");
        let key = new_key();
        match SqliteStore::open_with(&dir.0, Some(&key)).unwrap() {
            Opened::Store(mut s) => {
                s.insert(text_item("kept", 1)).unwrap();
            }
            Opened::Locked => panic!("should open with a key"),
        }
        assert!(matches!(SqliteStore::open_with(&dir.0, None).unwrap(), Opened::Locked));
        let mut locked = LockedStore { detail: "no key".into() };
        assert!(locked.insert(text_item("x", 2)).is_none());
        assert!(locked.list("", 10).is_empty());
        assert_eq!(locked.status(), StoreStatus::Locked { detail: "no key".into() });
        SqliteStore::wipe(&dir.0);
        assert!(SqliteStore::open_with(&dir.0, None).is_err(), "wiped: nothing to lock");
    }

    #[test]
    fn memory_store_behaves_alike() {
        let mut m = MemoryStore::default();
        let a = m.insert(text_item("one", 1)).unwrap();
        let again = m.insert(text_item("one", 2)).unwrap();
        assert_eq!(a.id, again.id);
        m.insert(text_item("two", 3)).unwrap();
        assert_eq!(m.list("ONE", 10).len(), 1);
        assert_eq!(m.purge(2), 0);
        assert_eq!(m.purge(3), 1);
        assert_eq!(m.status(), StoreStatus::Memory);
    }
}
