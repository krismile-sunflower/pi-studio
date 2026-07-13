use std::env;
use std::fs::{self, create_dir_all, File};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::time::sleep;

use crate::{AppState, PiInstance, PiTransport};

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
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub can_update_system: bool,
    pub can_update_bundled: bool,
    pub update_channel: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUpdateResult {
    pub ok: bool,
    pub message: String,
    pub previous_version: Option<String>,
    pub new_version: Option<String>,
    pub channel: String,
    pub log: String,
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
    )
    .and_then(|text| extract_semver(&text));
    let is_override = env::var("PI_DESKTOP_CLI").is_ok();
    let source = if is_override {
        "override".to_string()
    } else if pi_command.is_system_fallback {
        "system".to_string()
    } else {
        "bundled".to_string()
    };
    let error = if !pi_command.is_system_fallback && pi_version.is_none() {
        Some("Bundled Pi was found, but version check failed.".to_string())
    } else {
        None
    };
    let can_update_bundled =
        source == "bundled" && bundled_platform_dir(&app).is_some_and(|dir| is_dir_writable(&dir));
    let can_update_system = source == "system";

    Ok(PiRuntimeInfo {
        source: source.clone(),
        platform,
        command: pi_command.display,
        node_version,
        pi_version,
        bundled: !pi_command.is_system_fallback && !is_override,
        error,
        latest_version: None,
        update_available: false,
        can_update_system,
        can_update_bundled,
        update_channel: source,
    })
}

#[tauri::command]
pub async fn check_pi_update(app: AppHandle) -> Result<PiRuntimeInfo, String> {
    let mut info = get_pi_runtime_info(app).await?;
    let latest = fetch_latest_pi_version().await;
    info.latest_version = latest.clone();
    info.update_available = match (&info.pi_version, &latest) {
        (Some(current), Some(latest_version)) => is_version_newer(latest_version, current),
        _ => false,
    };
    if info.latest_version.is_none() {
        info.error = Some(
            info.error
                .unwrap_or_else(|| "无法获取最新 Pi 版本，请检查网络。".into()),
        );
    }
    Ok(info)
}

#[tauri::command]
pub async fn update_pi_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PiUpdateResult, String> {
    let info = get_pi_runtime_info(app.clone()).await?;
    let previous = info.pi_version.clone();
    let channel = info.update_channel.clone();

    // Stop managed Pi processes so files/binaries are not locked.
    let running = running_instances_for_current_transport(state.inner());
    for instance in &running {
        let _ = stop_pi_inner(state.inner(), Some(instance.pid));
    }
    // Windows may keep file handles open briefly after kill/wait.
    if !running.is_empty() {
        sleep(Duration::from_millis(500)).await;
    }

    let result = match channel.as_str() {
        "system" => update_system_pi().await,
        "bundled" => update_bundled_pi(&app).await,
        "override" => {
            Err("当前使用 PI_DESKTOP_CLI 覆盖路径，请手动更新该可执行文件或取消环境变量。".into())
        }
        other => Err(format!("当前运行时通道 `{other}` 不支持应用内更新。")),
    };

    match result {
        Ok(log) => {
            let refreshed = get_pi_runtime_info(app).await.ok();
            Ok(PiUpdateResult {
                ok: true,
                message: "Pi 已更新，请重新打开项目以使用新版本。".into(),
                previous_version: previous,
                new_version: refreshed.and_then(|info| info.pi_version),
                channel,
                log,
            })
        }
        Err(error) => Ok(PiUpdateResult {
            ok: false,
            message: error.clone(),
            previous_version: previous,
            new_version: None,
            channel,
            log: error,
        }),
    }
}

pub async fn start_pi_process(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartPiRequest,
) -> Result<PiInstance, String> {
    let desired_transport = desktop_transport();
    crate::settings::append_desktop_log(format!(
        "start_pi_process transport={desired_transport:?} path={:?} no_folder={:?}",
        request.path, request.no_folder
    ));
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
        crate::settings::append_desktop_log(format!(
            "project path does not exist: {}",
            project_path.display()
        ));
        return Err(format!(
            "Project path does not exist: {}",
            project_path.display()
        ));
    }

    if no_folder {
        if let Some(existing) = find_no_folder_instance(&state, &project_path)? {
            if let Some(instance) =
                reuse_or_stop_existing_instance(&state, existing, desired_transport).await?
            {
                return Ok(instance);
            }
        }
    } else if let Some(path) = request.path.as_deref() {
        if let Some(existing) = find_instance_by_path(&state, path)? {
            if let Some(instance) =
                reuse_or_stop_existing_instance(&state, existing, desired_transport).await?
            {
                return Ok(instance);
            }
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

    if desired_transport == PiTransport::Rpc {
        return start_pi_rpc_process(app, state, project_path, no_folder, request.path).await;
    }

    let port = request.port.unwrap_or_else(|| allocate_port(3001));
    let pi_command = resolve_pi_command(&app)?;
    let static_dir = normalize_child_path(resolve_static_dir(&app));
    let extension_dir = resolve_extension_dir(&app);
    let session_dir = normalize_child_path(pi_session_dir(&project_path)?);
    let models_refresh_extension = resolve_models_refresh_extension(&app);
    let reasoning_payload_extension = resolve_reasoning_payload_extension(&app);
    let permissions_extension = resolve_permissions_extension(&app);

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
        .env("TAU_MIRROR_PORT", port.to_string())
        .env("TAU_HOST", "127.0.0.1")
        .env("TAU_STATIC_DIR", static_dir)
        .env("TAU_DESKTOP", "1")
        .stdin(Stdio::piped());
    command.arg(if crate::settings::is_project_trusted(&project_path) {
        "--approve"
    } else {
        "--no-approve"
    });

    if let Some(extension) = models_refresh_extension {
        command.arg("--extension").arg(extension);
    }
    if let Some(extension) = reasoning_payload_extension {
        command.arg("--extension").arg(extension);
    }
    if let Some(extension) = permissions_extension {
        command.arg("--extension").arg(extension);
    }

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
        port: Some(port),
        transport: PiTransport::Mirror,
        session_file: None,
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

async fn start_pi_rpc_process(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: PathBuf,
    no_folder: bool,
    original_path: Option<String>,
) -> Result<PiInstance, String> {
    let pi_command = resolve_pi_command(&app)?;
    let session_dir = normalize_child_path(pi_session_dir(&project_path)?);
    let models_refresh_extension = resolve_models_refresh_extension(&app);
    let reasoning_payload_extension = resolve_reasoning_payload_extension(&app);
    let permissions_extension = resolve_permissions_extension(&app);
    crate::settings::append_desktop_log(format!(
        "starting Pi RPC command={} cwd={} session_dir={} models_refresh={}",
        pi_command.display,
        project_path.display(),
        session_dir.display(),
        models_refresh_extension
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "none".into())
    ));

    let mut command = Command::new(&pi_command.program);
    configure_hidden_process(&mut command);
    command
        .current_dir(&project_path)
        .args(&pi_command.initial_args)
        .arg("--mode")
        .arg("rpc")
        .arg("--session-dir")
        .arg(session_dir)
        .env("TAU_DESKTOP", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.arg(if crate::settings::is_project_trusted(&project_path) {
        "--approve"
    } else {
        "--no-approve"
    });

    if let Some(extension) = models_refresh_extension {
        command.arg("--extension").arg(extension);
    }
    if let Some(extension) = reasoning_payload_extension {
        command.arg("--extension").arg(extension);
    }
    if let Some(extension) = permissions_extension {
        command.arg("--extension").arg(extension);
    }

    let (stdout_log, stderr_log) = pi_rpc_log_files();

    let mut child = command.spawn().map_err(|err| {
        crate::settings::append_desktop_log(format!("Pi RPC spawn failed: {err}"));
        if pi_command.is_system_fallback {
            format!(
                "System Pi could not be started. Check that `pi` is available on PATH, or run the Pi vendor script before packaging. Tried `{}`: {}",
                pi_command.display, err
            )
        } else {
            format!("Failed to start bundled Pi `{}`: {}", pi_command.display, err)
        }
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open Pi RPC stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Pi RPC stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open Pi RPC stderr".to_string())?;

    let pid = child.id();
    crate::settings::append_desktop_log(format!("Pi RPC spawned pid={pid}"));
    let mut instance = PiInstance {
        pid,
        port: None,
        transport: PiTransport::Rpc,
        session_file: None,
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
    crate::rpc::client::register_rpc_io(
        app.clone(),
        state.inner(),
        pid,
        stdin,
        stdout,
        stderr,
        stdout_log,
        stderr_log,
    )?;
    monitor_pi_process(app.clone(), pid);

    if !crate::rpc::client::wait_for_rpc_ready(state.inner(), pid).await {
        crate::settings::append_desktop_log(format!("Pi RPC readiness timed out pid={pid}"));
        let _ = stop_pi_inner(state.inner(), Some(pid));
        return Err("Pi started, but native RPC did not become ready.".to_string());
    }
    crate::settings::append_desktop_log(format!("Pi RPC ready pid={pid}"));

    if let Ok(snapshot) = crate::rpc::client::build_snapshot(state.inner(), pid).await {
        if let Some(session_file) = snapshot
            .get("sessionFile")
            .and_then(serde_json::Value::as_str)
        {
            instance.session_file = Some(session_file.to_string());
            set_active_instance(&state, instance.clone())?;
        }
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
    } else if let Some(path) = original_path {
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

    crate::rpc::client::clear_rpc_process(state, target_pid);
    if let Some(mut child) = state
        .pi_children
        .lock()
        .map_err(lock_err)?
        .remove(&target_pid)
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    crate::settings::remove_runtime_instance(target_pid);

    if active_pid == Some(target_pid) {
        *state.active_pid.lock().map_err(lock_err)? = None;
        *state.active_instance.lock().map_err(lock_err)? = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_instances(state: State<'_, AppState>) -> Result<Vec<PiInstance>, String> {
    Ok(running_instances_for_current_transport(state.inner()))
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
    if instance.transport != desktop_transport() {
        return Err(format!(
            "Pi instance {pid} is using {:?}, but the desktop transport is {:?}",
            instance.transport,
            desktop_transport()
        ));
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
            .find(|instance| {
                instance.transport == desktop_transport()
                    && instance.port == Some(port)
                    && is_managed_instance(state.inner(), instance)
            });
    }

    state
        .active_instance
        .lock()
        .ok()
        .and_then(|instance| instance.clone())
        .filter(|instance| {
            instance.transport == desktop_transport()
                && is_managed_instance(state.inner(), instance)
        })
}

pub fn active_ws_url(state: &State<'_, AppState>) -> Option<String> {
    let instance = state
        .active_instance
        .lock()
        .ok()
        .and_then(|instance| instance.clone())?;
    if instance.transport != PiTransport::Mirror {
        return None;
    }
    let port = instance.port?;
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

    for binaries_root in candidate_binaries_roots(app) {
        let platform_dir = binaries_root.join(platform_binaries_dir()?);
        if let Some(command) = bundled_pi_command(&platform_dir) {
            return Ok(command);
        }
    }

    if let Some(command) = system_pi_command() {
        return Ok(command);
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

pub fn desktop_transport() -> PiTransport {
    match env::var("PI_DESKTOP_TRANSPORT") {
        Ok(value) if value.eq_ignore_ascii_case("mirror") => PiTransport::Mirror,
        _ => PiTransport::Rpc,
    }
}

pub fn is_managed_instance(state: &AppState, instance: &PiInstance) -> bool {
    let child_running = state
        .pi_children
        .lock()
        .map(|children| children.contains_key(&instance.pid))
        .unwrap_or(false);
    if !child_running {
        return false;
    }

    match instance.transport {
        PiTransport::Rpc => state
            .rpc_writers
            .lock()
            .map(|writers| writers.contains_key(&instance.pid))
            .unwrap_or(false),
        PiTransport::Mirror => instance.port.is_some(),
    }
}

pub fn running_instances_for_current_transport(state: &AppState) -> Vec<PiInstance> {
    let desired_transport = desktop_transport();
    crate::settings::load_runtime_instances()
        .into_iter()
        .filter(|instance| {
            instance.transport == desired_transport && is_managed_instance(state, instance)
        })
        .collect()
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

fn resolve_models_refresh_extension(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        resolve_extension_dir(app).map(|dir| dir.join("models-refresh.ts")),
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("extensions")
                .join("models-refresh.ts"),
        ),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .map(normalize_child_path)
}

fn resolve_reasoning_payload_extension(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        resolve_extension_dir(app).map(|dir| dir.join("reasoning-payload.ts")),
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("extensions")
                .join("reasoning-payload.ts"),
        ),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .map(normalize_child_path)
}

fn resolve_permissions_extension(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        resolve_extension_dir(app).map(|dir| dir.join("permissions.ts")),
        Some(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("extensions")
                .join("permissions.ts"),
        ),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.exists())
        .map(normalize_child_path)
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

fn pi_rpc_log_files() -> (Option<File>, Option<File>) {
    let Some(dir) = dirs::config_dir().map(|dir| dir.join("pi-studio").join("logs")) else {
        return (None, None);
    };
    if create_dir_all(&dir).is_err() {
        return (None, None);
    }
    let stamp = timestamp_string();
    let stdout = File::create(dir.join(format!("pi-rpc-{stamp}.out.log"))).ok();
    let stderr = File::create(dir.join(format!("pi-rpc-{stamp}.err.log"))).ok();
    (stdout, stderr)
}

fn pi_session_dir(project_path: &Path) -> Result<PathBuf, String> {
    let agent_dir = env::var("PI_CODING_AGENT_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .ok_or_else(|| "Could not resolve Pi agent directory".to_string())?;
    let resolved_project = normalize_child_path(
        project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf()),
    );
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
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
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
                        crate::rpc::client::clear_rpc_process(state.inner(), pid);
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

fn find_no_folder_instance(
    state: &State<'_, AppState>,
    project_path: &Path,
) -> Result<Option<PiInstance>, String> {
    let children = state.pi_children.lock().map_err(lock_err)?;
    Ok(crate::settings::load_runtime_instances()
        .into_iter()
        .find(|instance| {
            children.contains_key(&instance.pid)
                && instance.no_folder
                && same_path(&instance.project_path, &project_path.display().to_string())
        }))
}

async fn reuse_or_stop_existing_instance(
    state: &State<'_, AppState>,
    existing: PiInstance,
    desired_transport: PiTransport,
) -> Result<Option<PiInstance>, String> {
    let reusable = if existing.transport != desired_transport {
        false
    } else if existing.transport == PiTransport::Rpc {
        is_managed_instance(state.inner(), &existing)
    } else if let Some(port) = existing.port {
        is_compatible_tau_port(port).await
    } else {
        false
    };

    if reusable {
        set_active_instance(state, existing.clone())?;
        return Ok(Some(existing));
    }

    let _ = stop_pi_inner(state.inner(), Some(existing.pid));
    Ok(None)
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

async fn fetch_latest_pi_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;

    if let Ok(response) = client.get("https://pi.dev/api/latest-version").send().await {
        if let Ok(value) = response.json::<serde_json::Value>().await {
            let version = value
                .get("version")
                .or_else(|| value.get("latest"))
                .or_else(|| value.get("latestVersion"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                });
            if let Some(version) = version.and_then(|text| extract_semver(&text)) {
                return Some(version);
            }
        }
    }

    let npm = PathBuf::from(if cfg!(windows) { "npm.cmd" } else { "npm" });
    let output = hidden_command(&npm)
        .args(["view", "@earendil-works/pi-coding-agent", "version"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    extract_semver(text.trim())
}

async fn update_system_pi() -> Result<String, String> {
    let npm = PathBuf::from(if cfg!(windows) { "npm.cmd" } else { "npm" });
    let output = hidden_command(&npm)
        .args(["install", "-g", "@earendil-works/pi-coding-agent@latest"])
        .output()
        .map_err(|err| format!("Failed to run npm install -g: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let log = [stdout, stderr]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !output.status.success() {
        return Err(if log.is_empty() {
            "npm install -g failed".into()
        } else {
            log
        });
    }
    Ok(if log.is_empty() {
        "npm install -g @earendil-works/pi-coding-agent@latest completed".into()
    } else {
        log
    })
}

async fn update_bundled_pi(app: &AppHandle) -> Result<String, String> {
    let platform_dir = bundled_platform_dir(app)
        .ok_or_else(|| "未找到可写的内置 Pi 目录，无法更新。".to_string())?;
    if !is_dir_writable(&platform_dir) {
        return Err(format!(
            "内置 Pi 目录不可写：{}。请以可写位置运行开发版，或重新安装应用。",
            platform_dir.display()
        ));
    }

    let temp_root = env::temp_dir().join(format!(
        "pi-studio-update-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    ));
    create_dir_all(&temp_root).map_err(|err| format!("Failed to create temp dir: {err}"))?;

    let npm = PathBuf::from(if cfg!(windows) { "npm.cmd" } else { "npm" });
    let install = hidden_command(&npm)
        .current_dir(&temp_root)
        .args([
            "install",
            "--omit=dev",
            "--no-save",
            "--prefix",
            temp_root.to_str().ok_or("Invalid temp path")?,
            "@earendil-works/pi-coding-agent@latest",
        ])
        .output()
        .map_err(|err| format!("Failed to download latest Pi package: {err}"))?;
    let install_log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&install.stdout),
        String::from_utf8_lossy(&install.stderr)
    );
    if !install.status.success() {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(format!("下载最新 Pi 失败：{}", install_log.trim()));
    }

    let package_src = temp_root
        .join("node_modules")
        .join("@earendil-works")
        .join("pi-coding-agent");
    if !package_src.join("dist").join("cli.js").exists() {
        let _ = fs::remove_dir_all(&temp_root);
        return Err("下载的 Pi 包缺少 dist/cli.js".into());
    }

    let target_package = platform_dir.join("pi-package");
    if let Err(err) = replace_dir_atomically(&package_src, &target_package).await {
        let _ = fs::remove_dir_all(&temp_root);
        return Err(err);
    }
    let _ = fs::remove_dir_all(&temp_root);

    // Keep the cargo source binaries and the tauri dev copy in sync when both exist.
    if let Some(sibling) = sibling_bundled_pi_package(&platform_dir, &target_package) {
        if let Err(err) = replace_dir_atomically(&target_package, &sibling).await {
            crate::settings::append_desktop_log(format!(
                "synced primary pi-package but failed to update sibling {}: {err}",
                sibling.display()
            ));
        }
    }

    let version = fs::read_to_string(target_package.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".into());

    Ok(format!(
        "Bundled Pi updated to {version} at {}\n{}",
        target_package.display(),
        install_log.trim()
    ))
}

/// Replace `dst` with the contents of `src` using rename + retry so Windows file locks
/// after stopping Pi do not immediately fail the update.
async fn replace_dir_atomically(src: &Path, dst: &Path) -> Result<(), String> {
    let parent = dst
        .parent()
        .ok_or_else(|| format!("Invalid package path: {}", dst.display()))?;
    create_dir_all(parent).map_err(|err| format!("Failed to create parent dir: {err}"))?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let staging = parent.join(format!(
        "{}.new-{}",
        dst.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pi-package"),
        stamp
    ));
    let backup = parent.join(format!(
        "{}.bak-{}",
        dst.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pi-package"),
        stamp
    ));

    // Clean leftovers from interrupted previous updates.
    let _ = remove_path_with_retry(&staging).await;
    let _ = remove_path_with_retry(&backup).await;

    if let Err(err) = copy_dir_recursive(src, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("准备新 pi-package 失败：{err}"));
    }

    // Move current install out of the way (preferred), with retries for Windows locks.
    let had_existing = dst.exists();
    if had_existing {
        if let Err(err) = rename_path_with_retry(dst, &backup).await {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "备份现有 pi-package 失败：{err}。请完全退出 Pi / 关闭占用该目录的窗口后重试。"
            ));
        }
    }

    if let Err(err) = rename_path_with_retry(&staging, dst).await {
        // Staging rename failed — try restore.
        let _ = fs::remove_dir_all(dst);
        let _ = fs::remove_dir_all(&staging);
        if backup.exists() {
            let _ = rename_path_with_retry(&backup, dst).await;
        }
        return Err(format!(
            "替换内置 pi-package 失败：{err}。请完全退出 Pi / 关闭占用该目录的窗口后重试。"
        ));
    }

    // Best-effort cleanup of the backup. Leaving it is fine if removal is locked.
    if backup.exists() {
        let _ = remove_path_with_retry(&backup).await;
    }
    Ok(())
}

async fn rename_path_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    const ATTEMPTS: u32 = 8;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err.to_string());
                // Access denied / sharing violation — wait for handles to release.
                if attempt + 1 < ATTEMPTS {
                    sleep(Duration::from_millis(200 * u64::from(attempt + 1))).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "rename failed".into()))
}

async fn remove_path_with_retry(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    const ATTEMPTS: u32 = 6;
    let mut last_err = None;
    for attempt in 0..ATTEMPTS {
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err.to_string());
                if attempt + 1 < ATTEMPTS {
                    sleep(Duration::from_millis(150 * u64::from(attempt + 1))).await;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "remove failed".into()))
}

/// When updating one of the two common bundled locations (source binaries vs tauri
/// debug/resource copy), also refresh the other so dev restarts pick up the new Pi.
fn sibling_bundled_pi_package(platform_dir: &Path, target_package: &Path) -> Option<PathBuf> {
    let platform = platform_binaries_dir().ok()?;
    let cargo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(platform);
    let cargo_package = cargo_root.join("pi-package");

    let target_norm = normalize_child_path(target_package.to_path_buf());
    let cargo_norm = normalize_child_path(cargo_package.clone());
    if target_norm == cargo_norm {
        // Primary was cargo source; look for a nearby target/debug copy used by tauri dev.
        let debug_package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
            .join("binaries")
            .join(platform)
            .join("pi-package");
        if debug_package.parent().is_some_and(|parent| parent.exists()) {
            return Some(debug_package);
        }
        return None;
    }

    // Primary was somewhere else (resource/debug). Keep the cargo source tree updated too.
    if cargo_root.exists() || cargo_package.exists() {
        return Some(cargo_package);
    }

    // Fallback: same platform dir name under cargo binaries when primary was a different root.
    let alt = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(platform_dir.file_name()?)
        .join("pi-package");
    let alt_norm = normalize_child_path(alt.clone());
    if alt_norm != target_norm && (alt.exists() || alt.parent().is_some_and(|p| p.exists())) {
        Some(alt)
    } else {
        None
    }
}

fn bundled_platform_dir(app: &AppHandle) -> Option<PathBuf> {
    let platform = platform_binaries_dir().ok()?;
    for root in candidate_binaries_roots(app) {
        let dir = root.join(platform);
        if bundled_pi_command(&dir).is_some() {
            return Some(dir);
        }
    }
    // Prefer the cargo binaries dir for first-time installs in dev.
    let fallback = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(platform);
    if fallback.exists() {
        Some(fallback)
    } else {
        None
    }
}

fn is_dir_writable(path: &Path) -> bool {
    let probe = path.join(".pi-studio-write-probe");
    match File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    create_dir_all(dst).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(src).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            if let Some(parent) = target.parent() {
                create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::copy(entry.path(), &target).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn extract_semver(text: &str) -> Option<String> {
    let re = regex_lite_semver(text)?;
    Some(re)
}

/// Minimal semver extractor without extra crate dependency.
fn regex_lite_semver(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let start = index;
            let mut dots = 0;
            let mut end = index;
            while end < bytes.len() {
                let ch = bytes[end];
                if ch.is_ascii_digit() {
                    end += 1;
                    continue;
                }
                if ch == b'.' {
                    dots += 1;
                    end += 1;
                    continue;
                }
                break;
            }
            if dots >= 2 {
                let candidate = &text[start..end];
                if candidate.split('.').count() >= 3 {
                    return Some(candidate.trim_end_matches('.').to_string());
                }
            }
            index = end.max(index + 1);
        } else {
            index += 1;
        }
    }
    None
}

fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let cleaned = version.trim().trim_start_matches('v');
    let parts = cleaned
        .split(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .next()
        .unwrap_or(cleaned)
        .split('.')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn is_version_newer(latest: &str, current: &str) -> bool {
    let Some(latest_parts) = parse_version_parts(latest) else {
        return false;
    };
    let Some(current_parts) = parse_version_parts(current) else {
        return true;
    };
    let max_len = latest_parts.len().max(current_parts.len());
    for index in 0..max_len {
        let left = latest_parts.get(index).copied().unwrap_or(0);
        let right = current_parts.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}
