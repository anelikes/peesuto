//! Actions: the registry Core lists (`actions.list`), mirrored here so the
//! tray menu and the per-action hotkeys can be built from it; running one
//! (input from the clipboard or a history item, context from `context.rs`)
//! through the daemon's `run-action`; and the `result` window's state — a
//! text result with Paste/Copy, or a card (image/gif) with the aspect toggle
//! and "Another take" (`fresh: true`). Smart paste (`needs: decider`) is not
//! run here: its trigger opens the history panel, which runs the pick.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    clipboard::History,
    context::{self, Context},
    daemon, log, pasteboard,
    settings::Settings,
    sidecar::{self, PasteArgs, PasteError, PasteResult},
    windows,
};

pub const RESULT_EVENT: &str = "result:state";
pub const TEST_TEXT: &str = "Hello, pocket-paste";
pub const ACTIONS_DIR: &str = "actions";

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub menu: Option<bool>,
}

/// `ActionSpec` in core/src/actions/types.ts; unknown fields ride along in `rest`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<Trigger>,
    pub input: String,
    pub needs: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

impl ActionSpec {
    pub fn hotkey(&self) -> Option<&str> {
        self.trigger.as_ref().and_then(|t| t.hotkey.as_deref()).map(str::trim).filter(|h| !h.is_empty())
    }
    pub fn in_menu(&self) -> bool {
        self.trigger.as_ref().and_then(|t| t.menu).unwrap_or(false)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Problem {
    pub file: String,
    pub message: String,
}

/// One action's hotkey and whether it could be registered.
#[derive(Clone, Debug, Serialize)]
pub struct HotkeyReport {
    pub action: String,
    pub hotkey: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Default)]
pub struct Registry {
    pub actions: Mutex<Vec<ActionSpec>>,
    pub problems: Mutex<Vec<Problem>>,
    pub hotkeys: Mutex<Vec<HotkeyReport>>,
}

impl Registry {
    pub fn all(&self) -> Vec<ActionSpec> {
        self.actions.lock().map(|a| a.clone()).unwrap_or_default()
    }
    pub fn find(&self, id: &str) -> Option<ActionSpec> {
        self.actions.lock().ok().and_then(|a| a.iter().find(|s| s.id == id).cloned())
    }
    fn set(&self, actions: Vec<ActionSpec>, problems: Vec<Problem>) {
        if let Ok(mut a) = self.actions.lock() {
            *a = actions;
        }
        if let Ok(mut p) = self.problems.lock() {
            *p = problems;
        }
    }
}

#[derive(Serialize)]
pub struct ActionsInfo {
    pub actions: Vec<ActionSpec>,
    pub problems: Vec<Problem>,
    pub hotkeys: Vec<HotkeyReport>,
    pub folder: String,
}

fn info(app: &AppHandle) -> ActionsInfo {
    let reg = app.state::<Registry>();
    ActionsInfo {
        actions: reg.all(),
        problems: reg.problems.lock().map(|p| p.clone()).unwrap_or_default(),
        hotkeys: reg.hotkeys.lock().map(|h| h.clone()).unwrap_or_default(),
        folder: user_dir(app).map(|d| d.display().to_string()).unwrap_or_default(),
    }
}

pub fn user_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(ACTIONS_DIR))
}

/// Ask Core for the actions, keep them, and rebuild the menu and the hotkeys.
pub async fn refresh(app: &AppHandle, reload: bool) {
    match daemon::daemon_actions(app.clone(), Some(reload)).await {
        Ok(v) => {
            let actions: Vec<ActionSpec> = serde_json::from_value(v["actions"].clone()).unwrap_or_default();
            let problems: Vec<Problem> = serde_json::from_value(v["problems"].clone()).unwrap_or_default();
            log::line(format!("actions: {} loaded, {} problem(s)", actions.len(), problems.len()));
            app.state::<Registry>().set(actions, problems);
            apply_triggers(app);
        }
        Err(e) => log::line(format!("actions: could not list: {}", e.message)),
    }
}

/// Rebuild the tray menu and (re)register every hotkey from the current registry and settings.
pub fn apply_triggers(app: &AppHandle) {
    let s = Settings::load(app);
    let actions = app.state::<Registry>().all();
    crate::tray::set_actions(app, &s.hotkey, &actions);
    let reports = crate::hotkeys::register_all(app, &s.hotkey, &actions);
    for r in reports.iter().filter(|r| !r.ok) {
        log::line(format!("hotkeys: {} ({}): {}", r.action, r.hotkey, r.problem.clone().unwrap_or_default()));
    }
    if let Ok(mut h) = app.state::<Registry>().hotkeys.lock() {
        *h = reports;
    }
}

// ---- the result window ----

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionMeta {
    pub id: String,
    pub name: String,
    pub needs: String,
    pub output: String,
}

impl From<&ActionSpec> for ActionMeta {
    fn from(s: &ActionSpec) -> Self {
        ActionMeta { id: s.id.clone(), name: s.name.clone(), needs: s.needs.clone(), output: s.output.clone() }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ResultState {
    Working { action: ActionMeta, input: String, aspect: String },
    Text { action: ActionMeta, input: String, text: String, model: Option<String>, ms: u64 },
    Card { action: ActionMeta, input: String, aspect: String, result: PasteResult, copied: String },
    Error { action: ActionMeta, input: String, aspect: String, kind: String, message: String },
}

/// What a re-run repeats.
#[derive(Clone, Debug)]
struct LastRun {
    action: String,
    input: String,
    item: Option<Value>,
    context: Option<Context>,
    aspect: String,
}

#[derive(Default)]
pub struct ResultWindow {
    last_state: Mutex<Option<ResultState>>,
    last_run: Mutex<Option<LastRun>>,
    /// The result window stays up on blur while this is set (a save dialog is open).
    pub hold: AtomicBool,
    busy: AtomicBool,
}

fn publish(app: &AppHandle, st: ResultState) {
    if let Ok(mut last) = app.state::<ResultWindow>().last_state.lock() {
        *last = Some(st.clone());
    }
    let _ = app.emit_to(windows::RESULT, RESULT_EVENT, st);
}

/// Where an action's input comes from.
#[derive(Clone, Debug)]
pub enum Source {
    Clipboard,
    Item(String),
}

#[derive(Clone, Debug, Default)]
pub struct RunOptions {
    pub aspect: Option<String>,
    pub fresh: bool,
    /// The panel hands over the context it captured; other triggers read the focused field now.
    pub context: Option<Context>,
}

fn unknown(id: &str) -> ActionMeta {
    ActionMeta { id: id.into(), name: id.into(), needs: "none".into(), output: "text".into() }
}

/// Run `action` on `source` and show the result window. Smart paste opens the panel instead.
pub async fn run(app: AppHandle, action: String, source: Source, opts: RunOptions) {
    let Some(spec) = app.state::<Registry>().find(&action) else {
        let aspect = Settings::load(&app).aspect;
        publish(&app, ResultState::Error { action: unknown(&action), input: String::new(), aspect, kind: "action:spec".into(), message: format!("No action “{action}”. Reload the actions in Settings.") });
        windows::show_result(&app);
        return;
    };
    if spec.needs == "decider" {
        windows::show_history(&app);
        return;
    }
    let meta = ActionMeta::from(&spec);
    let aspect = opts.aspect.clone().unwrap_or_else(|| Settings::load(&app).aspect);
    let (input, item) = match &source {
        Source::Clipboard => (app.clipboard().read_text().unwrap_or_default(), None),
        Source::Item(id) => match app.state::<History>().get(id) {
            Some(it) => (it.text.clone().unwrap_or_default(), Some(serde_json::to_value(&it).unwrap_or(Value::Null))),
            None => (String::new(), None),
        },
    };
    if input.trim().is_empty() {
        let message = match source {
            Source::Clipboard => "Copy some text first.".to_string(),
            Source::Item(_) => "That item has no text.".to_string(),
        };
        log::line(format!("action {}: nothing to work on ({message})", spec.id));
        publish(&app, ResultState::Error { action: meta, input: String::new(), aspect, kind: "empty".into(), message });
        windows::show_result(&app);
        return;
    }
    let context = match opts.context {
        Some(c) => Some(c),
        None => tauri::async_runtime::spawn_blocking(context::capture).await.ok(),
    };
    let last = LastRun { action: spec.id.clone(), input: input.clone(), item, context, aspect: aspect.clone() };
    execute(app, spec, last, opts.fresh).await;
}

async fn execute(app: AppHandle, spec: ActionSpec, run: LastRun, fresh: bool) {
    let state = app.state::<ResultWindow>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return; // one at a time; the window shows the run in flight
    }
    if let Ok(mut l) = state.last_run.lock() {
        *l = Some(run.clone());
    }
    let meta = ActionMeta::from(&spec);
    publish(&app, ResultState::Working { action: meta.clone(), input: run.input.clone(), aspect: run.aspect.clone() });
    windows::show_result(&app);

    let t0 = std::time::Instant::now();
    let outcome = perform(&app, &spec, &run, fresh).await;
    // Outcome only, never the content.
    match &outcome {
        Ok(Outcome::Text { model, .. }) => log::line(format!("action {}: text from {} in {} ms", spec.id, model.as_deref().unwrap_or("?"), t0.elapsed().as_millis())),
        Ok(Outcome::Card(r)) => log::line(format!("action {}: {} in {} ms", spec.id, r.format, t0.elapsed().as_millis())),
        Err(e) => log::line(format!("action {}: {} — {}", spec.id, e.kind, e.message)),
    }
    let next = match outcome {
        Ok(Outcome::Text { text, model, ms }) => ResultState::Text { action: meta, input: run.input, text, model, ms },
        Ok(Outcome::Card(result)) => {
            let copied = copy_to_clipboard(&app, Path::new(&result.path), &result.format).unwrap_or_else(|e| {
                log::line(format!("clipboard: {e}"));
                "none"
            });
            ResultState::Card { action: meta, input: run.input, aspect: run.aspect, result, copied: copied.into() }
        }
        Err(e) => ResultState::Error { action: meta, input: run.input, aspect: run.aspect, kind: e.kind, message: e.message },
    };
    state.busy.store(false, Ordering::SeqCst);
    publish(&app, next);
    windows::show_result(&app);
}

enum Outcome {
    Text { text: String, model: Option<String>, ms: u64 },
    Card(PasteResult),
}

/// `run-action` through the daemon; the one-shot CLI for renders when the daemon gave up.
async fn perform(app: &AppHandle, spec: &ActionSpec, run: &LastRun, fresh: bool) -> Result<Outcome, PasteError> {
    if spec.needs == "render" && app.state::<daemon::Shared>().fallback() {
        log::line(format!("actions: {} through the paste CLI (daemon unavailable)", spec.id));
        let s = Settings::load(app);
        let paths = sidecar::paths(app)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
        let out = paths.cards.join(format!("{stamp}.png"));
        let r = sidecar::run_paste(app, &s, PasteArgs { text: run.input.clone(), aspect: run.aspect.clone(), out }).await?;
        return Ok(Outcome::Card(r));
    }
    let mut input = json!({"text": run.input, "aspect": run.aspect, "fresh": fresh});
    if let Some(item) = &run.item {
        input["item"] = item.clone();
    }
    if let Some(ctx) = &run.context {
        input["context"] = serde_json::to_value(ctx).unwrap_or(Value::Null);
    }
    let v = daemon::daemon_run_action(app.clone(), spec.id.clone(), input, None).await?;
    let r = &v["result"];
    match r["output"].as_str() {
        Some("text") => Ok(Outcome::Text {
            text: r["text"].as_str().unwrap_or_default().to_string(),
            model: r["model"].as_str().map(String::from),
            ms: r["ms"].as_u64().unwrap_or(0),
        }),
        Some("image") | Some("gif") => {
            let meta = &r["meta"];
            Ok(Outcome::Card(PasteResult {
                path: r["path"].as_str().unwrap_or_default().to_string(),
                format: r["format"].as_str().unwrap_or("png").to_string(),
                frames: meta["frames"].as_u64().unwrap_or(1) as u32,
                lines: meta["lines"].as_u64().unwrap_or(0) as u32,
                size: meta["size"].as_u64().unwrap_or(0) as u32,
                dsl: meta["dsl"].clone(),
                decided: meta["decided"].clone(),
                ms: json!({"total": r["ms"], "compose": meta["render"]["compose"], "build": meta["render"]["build"], "frame": meta["render"]["frame"]}),
            }))
        }
        other => Err(PasteError::new("error", format!("Unexpected result output {other:?} from {}.", spec.id))),
    }
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

/// Dev aid: `POCKET_PASTE_AUTORUN=history|card|action:<id>|delete-newest|clear[:<ms>]`
/// drives the app shortly after launch, so a window can be checked without the
/// shortcut; `POCKET_PASTE_AUTORUN_REPEAT=n` runs an action n times in a row
/// (cold and warm timings). Debug builds only.
pub fn autorun_if_requested(app: &AppHandle) {
    let Some(spec) = std::env::var("POCKET_PASTE_AUTORUN").ok().filter(|_| cfg!(debug_assertions)) else { return };
    let mut parts = spec.splitn(3, ':');
    let mode = parts.next().unwrap_or("history").to_string();
    let (arg, delay) = match (parts.next(), parts.next()) {
        (Some(a), Some(d)) => (a.to_string(), d.parse::<u64>().unwrap_or(2500)),
        (Some(a), None) => match a.parse::<u64>() {
            Ok(d) => (String::new(), d),
            Err(_) => (a.to_string(), 2500),
        },
        _ => (String::new(), 2500),
    };
    let repeat = std::env::var("POCKET_PASTE_AUTORUN_REPEAT").ok().and_then(|r| r.parse::<u32>().ok()).unwrap_or(1).max(1);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(delay))).await;
        match mode.as_str() {
            "card" => {
                // A finished card replaces the clipboard text with the image, so re-copy per run.
                for _ in 0..repeat {
                    let _ = app.clipboard().write_text(TEST_TEXT);
                    run(app.clone(), "paste-card".into(), Source::Clipboard, RunOptions::default()).await;
                }
            }
            "action" => {
                for _ in 0..repeat {
                    run(app.clone(), arg.clone(), Source::Clipboard, RunOptions::default()).await;
                }
            }
            "delete-newest" => {
                let history = app.state::<History>();
                let newest = history.recent(1).into_iter().next();
                let ok = newest.as_ref().map(|it| history.with(|s| s.delete(&it.id)).unwrap_or(false)).unwrap_or(false);
                log::line(format!("autorun: delete newest {} → {ok}", newest.map(|i| i.id).unwrap_or_else(|| "(none)".into())));
                crate::clipboard::notify(&app);
            }
            "clear" => {
                app.state::<History>().with(|s| s.clear());
                log::line("autorun: history cleared");
                crate::clipboard::notify(&app);
            }
            _ => windows::show_history(&app),
        }
    });
}

const TEMPLATE: &str = r#"{
  "id": "my-action",
  "name": "My action",
  "description": "What it does, in a sentence.",
  "trigger": { "hotkey": "", "menu": true },
  "input": "clipboard",
  "needs": "generator",
  "system": "You are a careful editor. Output only the result.",
  "prompt": "Rewrite the following text so it is clearer:\n\n{{input}}",
  "maxTokens": 1024,
  "output": "text"
}
"#;

// ---- commands ----

/// Run an action on the clipboard, or on a history item (from the panel's item menu).
#[tauri::command]
pub async fn action_run(app: AppHandle, id: String, item_id: Option<String>, aspect: Option<String>, fresh: Option<bool>) {
    let source = match item_id {
        Some(i) => Source::Item(i),
        None => Source::Clipboard,
    };
    let context = context::last(&app).map(|s| s.context);
    windows::hide_history(&app);
    run(app, id, source, RunOptions { aspect, fresh: fresh.unwrap_or(false), context }).await;
}

/// Re-run the last action, with another aspect and/or a fresh take.
#[tauri::command]
pub async fn action_rerun(app: AppHandle, aspect: Option<String>, fresh: Option<bool>) {
    let last = app.state::<ResultWindow>().last_run.lock().ok().and_then(|l| l.clone());
    let Some(mut last) = last else { return };
    let Some(spec) = app.state::<Registry>().find(&last.action) else { return };
    if let Some(a) = aspect {
        last.aspect = a;
    }
    execute(app, spec, last, fresh.unwrap_or(false)).await;
}

#[tauri::command]
pub fn actions_list(app: AppHandle) -> ActionsInfo {
    info(&app)
}

#[tauri::command]
pub async fn actions_reload(app: AppHandle) -> ActionsInfo {
    refresh(&app, true).await;
    info(&app)
}

#[tauri::command]
pub fn actions_open_folder(app: AppHandle) -> Result<String, String> {
    let dir = user_dir(&app).ok_or("no application data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// Write a template into the actions folder and open it in the default editor.
#[tauri::command]
pub fn actions_new(app: AppHandle) -> Result<String, String> {
    let dir = user_dir(&app).ok_or("no application data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut n = 1;
    let mut path = dir.join("my-action.json");
    while path.exists() {
        n += 1;
        path = dir.join(format!("my-action-{n}.json"));
    }
    let body = if n == 1 { TEMPLATE.to_string() } else { TEMPLATE.replace("\"my-action\"", &format!("\"my-action-{n}\"")) };
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
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
pub fn result_state(state: State<'_, ResultWindow>) -> Option<ResultState> {
    state.last_state.lock().ok().and_then(|s| s.clone())
}

#[tauri::command]
pub fn result_hold(state: State<'_, ResultWindow>, hold: bool) {
    state.hold.store(hold, Ordering::SeqCst);
}

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub identifier: String,
    pub app_data: String,
    pub cards_dir: String,
    pub log: String,
    pub sidecar: sidecar::SidecarInfo,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let s = Settings::load(&app);
    let paths = sidecar::paths(&app).map_err(|e| e.message)?;
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        log: paths.app_data.join(crate::log::NAME).display().to_string(),
        app_data: paths.app_data.display().to_string(),
        cards_dir: paths.cards.display().to_string(),
        sidecar: sidecar::info(&app, &s),
    })
}

/// Settings saved: re-register the shortcuts (returns their reports), relabel
/// the tray, run retention, and push the provider config to Core. `restart`
/// stops Core so the next request starts it from the (possibly moved) sidecar.
#[tauri::command]
pub async fn settings_apply(app: AppHandle, restart: Option<bool>) -> Result<Vec<HotkeyReport>, PasteError> {
    if restart.unwrap_or(false) {
        daemon::restart(&app);
    } else {
        daemon::apply_config(&app).await?;
    }
    apply_triggers(&app);
    crate::clipboard::purge(&app);
    Ok(app.state::<Registry>().hotkeys.lock().map(|h| h.clone()).unwrap_or_default())
}
