//! Where Core lives and how it is launched, in two modes chosen by the
//! `sidecar_mode` setting:
//!
//! * `dev` runs `bun <repo>/core/src/…` against a pocket-paste checkout
//!   (`dev_repo_path`), so the shell can be developed against live core code.
//! * `bundled` runs the Bun executable shipped as Tauri's `paste` external
//!   binary (next to the app binary) on `Resources/resources/core/…`, the
//!   tree `scripts/bundle-sidecar.ts` assembles. The base `tauri.conf.json`
//!   does not list the external binary — it does not exist until that script
//!   runs — so `bun tauri dev` works without it; `tauri.sidecar.conf.json` adds
//!   it for a bundled build. When it is missing, bundled mode fails with a
//!   clear `sidecar` error instead of a spawn failure.
//!
//! The long-lived daemon (`daemon.rs`) is the normal path; `daemon_plan`
//! says how to start it. `run_paste` is the one-shot `paste --json` CLI, kept
//! as the fallback for renders when the daemon will not start.

use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Runtime};

use crate::{providers, settings::Settings};

/// Generous: a cold engine install in bundled mode copies a 70 MB tree first.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PasteResult {
    pub path: String,
    /// png | gif
    pub format: String,
    #[serde(default)]
    pub frames: u32,
    #[serde(default)]
    pub lines: u32,
    #[serde(default)]
    pub size: u32,
    #[serde(default)]
    pub dsl: serde_json::Value,
    #[serde(default)]
    pub decided: serde_json::Value,
    #[serde(default)]
    pub ms: serde_json::Value,
}

/// `kind` is Core's (`ERROR_KINDS` in core/src/daemon/protocol.ts): `usage`, `input`,
/// `provider:config|auth|network|timeout|model|bad-response|quota|offline|unavailable`,
/// `action:spec|needs|input|run`, `compose`, `engine`, `error` — plus the shell's own
/// `sidecar` (could not start) and `timeout`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PasteError {
    pub kind: String,
    pub message: String,
}

impl PasteError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        PasteError { kind: kind.into(), message: message.into() }
    }
}

#[derive(Clone, Debug)]
pub struct PasteArgs {
    pub text: String,
    pub aspect: String,
    /// Requested output file. The CLI writes exactly here; when the card turns
    /// out animated the `.png` is renamed to `.gif` afterwards.
    pub out: PathBuf,
}

pub struct Paths {
    pub app_data: PathBuf,
    pub work: PathBuf,
    pub cards: PathBuf,
}

pub fn paths<R: Runtime>(app: &AppHandle<R>) -> Result<Paths, PasteError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| PasteError::new("error", format!("no application data directory: {e}")))?;
    Ok(Paths { work: app_data.join("work"), cards: app_data.join("cards"), app_data })
}

/// What the settings window shows about the sidecar.
#[derive(Clone, Debug, Serialize)]
pub struct SidecarInfo {
    pub mode: String,
    pub bun: Option<String>,
    pub dev_daemon: String,
    pub dev_daemon_present: bool,
    pub bundled_binary: String,
    pub bundled_present: bool,
    pub resources: String,
    pub resources_present: bool,
}

pub fn info<R: Runtime>(app: &AppHandle<R>, s: &Settings) -> SidecarInfo {
    let dev_daemon = dev_core_path(s, "daemon.ts");
    let bundled_binary = bundled_binary_path();
    let resources = resources_dir(app);
    SidecarInfo {
        mode: s.sidecar_mode.clone(),
        bun: find_bun().map(|p| p.display().to_string()),
        dev_daemon_present: dev_daemon.is_file(),
        dev_daemon: dev_daemon.display().to_string(),
        bundled_present: bundled_binary.is_file(),
        bundled_binary: bundled_binary.display().to_string(),
        resources_present: resources.join("core/daemon.ts").is_file(),
        resources: resources.display().to_string(),
    }
}

pub struct Plan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn dev_core_path(s: &Settings, entry: &str) -> PathBuf {
    Path::new(&s.dev_repo_path).join("core/src").join(entry)
}

/// Tauri places external binaries next to the app binary, without the target triple.
fn bundled_binary_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("paste")))
        .unwrap_or_else(|| PathBuf::from("paste"))
}

/// `Contents/Resources/resources`: the tree `bundle-sidecar.ts` writes, bundled via `tauri.sidecar.conf.json`.
fn resources_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .resource_dir()
        .map(|d| d.join("resources"))
        .unwrap_or_else(|_| PathBuf::from("resources"))
}

/// `bun` for dev mode. A GUI app launched from Finder has a minimal PATH, so
/// the usual install locations are checked after it.
fn find_bun() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PATH")
        .and_then(|p| std::env::split_paths(&p).map(|d| d.join("bun")).find(|p| p.is_file()))
    {
        return Some(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(b) = std::env::var("BUN_INSTALL") {
        candidates.push(PathBuf::from(b).join("bin/bun"));
    }
    if let Ok(h) = std::env::var("HOME") {
        candidates.push(PathBuf::from(h).join(".bun/bin/bun"));
    }
    candidates.push("/opt/homebrew/bin/bun".into());
    candidates.push("/usr/local/bin/bun".into());
    candidates.into_iter().find(|p| p.is_file())
}

fn prepend_path(dir: Option<&Path>) -> String {
    let current = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    match dir {
        Some(d) => format!("{}:{current}", d.display()),
        None => current,
    }
}

/// Program, entry script and environment for `entry` (`daemon.ts` or `cli.ts`)
/// in the configured mode. `--engine-resources` is appended in bundled mode.
fn launch<R: Runtime>(app: &AppHandle<R>, s: &Settings, entry: &str) -> Result<(Plan, PathBuf), PasteError> {
    match s.sidecar_mode.as_str() {
        "bundled" => {
            let bin = bundled_binary_path();
            if !bin.is_file() {
                return Err(PasteError::new(
                    "sidecar",
                    format!(
                        "This build has no bundled Core ({}). Run `bun scripts/bundle-sidecar.ts` and build with `bun run build:bundled`, or switch the sidecar to dev mode in Settings.",
                        bin.display()
                    ),
                ));
            }
            let res = resources_dir(app);
            let script = res.join("core").join(entry);
            if !script.is_file() {
                return Err(PasteError::new("sidecar", format!("Core's resources are missing ({}).", script.display())));
            }
            // The engine spawns `bun` by name; the sidecar directory goes first on PATH.
            let env = vec![("PATH".into(), prepend_path(bin.parent()))];
            let args = vec![script.display().to_string(), "--engine-resources".into(), res.display().to_string()];
            Ok((Plan { program: bin, args, env }, script))
        }
        _ => {
            let bun = find_bun().ok_or_else(|| {
                PasteError::new(
                    "sidecar",
                    "bun was not found. Install Bun (https://bun.sh) or switch the sidecar to bundled mode in Settings.",
                )
            })?;
            let script = dev_core_path(s, entry);
            if !script.is_file() {
                return Err(PasteError::new(
                    "sidecar",
                    format!("No pocket-paste checkout at {} (core/src/{entry} is missing). Set the dev repo path in Settings.", s.dev_repo_path),
                ));
            }
            let env = vec![("PATH".into(), prepend_path(bun.parent()))];
            let args = vec![script.display().to_string()];
            Ok((Plan { program: bun, args, env }, script))
        }
    }
}

/// How to start `paste-daemon` for the long-lived Core.
pub fn daemon_plan<R: Runtime>(app: &AppHandle<R>, s: &Settings) -> Result<Plan, PasteError> {
    let paths = paths(app)?;
    let (mut plan, _) = launch(app, s, "daemon.ts")?;
    plan.args.extend([
        "--app-data".to_string(),
        paths.app_data.display().to_string(),
        "--idle-minutes".to_string(),
        crate::daemon::IDLE_MINUTES.to_string(),
    ]);
    Ok(plan)
}

/// The CLI fallback: `paste --stdin --json …`, with the proxy decider when
/// one is configured (the CLI knows `none` and `proxy`).
fn cli_plan<R: Runtime>(app: &AppHandle<R>, s: &Settings, a: &PasteArgs) -> Result<Plan, PasteError> {
    let paths = paths(app)?;
    let (mut plan, _) = launch(app, s, "cli.ts")?;
    plan.args.extend(
        [
            "--stdin",
            "--json",
            "--aspect",
            &a.aspect,
            "--work",
            &paths.work.display().to_string(),
            "--app-data",
            &paths.app_data.display().to_string(),
            "--out",
            &a.out.display().to_string(),
        ]
        .map(String::from),
    );
    match providers::load(app).decider {
        providers::Decider::Proxy { url, .. } => {
            plan.args.extend(["--provider".to_string(), "proxy".into(), "--proxy-url".into(), url]);
            if let Some(t) = crate::secrets::get(providers::REF_PROXY_TOKEN).ok().flatten().filter(|t| !t.is_empty()) {
                // Through the environment, so it never shows in `ps`.
                plan.env.push(("PASTE_TOKEN".into(), t));
            }
        }
        _ => plan.args.extend(["--provider".to_string(), "none".into()]),
    }
    Ok(plan)
}

/// Run the CLI for `args` with the given settings and parse its result.
pub async fn run_paste<R: Runtime>(app: &AppHandle<R>, s: &Settings, args: PasteArgs) -> Result<PasteResult, PasteError> {
    let plan = cli_plan(app, s, &args)?;
    if let Some(dir) = args.out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| PasteError::new("error", format!("cannot create {}: {e}", dir.display())))?;
    }
    let text = args.text;
    let result = tauri::async_runtime::spawn_blocking(move || execute(plan, &text))
        .await
        .map_err(|e| PasteError::new("error", format!("sidecar task failed: {e}")))??;
    Ok(settle_extension(result))
}

fn execute(p: Plan, text: &str) -> Result<PasteResult, PasteError> {
    let mut cmd = Command::new(&p.program);
    cmd.args(&p.args).envs(p.env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| PasteError::new("sidecar", format!("could not start {}: {e}", p.program.display())))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
        // dropping closes stdin: the CLI reads to EOF
    }
    let mut out_pipe = child.stdout.take().expect("piped stdout");
    let mut err_pipe = child.stderr.take().expect("piped stderr");
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        s
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(PasteError::new("error", format!("waiting for the sidecar failed: {e}"))),
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(PasteError::new("timeout", "Rendering took too long and was stopped."));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    parse_output(&stdout, &stderr, status.code())
}

fn parse_output(stdout: &str, stderr: &str, code: Option<i32>) -> Result<PasteResult, PasteError> {
    let line = stdout.lines().rev().map(str::trim).find(|l| l.starts_with('{'));
    let Some(line) = line else {
        let exit = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        return Err(PasteError::new("error", format!("The renderer exited ({exit}) without a result.{}", tail(stderr))));
    };
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| PasteError::new("error", format!("Unreadable renderer result: {e}")))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        serde_json::from_value::<PasteResult>(v).map_err(|e| PasteError::new("error", format!("Incomplete renderer result: {e}")))
    } else {
        Err(PasteError {
            kind: v.get("kind").and_then(|k| k.as_str()).unwrap_or("error").to_string(),
            message: v.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error").to_string(),
        })
    }
}

fn tail(stderr: &str) -> String {
    let t: Vec<&str> = stderr.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    if t.is_empty() {
        String::new()
    } else {
        format!("\n{}", t.join("\n"))
    }
}

/// The CLI writes to `--out` verbatim and decides png vs gif from the DSL, so an
/// animated card lands in a `.png` name: give it its real extension.
fn settle_extension(mut r: PasteResult) -> PasteResult {
    if r.format == "gif" && r.path.ends_with(".png") {
        let renamed = format!("{}.gif", r.path.trim_end_matches(".png"));
        if std::fs::rename(&r.path, &renamed).is_ok() {
            r.path = renamed;
        }
    }
    r
}
