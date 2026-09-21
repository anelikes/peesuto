//! The long-lived Core: one `paste-daemon` process (`core/src/daemon.ts`,
//! run by bun in dev mode or by the bundled Bun sidecar) started at launch
//! and spoken to over stdin/stdout in JSON lines (`docs/daemon.md`).
//!
//! Lifecycle: `request` starts the process when none is alive — at launch
//! (`start`), after it exited (idle timeout, crash) on the next request —
//! and the first line written to a fresh process is always `config.set`
//! with the provider configs and the Keychain secrets, so Core is never
//! asked anything before it knows its providers. Requests carry increasing
//! ids; a reader thread matches responses to a pending map, each caller
//! waiting with its own timeout. Core's stderr goes to the app log.
//!
//! If the process cannot be started twice in a row the daemon gives up
//! (`fallback`): renders go through the one-shot `paste` CLI (`sidecar.rs`)
//! and everything else reports `sidecar`. Applying settings resets that.

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};

use crate::{log, providers, settings::Settings, sidecar::{self, PasteError}};

pub const PICK_TIMEOUT: Duration = Duration::from_secs(10);
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(180);
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(180);
/// A cold bundled install copies the engine tree before answering anything.
pub const CONFIG_TIMEOUT: Duration = Duration::from_secs(150);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(150);
pub const IDLE_MINUTES: u32 = 30;
/// Consecutive start failures before the CLI fallback takes over.
const MAX_START_FAILURES: u32 = 2;

pub type Shared = Arc<Daemon>;

struct Live {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Daemon {
    live: Mutex<Option<Live>>,
    next_id: AtomicU64,
    start_failures: AtomicU32,
    fallback: AtomicBool,
    /// Set once the ready line has been seen, for `daemon_status`.
    ready: Arc<AtomicBool>,
    version: Mutex<Option<String>>,
    engine: Mutex<Option<String>>,
}

impl Daemon {
    pub fn fallback(&self) -> bool {
        self.fallback.load(Ordering::SeqCst)
    }

    pub fn alive(&self) -> bool {
        self.live.lock().ok().and_then(|l| l.as_ref().map(|l| l.alive.load(Ordering::SeqCst))).unwrap_or(false)
    }

    /// Forget the fallback decision (settings changed); the next request tries again.
    pub fn reset(&self) {
        self.fallback.store(false, Ordering::SeqCst);
        self.start_failures.store(0, Ordering::SeqCst);
    }

    /// Stop the process (app exit, or a settings change that moves the sidecar).
    pub fn stop(&self) {
        if let Ok(mut live) = self.live.lock() {
            if let Some(mut l) = live.take() {
                let _ = writeln!(l.stdin, "{}", json!({"id": 0, "cmd": "shutdown"}));
                let _ = l.stdin.flush();
                std::thread::sleep(Duration::from_millis(80));
                let _ = l.child.kill();
                let _ = l.child.wait();
            }
        }
        self.ready.store(false, Ordering::SeqCst);
    }

    fn spawn(&self, app: &AppHandle) -> Result<Live, PasteError> {
        let s = Settings::load(app);
        let plan = sidecar::daemon_plan(app, &s)?;
        let mut cmd = Command::new(&plan.program);
        cmd.args(&plan.args).envs(plan.env.iter().cloned()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| PasteError::new("sidecar", format!("could not start Core ({}): {e}", plan.program.display())))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>> = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        log::line(format!("core: starting {} {}", plan.program.display(), plan.args.join(" ")));

        {
            let pending = pending.clone();
            let alive = alive.clone();
            let ready = self.ready.clone();
            let _ = std::thread::Builder::new().name("core-stdout".into()).spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let v: Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(e) => {
                            log::line(format!("core: unreadable line ({e}): {}", &line[..line.len().min(200)]));
                            continue;
                        }
                    };
                    let id = v.get("id").and_then(|i| i.as_i64()).unwrap_or(-1);
                    if id == 0 && v.get("cmd").and_then(|c| c.as_str()) == Some("ready") {
                        ready.store(true, Ordering::SeqCst);
                        log::line(format!(
                            "core: ready (version {}, engine {})",
                            v.get("version").and_then(|x| x.as_str()).unwrap_or("?"),
                            v.get("engine").and_then(|x| x.as_str()).unwrap_or("none")
                        ));
                        continue;
                    }
                    if id < 0 {
                        log::line(format!("core: {}", v.get("message").and_then(|m| m.as_str()).unwrap_or("error without id")));
                        continue;
                    }
                    let tx = pending.lock().ok().and_then(|mut p| p.remove(&(id as u64)));
                    match tx {
                        Some(tx) => {
                            let _ = tx.send(v);
                        }
                        None => log::line(format!("core: response for unknown request {id}")),
                    }
                }
                alive.store(false, Ordering::SeqCst);
                ready.store(false, Ordering::SeqCst);
                if let Ok(mut p) = pending.lock() {
                    for (_, tx) in p.drain() {
                        let _ = tx.send(json!({"ok": false, "kind": "sidecar", "message": "Core exited before answering."}));
                    }
                }
                log::line("core: exited");
            });
        }
        let _ = std::thread::Builder::new().name("core-stderr".into()).spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if !line.trim().is_empty() {
                    log::line(format!("core: {line}"));
                }
            }
        });
        Ok(Live { child, stdin, pending, alive })
    }

    /// Write one request (`body` gains its id) and hand back the channel its response arrives on.
    fn send(&self, app: &AppHandle, mut body: Value) -> Result<(u64, mpsc::Receiver<Value>, Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>), PasteError> {
        let mut live = self.live.lock().map_err(|_| PasteError::new("error", "daemon state poisoned"))?;
        let dead = live.as_ref().map(|l| !l.alive.load(Ordering::SeqCst)).unwrap_or(true);
        if dead {
            if let Some(mut old) = live.take() {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
            if self.fallback() {
                return Err(PasteError::new("sidecar", "Core could not be started; see the app log. Check the renderer settings and save to try again."));
            }
            match self.spawn(app) {
                Ok(l) => {
                    *live = Some(l);
                    self.start_failures.store(0, Ordering::SeqCst);
                }
                Err(e) => {
                    let n = self.start_failures.fetch_add(1, Ordering::SeqCst) + 1;
                    log::line(format!("core: start failed ({n}): {}", e.message));
                    if n >= MAX_START_FAILURES {
                        self.fallback.store(true, Ordering::SeqCst);
                        log::line("core: giving up on the daemon; renders fall back to the paste CLI");
                    }
                    return Err(e);
                }
            }
            // The first request into a fresh process is always the configuration.
            let l = live.as_mut().expect("just spawned");
            let cfg_id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
            let mut cfg = providers::core_config(app);
            cfg["id"] = json!(cfg_id);
            let (tx, rx) = mpsc::channel();
            if let Ok(mut p) = l.pending.lock() {
                p.insert(cfg_id, tx);
            }
            if let Err(e) = writeln!(l.stdin, "{cfg}") {
                l.alive.store(false, Ordering::SeqCst);
                return Err(PasteError::new("sidecar", format!("could not write to Core: {e}")));
            }
            let _ = std::thread::Builder::new().name("core-config".into()).spawn(move || match rx.recv_timeout(CONFIG_TIMEOUT) {
                Ok(v) if v.get("ok").and_then(|b| b.as_bool()) == Some(true) => {
                    log::line(format!("core: providers {}", v.get("providers").map(|p| p.to_string()).unwrap_or_default()))
                }
                Ok(v) => log::line(format!("core: config.set failed: {}", v.get("message").and_then(|m| m.as_str()).unwrap_or("?"))),
                Err(_) => log::line("core: config.set was not answered"),
            });
        }
        let l = live.as_mut().expect("alive");
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        body["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        if let Ok(mut p) = l.pending.lock() {
            p.insert(id, tx);
        }
        if let Err(e) = writeln!(l.stdin, "{body}") {
            l.alive.store(false, Ordering::SeqCst);
            if let Ok(mut p) = l.pending.lock() {
                p.remove(&id);
            }
            return Err(PasteError::new("sidecar", format!("could not write to Core: {e}")));
        }
        let _ = l.stdin.flush();
        Ok((id, rx, l.pending.clone()))
    }

    /// One round trip. Blocks: call from a blocking task.
    pub fn request(&self, app: &AppHandle, body: Value, timeout: Duration) -> Result<Value, PasteError> {
        let cmd = body.get("cmd").and_then(|c| c.as_str()).unwrap_or("?").to_string();
        let (id, rx, pending) = self.send(app, body)?;
        match rx.recv_timeout(timeout) {
            Ok(v) => {
                if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
                    Ok(v)
                } else {
                    Err(PasteError {
                        kind: v.get("kind").and_then(|k| k.as_str()).unwrap_or("error").to_string(),
                        message: v.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error").to_string(),
                    })
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut p) = pending.lock() {
                    p.remove(&id);
                }
                log::line(format!("core: {cmd} #{id} timed out after {} s", timeout.as_secs()));
                Err(PasteError::new("timeout", format!("Core did not answer `{cmd}` within {} s.", timeout.as_secs())))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(PasteError::new("sidecar", "Core exited before answering.")),
        }
    }
}

fn shared(app: &AppHandle) -> Shared {
    app.state::<Shared>().inner().clone()
}

/// `request` off the async runtime.
pub async fn call(app: &AppHandle, body: Value, timeout: Duration) -> Result<Value, PasteError> {
    let d = shared(app);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || d.request(&app, body, timeout))
        .await
        .map_err(|e| PasteError::new("error", format!("daemon task failed: {e}")))?
}

/// Launch: start Core in the background and load the actions once it is up.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match call(&app, json!({"cmd": "health"}), LIST_TIMEOUT).await {
            Ok(v) => {
                let d = shared(&app);
                if let Ok(mut m) = d.version.lock() {
                    *m = v.get("version").and_then(|x| x.as_str()).map(String::from);
                }
                if let Ok(mut m) = d.engine.lock() {
                    *m = v.get("engine").and_then(|x| x.as_str()).map(String::from);
                }
                crate::actions::refresh(&app, false).await;
            }
            Err(e) => log::line(format!("core: health at launch failed: {}", e.message)),
        }
    });
}

/// Settings changed: push the configuration (restarting Core if it is not running).
pub async fn apply_config(app: &AppHandle) -> Result<Value, PasteError> {
    shared(app).reset();
    let v = call(app, providers::core_config(app), CONFIG_TIMEOUT).await?;
    Ok(v.get("providers").cloned().unwrap_or(Value::Null))
}

/// The sidecar location changed: stop the process so the next request starts the new one.
pub fn restart(app: &AppHandle) {
    let d = shared(app);
    d.stop();
    d.reset();
    start(app);
}

// ---- commands ----

#[derive(serde::Serialize)]
pub struct DaemonStatus {
    pub alive: bool,
    pub ready: bool,
    pub fallback: bool,
    pub version: Option<String>,
    pub engine: Option<String>,
}

#[tauri::command]
pub fn daemon_status(app: AppHandle) -> DaemonStatus {
    let d = shared(&app);
    DaemonStatus {
        alive: d.alive(),
        ready: d.ready.load(Ordering::SeqCst),
        fallback: d.fallback(),
        version: d.version.lock().ok().and_then(|v| v.clone()),
        engine: d.engine.lock().ok().and_then(|v| v.clone()),
    }
}

#[tauri::command]
pub async fn daemon_health(app: AppHandle) -> Result<Value, PasteError> {
    call(&app, json!({"cmd": "health"}), LIST_TIMEOUT).await
}

/// `pick`: the ranking for `candidates` in `context` (`PickResult`).
#[tauri::command]
pub async fn daemon_pick(app: AppHandle, context: Value, candidates: Vec<Value>, fresh: Option<bool>) -> Result<Value, PasteError> {
    let t0 = std::time::Instant::now();
    let n = candidates.len();
    let level = context.get("level").and_then(|l| l.as_u64()).unwrap_or(0);
    let v = call(&app, json!({"cmd": "pick", "context": context, "candidates": candidates, "fresh": fresh.unwrap_or(false)}), PICK_TIMEOUT).await;
    match &v {
        // Ids and scores only: never the content.
        Ok(v) => log::line(format!(
            "pick: {} · level {level} · {n} candidate(s) · top {} · shouldPaste {} · {} ms",
            v["result"]["source"].as_str().unwrap_or("?"),
            v["result"]["ranked"][0]["item"]["id"].as_str().unwrap_or("-"),
            v["result"]["shouldPaste"],
            t0.elapsed().as_millis()
        )),
        Err(e) => log::line(format!("pick: failed after {} ms: {} (recency order)", t0.elapsed().as_millis(), e.message)),
    }
    Ok(v?.get("result").cloned().unwrap_or(Value::Null))
}

/// `run-action`: `{result, pick?}`.
#[tauri::command]
pub async fn daemon_run_action(app: AppHandle, action: String, input: Value, candidates: Option<Vec<Value>>) -> Result<Value, PasteError> {
    let mut body = json!({"cmd": "run-action", "action": action, "input": input});
    if let Some(c) = candidates {
        body["candidates"] = Value::Array(c);
    }
    let v = call(&app, body, ACTION_TIMEOUT).await?;
    Ok(json!({"result": v.get("result").cloned().unwrap_or(Value::Null), "pick": v.get("pick").cloned()}))
}

/// `actions.list` (or `actions.reload`): `{actions, problems}`.
#[tauri::command]
pub async fn daemon_actions(app: AppHandle, reload: Option<bool>) -> Result<Value, PasteError> {
    let cmd = if reload.unwrap_or(false) { "actions.reload" } else { "actions.list" };
    let v = call(&app, json!({"cmd": cmd}), LIST_TIMEOUT).await?;
    Ok(json!({"actions": v.get("actions").cloned().unwrap_or(json!([])), "problems": v.get("problems").cloned().unwrap_or(json!([]))}))
}

/// Settings saved: push providers, and re-register actions in case the sidecar moved.
#[tauri::command]
pub async fn daemon_apply_config(app: AppHandle) -> Result<Value, PasteError> {
    apply_config(&app).await
}

#[tauri::command]
pub fn daemon_restart(app: AppHandle) {
    restart(&app);
}

/// `render`: a DSL straight to a file (`{path, format, frames, ms}`).
#[tauri::command]
pub async fn daemon_render(app: AppHandle, dsl: Value, out: Option<String>) -> Result<Value, PasteError> {
    let mut body = json!({"cmd": "render", "dsl": dsl});
    if let Some(o) = out {
        body["out"] = json!(o);
    }
    call(&app, body, RENDER_TIMEOUT).await
}
