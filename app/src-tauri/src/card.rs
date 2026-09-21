//! The "Paste as card" action: text → sidecar → clipboard image → `result`
//! window. State the result window needs between runs (the last text, the
//! last state) lives here.

use serde::Serialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    clipboard::History,
    pasteboard,
    settings::Settings,
    sidecar::{self, PasteArgs, PasteError, PasteResult},
    windows,
};

const EVENT: &str = "result:state";
pub const TEST_TEXT: &str = "Hello, pocket-paste";

#[derive(Default)]
pub struct CardState {
    last_text: Mutex<Option<String>>,
    last_state: Mutex<Option<ResultState>>,
    /// The result window stays up on blur while this is set (a save dialog is open).
    pub hold: AtomicBool,
    busy: AtomicBool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ResultState {
    Working { text: String, aspect: String },
    Ready { result: PasteResult, copied: String, aspect: String, text: String },
    Error { kind: String, message: String, aspect: String, text: String },
}

fn publish(app: &AppHandle, st: ResultState) {
    if let Ok(mut last) = app.state::<CardState>().last_state.lock() {
        *last = Some(st.clone());
    }
    let _ = app.emit_to("result", EVENT, st);
}

/// The tray item: whatever text is on the clipboard now.
pub async fn card_from_clipboard(app: AppHandle) {
    let text = app.clipboard().read_text().unwrap_or_default();
    if text.trim().is_empty() {
        let aspect = Settings::load(&app).aspect;
        publish(
            &app,
            ResultState::Error {
                kind: "empty".into(),
                message: "Copy some text first.".into(),
                aspect,
                text: String::new(),
            },
        );
        windows::show_result(&app);
        return;
    }
    card_from_text(app, text, None).await;
}

pub async fn card_from_text(app: AppHandle, text: String, aspect: Option<String>) {
    let settings = Settings::load(&app);
    let aspect = aspect.unwrap_or_else(|| settings.aspect.clone());
    let state = app.state::<CardState>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return; // a render is already running; the window shows it
    }
    if let Ok(mut t) = state.last_text.lock() {
        *t = Some(text.clone());
    }
    publish(&app, ResultState::Working { text: text.clone(), aspect: aspect.clone() });
    windows::show_result(&app);

    let next = match render(&app, &settings, &text, &aspect).await {
        Ok(result) => {
            let copied = copy_to_clipboard(&app, Path::new(&result.path), &result.format).unwrap_or_else(|e| {
                eprintln!("pocket-paste: clipboard: {e}");
                "none"
            });
            ResultState::Ready { result, copied: copied.into(), aspect, text }
        }
        Err(e) => ResultState::Error { kind: e.kind, message: e.message, aspect, text },
    };
    state.busy.store(false, Ordering::SeqCst);
    publish(&app, next);
    windows::show_result(&app);
}

async fn render(app: &AppHandle, settings: &Settings, text: &str, aspect: &str) -> Result<PasteResult, PasteError> {
    let paths = sidecar::paths(app)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let out = paths.cards.join(format!("{stamp}.png"));
    sidecar::run_paste(app, settings, PasteArgs { text: text.into(), aspect: aspect.into(), out }).await
}

/// PNG goes through the clipboard-manager plugin as an image. A GIF cannot —
/// the plugin (arboard) only carries raw RGBA, which would flatten the
/// animation — so it is written to NSPasteboard as a file URL plus the GIF
/// bytes (`pasteboard::write_file`); a paste into Finder, Slack or Mail drops
/// the file. If even that fails the path is copied as text.
/// Returns how it ended up there: `image`, `file`, or `path`.
pub fn copy_to_clipboard(app: &AppHandle, path: &Path, format: &str) -> Result<&'static str, String> {
    if format == "gif" {
        if pasteboard::write_file(path, Some("com.compuserve.gif")) {
            return Ok("file");
        }
        app.clipboard().write_text(path.display().to_string()).map_err(|e| e.to_string())?;
        return Ok("path");
    }
    let image = tauri::image::Image::from_path(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    app.clipboard().write_image(&image).map_err(|e| e.to_string())?;
    Ok("image")
}

/// Dev aid: `POCKET_PASTE_AUTORUN=card|history[:<ms>] bun tauri dev` drives
/// the app shortly after launch, so a window can be checked without the shortcut.
pub fn autorun_if_requested(app: &AppHandle) {
    let Some(spec) = std::env::var("POCKET_PASTE_AUTORUN").ok().filter(|_| cfg!(debug_assertions)) else { return };
    // `card`, `history`, or either with `:<delay ms>`.
    let (mode, delay) = spec.split_once(':').unwrap_or((spec.as_str(), "1500"));
    let (mode, delay) = (mode.to_string(), delay.parse::<u64>().unwrap_or(1500));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sleep(std::time::Duration::from_millis(delay)).await;
        match mode.as_str() {
            "card" => {
                let _ = app.clipboard().write_text(TEST_TEXT);
                card_from_clipboard(app).await;
            }
            _ => windows::show_history(&app),
        }
    });
}

async fn sleep(d: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

// ---- commands ----

#[tauri::command]
pub async fn card_now(app: AppHandle) {
    card_from_clipboard(app).await;
}

/// "Paste as card" on a history item.
#[tauri::command]
pub async fn card_from_item(app: AppHandle, id: u64) -> Result<(), String> {
    let item = app.state::<History>().get(id).ok_or("That item is no longer in the history.")?;
    windows::hide_history(&app);
    card_from_text(app, item.text, None).await;
    Ok(())
}

/// Re-render the last text, optionally with another aspect.
// TODO: pass `--fresh` for "Another take" once the CLI grows it (today it
// rejects unknown flags); until then a re-run returns the cached answer.
#[tauri::command]
pub async fn card_rerun(app: AppHandle, aspect: Option<String>) {
    let text = app.state::<CardState>().last_text.lock().ok().and_then(|t| t.clone());
    match text {
        Some(t) => card_from_text(app, t, aspect).await,
        None => card_from_clipboard(app).await,
    }
}

/// Settings → Test: render without touching the clipboard or any window.
#[tauri::command]
pub async fn render_test(app: AppHandle, text: Option<String>, aspect: Option<String>) -> Result<PasteResult, PasteError> {
    let s = Settings::load(&app);
    let text = text.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| TEST_TEXT.into());
    let aspect = aspect.unwrap_or_else(|| s.aspect.clone());
    render(&app, &s, &text, &aspect).await
}

#[tauri::command]
pub fn copy_card(app: AppHandle, path: String, format: String) -> Result<String, String> {
    copy_to_clipboard(&app, Path::new(&path), &format).map(String::from)
}

#[tauri::command]
pub fn save_card(path: String, dest: String) -> Result<(), String> {
    std::fs::copy(&path, &dest).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn result_state(state: State<'_, CardState>) -> Option<ResultState> {
    state.last_state.lock().ok().and_then(|s| s.clone())
}

#[tauri::command]
pub fn result_hold(state: State<'_, CardState>, hold: bool) {
    state.hold.store(hold, Ordering::SeqCst);
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub app_data: String,
    pub cards_dir: String,
    pub sidecar: sidecar::SidecarInfo,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let s = Settings::load(&app);
    let paths = sidecar::paths(&app).map_err(|e| e.message)?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        app_data: paths.app_data.display().to_string(),
        cards_dir: paths.cards.display().to_string(),
        sidecar: sidecar::info(&app, &s),
    })
}
