use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::commands::sidecar::{active_ws_url, is_compatible_tau_port, lock_err};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnectRequest {
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WsSendRequest {
    pub message: String,
}

#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WsConnectRequest,
) -> Result<(), String> {
    let url = match request.url {
        Some(url) => url,
        None => active_ws_url(&state).ok_or_else(|| {
            "No active bundled Pi session. Open Projects and start a project first.".to_string()
        })?,
    };
    if let Some(port) = ws_port(&url) {
        if !is_compatible_tau_port(port).await {
            return Err(format!(
                "Incompatible Tau mirror at port {port}. Start a new bundled Pi session."
            ));
        }
    }
    let (stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|err| format!("Failed to connect pi-studio WebSocket at {url}: {err}"))?;
    let (mut write, mut read) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    *state.ws_sender.lock().map_err(lock_err)? = Some(tx);

    let writer_app = app.clone();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if write.send(Message::Text(message.into())).await.is_err() {
                let _ = writer_app.emit("tau-ws-status", "disconnected");
                break;
            }
        }
    });

    let reader_app = app.clone();
    tokio::spawn(async move {
        let _ = reader_app.emit("tau-ws-status", "connected");
        while let Some(next) = read.next().await {
            match next {
                Ok(Message::Text(text)) => {
                    maybe_notify_agent_end(&reader_app, &text);
                    let _ = reader_app.emit("tau-ws-message", text.to_string());
                }
                Ok(Message::Binary(bytes)) => {
                    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                        maybe_notify_agent_end(&reader_app, &text);
                        let _ = reader_app.emit("tau-ws-message", text);
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => {
                    let _ = reader_app.emit("tau-ws-error", err.to_string());
                    break;
                }
            }
        }
        let _ = reader_app.emit("tau-ws-status", "disconnected");
    });

    Ok(())
}

fn ws_port(url: &str) -> Option<u16> {
    url::Url::parse(url).ok()?.port()
}

fn maybe_notify_agent_end(app: &AppHandle, text: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let event_type = value
        .get("event")
        .and_then(|event| event.get("type"))
        .and_then(|value| value.as_str());

    if event_type == Some("agent_end") {
        let _ = app
            .notification()
            .builder()
            .title("pi-studio")
            .body("Pi finished the current task.")
            .auto_cancel()
            .show();
    }
}

#[tauri::command]
pub async fn ws_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.ws_sender.lock().map_err(lock_err)? = None;
    Ok(())
}

#[tauri::command]
pub async fn ws_send(state: State<'_, AppState>, request: WsSendRequest) -> Result<(), String> {
    let sender = state
        .ws_sender
        .lock()
        .map_err(lock_err)?
        .clone()
        .ok_or_else(|| "pi-studio WebSocket is not connected".to_string())?;

    sender
        .send(request.message)
        .map_err(|_| "pi-studio WebSocket writer is closed".to_string())
}
