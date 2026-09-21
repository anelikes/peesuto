//! The app log: every line goes to stderr (visible under `tauri dev`) and,
//! once `init` has run, to `<app data>/app.log` — where Core's stderr ends
//! up too, so a bug report has one file to attach.

use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
    sync::{Mutex, OnceLock},
};

static FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

pub const NAME: &str = "app.log";

pub fn init(app_data: &Path) {
    let _ = std::fs::create_dir_all(app_data);
    let file = OpenOptions::new().create(true).append(true).open(app_data.join(NAME)).ok();
    let _ = FILE.set(Mutex::new(file));
}

pub fn line(msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    eprintln!("pocket-paste: {msg}");
    if let Some(f) = FILE.get() {
        if let Ok(mut f) = f.lock() {
            if let Some(f) = f.as_mut() {
                let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
                let _ = writeln!(f, "{stamp} {msg}");
            }
        }
    }
}
