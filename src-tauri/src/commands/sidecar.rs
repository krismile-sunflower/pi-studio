use std::env;
use std::fs::{create_dir_all, File};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::time::sleep;

use crate::{AppState, PiInstance};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct PiCommand {
    program: PathBuf,
    initial_args: Vec<PathBuf>,
    display: String,
    is_system_fallback: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeInfo {
    pub source: String,
    pub platform: String,
    pub command: String,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    pub bundled: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPiRequest {
    pub path: Option<String>,
    pub no_folder: Option<bool>,
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn start_pi(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartPiRequest,
) -> Result<PiInstance, String> {
    start_pi_process(app, state, request).await
}

#[tauri::command]
pub async fn get_pi_runtime_info(app: AppHandle) -> Result<PiRuntimeInfo, String> {
    let platform = platform_binaries_dir()
        .map(str::to_string)
        .unwrap_or_else(|_| format!("{}-{}", env::consts::OS, env::consts::ARCH));
    let pi_command = resolve_pi_command(&app)?;
    let node_version = if pi_command.initial_args.is_empty() {
        None
    } else {
        command_output(&pi_command.program, &["--version"])
    };
    let pi_version = command_output_paths(
        &pi_command.program,
        &pi_command.initial_args,
        &["--version"],
    );
    let is_override = env::var("PI_DESKTOP_CLI").is_ok();
    let error = if !pi_command.is_system_fallback && pi_version.is_none() {
        Some("Bundled Pi was found, but version check failed.".to_string())
    } else {
        None
    };

    Ok(PiRuntimeInfo {
        source: if is_override {
            "override".into()
        } else if pi_command.is_system_fallback {
            "system".into()
        } else {
            "bundled".into()
        },
        platform,
        command: pi_command.display,
        node_version,
        pi_version,
        bundled: !pi_command.is_system_fallback && !is_override,
        error,
    })
}

pub async fn start_pi_process(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartPiRequest,
) -> Result<PiInstance, String> {
    let no_folder = request.no_folder.unwrap_or(false);
    let project_path = if no_folder {
        PathBuf::from(crate::settings::no_folder_launch_path()?)
    } else {
        PathBuf::from(
            request
                .path
                .as_deref()
                .ok_or_else(|| "Missing project path".to_string())?,
        )
    };
    if !project_path.exists() {
        return Err(format!(
            "Project path does not exist: {}",
            project_path.display()
        ));
    }

    if no_folder {
        if let Some(existing) = find_no_folder_instance(&state)? {
            if is_compatible_tau_port(existing.port).await {
                set_active_instance(&state, existing.clone())?;
                return Ok(existing);
            }
            let _ = stop_pi_inner(state.inner(), Some(existing.pid));
        }
    } else if let Some(path) = request.path.as_deref() {
        if let Some(existing) = find_instance_by_path(&state, path)? {
            if is_compatible_tau_port(existing.port).await {
                set_active_instance(&state, existing.clone())?;
                return Ok(existing);
            }
            let _ = stop_pi_inner(state.inner(), Some(existing.pid));
        }
    }

    {
        let mut stale_pids = Vec::new();
        let mut children = state.pi_children.lock().map_err(lock_err)?;
        for (pid, child) in children.iter_mut() {
            if child.try_wait().ok().flatten().is_some() {
                stale_pids.push(*pid);
            }
        }
        for pid in stale_pids {
            children.remove(&pid);
        }
    }

    let port = request.port.unwrap_or_else(|| allocate_port(3001));
    let pi_command = resolve_pi_command(&app)?;
    let static_dir = normalize_child_path(resolve_static_dir(&app));
    let extension_dir = resolve_extension_dir(&app);
    let session_dir = normalize_child_path(pi_session_dir(&project_path)?);

    let mut command = Command::new(&pi_command.program);
    configure_hidden_process(&mut command);
    command
        .current_dir(&project_path)
        .args(&pi_command.initial_args)
        .arg("--mode")
        .arg("rpc")
        .arg("--extension")
        .arg(normalize_child_path(resolve_extension_file(&app)))
        .arg("--session-dir")
        .arg(session_dir)
        .arg("--no-approve")
        .env("TAU_MIRROR_PORT", port.to_string())
        .env("TAU_HOST", "127.0.0.1")
        .env("TAU_STATIC_DIR", static_dir)
        .env("TAU_DESKTOP", "1")
        .stdin(Stdio::piped());

    if let Some((stdout, stderr)) = pi_log_files(port) {
        command.stdout(stdout).stderr(stderr);
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }

    if let Some(extension_dir) = extension_dir {
        let extension_dir = normalize_child_path(extension_dir);
        if let Some(node_path) = extension_node_path(&extension_dir) {
            command.env("NODE_PATH", node_path);
        }
        command.env("TAU_EXTENSION_DIR", extension_dir);
    }

    let mut child = command
        .spawn()
        .map_err(|err| {
            if pi_command.is_system_fallback {
                format!(
                    "System Pi could not be started. Check that `pi` is available on PATH, or run the Pi vendor script before packaging. Tried `{}`: {}",
                    pi_command.display, err
                )
            } else {
                format!("Failed to start bundled Pi `{}`: {}", pi_command.display, err)
            }
        })?;

    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, r#"{{"id":"pi-studio-start","type":"new_session"}}"#)
            .map_err(|err| format!("Failed to initialize Pi RPC session: {err}"))?;
    }

    let pid = child.id();
    let instance = PiInstance {
        pid,
        port,
        project_path: project_path.display().to_string(),
        no_folder,
        started_at: timestamp_string(),
    };

    state
        .pi_children
        .lock()
        .map_err(lock_err)?
        .insert(pid, child);
    set_active_instance(&state, instance.clone())?;

    monitor_pi_process(app.clone(), pid);

    if !wait_for_tau(port).await {
        let _ = stop_pi_inner(state.inner(), Some(pid));
        return Err(format!(
            "Pi started, but Tau did not become ready at http://127.0.0.1:{port}"
        ));
    }

    let _ = app.emit(
        "tau-pi-status",
        serde_json::json!({
            "status": "running",
            "instance": instance,
        }),
    );

    if no_folder {
        crate::settings::activate_no_folder()?;
    } else if let Some(path) = request.path {
        crate::settings::upsert_project(path)?;
    }

    Ok(instance)
}

#[tauri::command]
pub async fn stop_pi(state: State<'_, AppState>, pid: Option<u32>) -> Result<(), String> {
    stop_pi_by_state(&state, pid)
}

pub fn stop_pi_by_state(state: &State<'_, AppState>, pid: Option<u32>) -> Result<(), String> {
    stop_pi_inner(state.inner(), pid)
}

fn stop_pi_inner(state: &AppState, pid: Option<u32>) -> Result<(), String> {
    let active_pid = state.active_pid.lock().map_err(lock_err)?.to_owned();

    let target_pid = pid
        .or(active_pid)
        .ok_or_else(|| "No active Pi process".to_string())?;

    if let Some(mut child) = state
        .pi_children
        .lock()
        .map_err(lock_err)?
        .remove(&target_pid)
    {
        let _ = child.kill();
        let _ = child.wait();
    }

    if active_pid == Some(target_pid) {
        *state.active_pid.lock().map_err(lock_err)? = None;
        *state.active_instance.lock().map_err(lock_err)? = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_instances(state: State<'_, AppState>) -> Result<Vec<PiInstance>, String> {
    Ok(crate::settings::load_runtime_instances()
        .into_iter()
        .filter(|instance| {
            state
                .pi_children
                .lock()
                .map(|children| children.contains_key(&instance.pid))
                .unwrap_or(false)
        })
        .collect())
}

#[tauri::command]
pub async fn switch_instance(state: State<'_, AppState>, pid: u32) -> Result<PiInstance, String> {
    let instance = crate::settings::load_runtime_instances()
        .into_iter()
        .find(|instance| instance.pid == pid)
        .ok_or_else(|| format!("No known Pi instance with pid {pid}"))?;
    if !state
        .pi_children
        .lock()
        .map_err(lock_err)?
        .contains_key(&pid)
    {
        return Err(format!("Pi instance {pid} is no longer running"));
    }
    set_active_instance(&state, instance.clone())?;
    Ok(instance)
}

pub fn active_instance_for_port(
    state: &State<'_, AppState>,
    port: Option<u16>,
) -> Option<PiInstance> {
    if let Some(port) = port {
        return crate::settings::load_runtime_instances()
            .into_iter()
            .find(|instance| instance.port == port);
    }

    state
        .active_instance
        .lock()
        .ok()
        .and_then(|instance| instance.clone())
}

pub fn base_url_for_port(state: &State<'_, AppState>, port: Option<u16>) -> String {
    let port = active_instance_for_port(state, port)
        .map(|instance| instance.port)
        .or(port)
        .unwrap_or(3001);
    format!("http://127.0.0.1:{port}")
}

pub fn active_ws_url(state: &State<'_, AppState>) -> Option<String> {
    let port = state
        .active_instance
        .lock()
        .ok()
        .and_then(|instance| instance.as_ref().map(|instance| instance.port))?;
    Some(format!("ws://127.0.0.1:{port}/ws"))
}

pub fn lock_err<T>(err: std::sync::PoisonError<T>) -> String {
    format!("Application state lock poisoned: {err}")
}

fn resolve_pi_command(app: &AppHandle) -> Result<PiCommand, String> {
    if let Ok(path) = env::var("PI_DESKTOP_CLI") {
        return Ok(PiCommand {
            program: PathBuf::from(&path),
            initial_args: Vec::new(),
            display: path,
            is_system_fallback: false,
        });
    }

    if let Some(command) = system_pi_command() {
        return Ok(command);
    }

    for binaries_root in candidate_binaries_roots(app) {
        let platform_dir = binaries_root.join(platform_binaries_dir()?);
        if let Some(command) = bundled_pi_command(&platform_dir) {
            return Ok(command);
        }
    }

    Ok(PiCommand {
        program: PathBuf::from(if cfg!(windows) { "pi.cmd" } else { "pi" }),
        initial_args: Vec::new(),
        display: "system pi on PATH".into(),
        is_system_fallback: true,
    })
}

fn system_pi_command() -> Option<PiCommand> {
    if let Some(command) = system_node_pi_command() {
        return Some(command);
    }

    let program = PathBuf::from(if cfg!(windows) { "pi.cmd" } else { "pi" });
    command_output(&program, &["--version"])?;
    Some(PiCommand {
        program,
        initial_args: Vec::new(),
        display: "system pi on PATH".into(),
        is_system_fallback: true,
    })
}

fn system_node_pi_command() -> Option<PiCommand> {
    let npm = PathBuf::from(if cfg!(windows) { "npm.cmd" } else { "npm" });
    let output = hidden_command(&npm).args(["root", "-g"]).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let global_root = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if global_root.is_empty() {
        return None;
    }

    let package_root = PathBuf::from(&global_root)
        .join("@earendil-works")
        .join("pi-coding-agent");
    let cli = package_root.join("dist").join("cli.js");
    if !cli.exists() {
        return None;
    }

    let node = node_for_global_root(&PathBuf::from(global_root));
    command_output_paths(&node, std::slice::from_ref(&cli), &["--version"])?;

    Some(PiCommand {
        program: node.clone(),
        initial_args: vec![cli.clone()],
        display: format!("{} {}", node.display(), cli.display()),
        is_system_fallback: true,
    })
}

fn node_for_global_root(global_root: &Path) -> PathBuf {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = Vec::new();

    if let Some(parent) = global_root.parent() {
        candidates.push(parent.join(executable));
        candidates.push(parent.join("bin").join(executable));

        if !cfg!(windows) {
            if let Some(prefix) = parent.parent() {
                candidates.push(prefix.join("bin").join(executable));
            }
        }
    }

    for node in candidates {
        if node.exists() {
            return node;
        }
    }

    PathBuf::from(executable)
}

fn candidate_binaries_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("binaries"));
    }
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    roots
}

fn bundled_pi_command(platform_dir: &Path) -> Option<PiCommand> {
    let node =
        normalize_child_path(platform_dir.join(if cfg!(windows) { "node.exe" } else { "node" }));
    let cli = [
        platform_dir.join("pi-package").join("dist").join("cli.js"),
        platform_dir
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js"),
    ]
    .into_iter()
    .find(|path| path.exists());

    if let Some(cli) = cli.filter(|_| node.exists()) {
        let cli = normalize_child_path(cli);
        return Some(PiCommand {
            program: node.clone(),
            initial_args: vec![cli.clone()],
            display: format!("{} {}", node.display(), cli.display()),
            is_system_fallback: false,
        });
    }

    None
}

fn normalize_child_path(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }

    let value = path.display().to_string();
    if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path
}

fn platform_binaries_dir() -> Result<&'static str, String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        (os, arch) => Err(format!(
            "Unsupported bundled Pi platform: {os}-{arch}. Set PI_DESKTOP_CLI for development or add a matching src-tauri/binaries platform directory."
        )),
    }
}

fn command_output(program: &Path, args: &[&str]) -> Option<String> {
    let output = hidden_command(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn command_output_paths(program: &Path, initial_args: &[PathBuf], args: &[&str]) -> Option<String> {
    let output = hidden_command(program)
        .args(initial_args)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn hidden_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    configure_hidden_process(&mut command);
    command
}

fn configure_hidden_process(_command: &mut Command) {
    #[cfg(windows)]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn resolve_static_dir(app: &AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("tau-web");
        if bundled.join("index.html").exists() {
            return bundled;
        }
    }

    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join("src"))
        .unwrap_or_else(|| PathBuf::from("src"))
}

fn resolve_extension_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|resource_dir| resource_dir.join("extensions"))
        .filter(|path| path.exists())
}

fn resolve_extension_file(app: &AppHandle) -> PathBuf {
    resolve_extension_dir(app)
        .map(|dir| dir.join("mirror-server.ts"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("extensions")
                .join("mirror-server.ts")
        })
}

fn extension_node_path(extension_dir: &Path) -> Option<std::ffi::OsString> {
    let node_modules = extension_dir.join("node_modules");
    if !node_modules.exists() {
        return env::var_os("NODE_PATH");
    }

    let mut paths = vec![node_modules];
    if let Some(existing) = env::var_os("NODE_PATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).ok()
}

fn pi_log_files(port: u16) -> Option<(Stdio, Stdio)> {
    let dir = dirs::config_dir()?.join("pi-studio").join("logs");
    create_dir_all(&dir).ok()?;
    let stdout = File::create(dir.join(format!("pi-{port}.out.log"))).ok()?;
    let stderr = File::create(dir.join(format!("pi-{port}.err.log"))).ok()?;
    Some((Stdio::from(stdout), Stdio::from(stderr)))
}

fn pi_session_dir(project_path: &Path) -> Result<PathBuf, String> {
    let agent_dir = env::var("PI_CODING_AGENT_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
    let resolved_project = project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf());
    let safe_path = encode_session_dir_name(&resolved_project.display().to_string());
    let session_dir = agent_dir.join("sessions").join(safe_path);
    create_dir_all(&session_dir).map_err(|err| err.to_string())?;
    Ok(session_dir)
}

fn encode_session_dir_name(path: &str) -> String {
    let trimmed = path.trim_start_matches(['/', '\\']);
    let safe = trimmed
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' => '-',
            _ => ch,
        })
        .collect::<String>();
    format!("--{safe}--")
}

async fn wait_for_tau(port: u16) -> bool {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/health");

    for _ in 0..40 {
        if client.get(&url).send().await.is_ok() {
            return true;
        }
        sleep(Duration::from_millis(250)).await;
    }
    false
}

pub async fn is_compatible_tau_port(port: u16) -> bool {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/api/health");
    let Ok(response) = client.get(url).send().await else {
        return false;
    };
    let Ok(value) = response.json::<serde_json::Value>().await else {
        return false;
    };

    let version_ok = value
        .get("mirrorProtocolVersion")
        .and_then(|value| value.as_u64())
        .is_some_and(|version| version >= 2);
    let has_new_session = value
        .get("capabilities")
        .and_then(|value| value.as_array())
        .is_some_and(|items| {
            items
                .iter()
                .any(|item| item.as_str() == Some("new_session"))
        });

    version_ok && has_new_session
}

fn timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn monitor_pi_process(app: AppHandle, pid: u32) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(2)).await;
            let state = app.state::<AppState>();
            let exited = {
                let mut children = match state.pi_children.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };

                match children
                    .get_mut(&pid)
                    .and_then(|child| child.try_wait().ok())
                    .flatten()
                {
                    Some(status) => {
                        children.remove(&pid);
                        Some(status.to_string())
                    }
                    None => None,
                }
            };

            if let Some(status) = exited {
                crate::settings::remove_runtime_instance(pid);
                if state.active_pid.lock().ok().and_then(|pid| *pid) == Some(pid) {
                    if let Ok(mut active_pid) = state.active_pid.lock() {
                        *active_pid = None;
                    }
                    if let Ok(mut active) = state.active_instance.lock() {
                        *active = None;
                    }
                }
                let _ = app.emit(
                    "tau-pi-status",
                    serde_json::json!({
                        "status": "exited",
                        "exitStatus": status,
                    }),
                );
                let _ = app
                    .notification()
                    .builder()
                    .title("pi-studio")
                    .body("Pi process exited")
                    .auto_cancel()
                    .show();
                break;
            }
        }
    });
}

fn same_path(a: &str, b: &str) -> bool {
    let left = PathBuf::from(a).canonicalize().ok();
    let right = PathBuf::from(b).canonicalize().ok();
    match (left, right) {
        (Some(left), Some(right)) => left == right,
        _ => a == b,
    }
}

fn find_instance_by_path(
    state: &State<'_, AppState>,
    path: &str,
) -> Result<Option<PiInstance>, String> {
    let children = state.pi_children.lock().map_err(lock_err)?;
    Ok(crate::settings::load_runtime_instances()
        .into_iter()
        .find(|instance| {
            children.contains_key(&instance.pid) && same_path(&instance.project_path, path)
        }))
}

fn find_no_folder_instance(state: &State<'_, AppState>) -> Result<Option<PiInstance>, String> {
    let children = state.pi_children.lock().map_err(lock_err)?;
    Ok(crate::settings::load_runtime_instances()
        .into_iter()
        .find(|instance| children.contains_key(&instance.pid) && instance.no_folder))
}

fn set_active_instance(state: &State<'_, AppState>, instance: PiInstance) -> Result<(), String> {
    *state.active_pid.lock().map_err(lock_err)? = Some(instance.pid);
    *state.active_instance.lock().map_err(lock_err)? = Some(instance.clone());
    crate::settings::upsert_runtime_instance(instance);
    Ok(())
}

fn allocate_port(start: u16) -> u16 {
    for port in start..start + 100 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    start
}
