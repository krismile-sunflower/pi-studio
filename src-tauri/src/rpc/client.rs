use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStderr, ChildStdin, ChildStdout};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::commands::sidecar::lock_err;
use crate::{settings, AppState, RpcPending};

const RPC_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RPC_READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcConnectRequest {
    pub pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRpcSendRequest {
    pub pid: Option<u32>,
    pub message: String,
}

#[tauri::command]
pub async fn pi_rpc_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PiRpcConnectRequest,
) -> Result<(), String> {
    let pid = resolve_pid(state.inner(), request.pid)?;
    ensure_rpc_writer(state.inner(), pid)?;
    let _ = app.emit(
        "pi-rpc-status",
        json!({ "pid": pid, "status": "connected" }),
    );
    emit_snapshot(app, state.inner(), pid).await;
    Ok(())
}

#[tauri::command]
pub async fn pi_rpc_disconnect(_state: State<'_, AppState>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pi_rpc_send(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PiRpcSendRequest,
) -> Result<(), String> {
    let pid = resolve_pid(state.inner(), request.pid)?;
    let mut value = serde_json::from_str::<Value>(&request.message)
        .map_err(|err| format!("Invalid Pi RPC message: {err}"))?;

    if value.get("type").and_then(Value::as_str) == Some("mirror_sync_request") {
        emit_snapshot(app, state.inner(), pid).await;
        return Ok(());
    }

    adapt_legacy_command(&mut value);
    send_rpc_value(state.inner(), pid, &value)
}

pub fn register_rpc_io(
    app: AppHandle,
    state: &AppState,
    pid: u32,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    stdout_log: Option<File>,
    stderr_log: Option<File>,
) -> Result<(), String> {
    state
        .rpc_writers
        .lock()
        .map_err(lock_err)?
        .insert(pid, stdin);
    spawn_stdout_reader(app.clone(), pid, stdout, stdout_log);
    spawn_stderr_reader(app, pid, stderr, stderr_log);
    Ok(())
}

pub fn clear_rpc_process(state: &AppState, pid: u32) {
    if let Ok(mut writers) = state.rpc_writers.lock() {
        writers.remove(&pid);
    }

    if let Ok(mut pending) = state.rpc_pending.lock() {
        pending.retain(|_, item| item.pid != pid);
    }
}

pub async fn wait_for_rpc_ready(state: &AppState, pid: u32) -> bool {
    request_rpc_with_timeout(
        state,
        Some(pid),
        json!({ "type": "get_state" }),
        RPC_READY_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|value| value.get("success").and_then(Value::as_bool))
    .unwrap_or(false)
}

pub async fn request_rpc(
    state: &AppState,
    pid: Option<u32>,
    command: Value,
) -> Result<Value, String> {
    request_rpc_with_timeout(state, pid, command, RPC_REQUEST_TIMEOUT).await
}

async fn request_rpc_with_timeout(
    state: &AppState,
    pid: Option<u32>,
    mut command: Value,
    request_timeout: Duration,
) -> Result<Value, String> {
    let pid = resolve_pid(state, pid)?;
    adapt_legacy_command(&mut command);

    let id = command
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let next = state.rpc_next_id.fetch_add(1, Ordering::Relaxed) + 1;
            format!("pi-studio-rpc-{pid}-{next}")
        });
    command["id"] = Value::String(id.clone());

    let (sender, receiver) = oneshot::channel();
    state
        .rpc_pending
        .lock()
        .map_err(lock_err)?
        .insert(id.clone(), RpcPending { pid, sender });

    if let Err(err) = send_rpc_value(state, pid, &command) {
        let _ = state
            .rpc_pending
            .lock()
            .map(|mut pending| pending.remove(&id));
        return Err(err);
    }

    match timeout(request_timeout, receiver).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("Pi RPC response channel closed".to_string()),
        Err(_) => {
            let _ = state
                .rpc_pending
                .lock()
                .map(|mut pending| pending.remove(&id));
            Err(format!(
                "Timed out waiting for Pi RPC response to {}",
                command
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            ))
        }
    }
}

pub async fn build_snapshot(state: &AppState, pid: u32) -> Result<Value, String> {
    let state_response = request_rpc(state, Some(pid), json!({ "type": "get_state" })).await?;
    if state_response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(state_response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Failed to read Pi RPC state")
            .to_string());
    }

    let data = state_response
        .get("data")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let entries_response = request_rpc(state, Some(pid), json!({ "type": "get_entries" }))
        .await
        .ok();
    let entries = entries_response
        .as_ref()
        .and_then(|value| value.get("data"))
        .and_then(|value| value.get("entries"))
        .cloned()
        .unwrap_or_else(|| json!([]));

    if let Some(session_file) = data.get("sessionFile").and_then(Value::as_str) {
        update_instance_session_file(state, pid, session_file.to_string());
    }

    Ok(json!({
        "type": "mirror_sync",
        "entries": entries,
        "model": data.get("model").cloned().unwrap_or(Value::Null),
        "thinkingLevel": data.get("thinkingLevel").cloned().unwrap_or_else(|| json!("off")),
        "sessionName": data.get("sessionName").cloned().unwrap_or(Value::Null),
        "sessionFile": data.get("sessionFile").cloned().unwrap_or(Value::Null),
        "isStreaming": data.get("isStreaming").cloned().unwrap_or_else(|| json!(false)),
        "contextUsage": data.get("contextUsage").cloned().unwrap_or(Value::Null),
    }))
}

pub async fn emit_snapshot(app: AppHandle, state: &AppState, pid: u32) {
    match build_snapshot(state, pid).await {
        Ok(snapshot) => emit_rpc_message(&app, pid, snapshot),
        Err(error) => {
            let _ = app.emit("pi-rpc-error", json!({ "pid": pid, "error": error }));
        }
    }
}

pub fn update_instance_session_file(state: &AppState, pid: u32, session_file: String) {
    if let Ok(mut active) = state.active_instance.lock() {
        if let Some(instance) = active.as_mut().filter(|instance| instance.pid == pid) {
            instance.session_file = Some(session_file.clone());
            settings::upsert_runtime_instance(instance.clone());
            return;
        }
    }

    if let Some(mut instance) = settings::load_runtime_instances()
        .into_iter()
        .find(|instance| instance.pid == pid)
    {
        instance.session_file = Some(session_file);
        settings::upsert_runtime_instance(instance);
    }
}

pub fn adapt_legacy_command(command: &mut Value) {
    if command.get("type").and_then(Value::as_str) == Some("switch_session")
        && command.get("sessionPath").is_none()
    {
        if let Some(session_file) = command.get("sessionFile").cloned() {
            command["sessionPath"] = session_file;
        }
    }
}

fn resolve_pid(state: &AppState, pid: Option<u32>) -> Result<u32, String> {
    if let Some(pid) = pid {
        return Ok(pid);
    }

    state.active_pid.lock().map_err(lock_err)?.ok_or_else(|| {
        "No active bundled Pi session. Open Projects and start a project first.".to_string()
    })
}

fn ensure_rpc_writer(state: &AppState, pid: u32) -> Result<(), String> {
    if state
        .rpc_writers
        .lock()
        .map_err(lock_err)?
        .contains_key(&pid)
    {
        Ok(())
    } else {
        Err(format!("Pi RPC session {pid} is not connected"))
    }
}

fn send_rpc_value(state: &AppState, pid: u32, value: &Value) -> Result<(), String> {
    let mut raw = serde_json::to_string(value).map_err(|err| err.to_string())?;
    raw.push('\n');

    let mut writers = state.rpc_writers.lock().map_err(lock_err)?;
    let writer = writers
        .get_mut(&pid)
        .ok_or_else(|| format!("Pi RPC session {pid} is not connected"))?;
    writer
        .write_all(raw.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|err| format!("Failed to write Pi RPC command: {err}"))
}

fn spawn_stdout_reader(app: AppHandle, pid: u32, stdout: ChildStdout, mut log: Option<File>) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if let Some(log) = log.as_mut() {
                let _ = writeln!(log, "{line}");
            }
            handle_stdout_line(&app, pid, &line);
        }
        let _ = app.emit(
            "pi-rpc-status",
            json!({ "pid": pid, "status": "disconnected" }),
        );
    });
}

fn spawn_stderr_reader(app: AppHandle, pid: u32, stderr: ChildStderr, mut log: Option<File>) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(log) = log.as_mut() {
                let _ = writeln!(log, "{line}");
            }
        }
        let _ = app.emit("pi-rpc-stderr-closed", json!({ "pid": pid }));
    });
}

fn handle_stdout_line(app: &AppHandle, pid: u32, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        let _ = app.emit(
            "pi-rpc-error",
            json!({ "pid": pid, "error": format!("Non-JSON Pi RPC output: {line}") }),
        );
        return;
    };

    if value.get("type").and_then(Value::as_str) == Some("response") {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            let state = app.state::<AppState>();
            let pending = {
                let mut pending = match state.rpc_pending.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                match pending.remove(id) {
                    Some(item) if item.pid == pid => Some(item),
                    Some(item) => {
                        pending.insert(id.to_string(), item);
                        None
                    }
                    None => None,
                }
            };

            if let Some(pending) = pending {
                let _ = pending.sender.send(value);
                return;
            }
        }
    }

    emit_rpc_message(app, pid, value);
}

fn emit_rpc_message(app: &AppHandle, pid: u32, message: Value) {
    let _ = app.emit("pi-rpc-message", json!({ "pid": pid, "message": message }));
}
