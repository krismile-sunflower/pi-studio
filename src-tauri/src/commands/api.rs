use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};
use url::Url;

use crate::commands::files::{list_files_inner, open_path};
use crate::commands::sessions::{
    delete_session, empty_sessions, live_tau_instances, search_sessions, session_file,
};
use crate::commands::sidecar::{
    active_instance_for_port, base_url_for_port, is_compatible_tau_port, lock_err,
    start_pi_process, StartPiRequest,
};
use crate::settings;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRequest {
    pub path: String,
    pub method: String,
    pub body: Option<String>,
    pub instance_port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

#[tauri::command]
pub async fn api_request(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    if is_desktop_local_path(&request.path) {
        return local_response(app, state, request).await;
    }

    if let Some(port) = proxy_port(&state, request.instance_port) {
        if is_compatible_tau_port(port).await {
            if let Ok(response) = proxy_to_tau(&state, &request).await {
                return Ok(response);
            }
        }
    }

    local_response(app, state, request).await
}

fn proxy_port(state: &State<'_, AppState>, instance_port: Option<u16>) -> Option<u16> {
    active_instance_for_port(state, instance_port).map(|instance| instance.port)
}

fn is_desktop_local_path(path: &str) -> bool {
    let parsed = Url::parse(&format!("tau://desktop{path}"));
    let Ok(parsed) = parsed else {
        return false;
    };
    let path = parsed.path();
    matches!(
        path,
        "/api/health" | "/api/projects" | "/api/instances" | "/api/projects/launch"
    ) || path == "/api/search"
        || path == "/api/sessions"
        || path == "/api/sessions/delete"
        || path.starts_with("/api/sessions/")
}

async fn proxy_to_tau(
    state: &State<'_, AppState>,
    request: &ApiRequest,
) -> Result<ApiResponse, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}{}",
        base_url_for_port(state, request.instance_port),
        request.path
    );
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|err| err.to_string())?;

    let mut builder = client.request(method, url);
    if let Some(body) = &request.body {
        builder = builder
            .header("content-type", "application/json")
            .body(body.clone());
    }

    let response = builder.send().await.map_err(|err| err.to_string())?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let body = response.text().await.map_err(|err| err.to_string())?;

    Ok(ApiResponse {
        status,
        content_type,
        body,
    })
}

async fn local_response(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    let parsed = Url::parse(&format!("tau://desktop{}", request.path))
        .map_err(|err| format!("Invalid API path `{}`: {err}", request.path))?;
    let path = parsed.path();

    let value = match (request.method.as_str(), path) {
        ("GET", "/api/health") => {
            let running = state
                .active_instance
                .lock()
                .map_err(lock_err)?
                .as_ref()
                .map(|instance| {
                    json!({
                        "pid": instance.pid,
                        "port": instance.port,
                        "projectPath": instance.project_path,
                        "noFolder": instance.no_folder,
                        "startedAt": instance.started_at
                    })
                });
            json!({
                "ok": true,
                "mode": "desktop",
                "platform": std::env::consts::OS,
                "pi": running
            })
        }
        ("GET", "/api/files") => {
            let dir = parsed
                .query_pairs()
                .find(|(key, _)| key == "path")
                .map(|(_, value)| PathBuf::from(value.to_string()));
            serde_json::to_value(
                list_files_inner(dir)
                    .map_err(|err| format!("Failed to list files through local fallback: {err}"))?,
            )
            .map_err(|err| err.to_string())?
        }
        ("POST", "/api/open") => {
            let body = request
                .body
                .as_deref()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok())
                .unwrap_or_default();
            if let Some(file_path) = body.get("filePath").and_then(|value| value.as_str()) {
                open_path(&app, &PathBuf::from(file_path))?;
            }
            json!({ "ok": true })
        }
        ("GET", "/api/projects") => {
            let active_instance = active_instance_for_port(&state, request.instance_port);
            let active_path = active_instance
                .as_ref()
                .filter(|instance| !instance.no_folder)
                .map(|instance| instance.project_path.clone());
            let no_folder_active = active_instance
                .as_ref()
                .map(|instance| instance.no_folder)
                .unwrap_or_else(|| settings::load().no_folder_mode);
            let projects: Vec<_> = settings::load()
                .projects
                .into_iter()
                .map(|project| {
                    let active = active_path
                        .as_ref()
                        .map(|path| path == &project.path)
                        .unwrap_or(false);
                    json!({
                        "path": project.path,
                        "name": project.name,
                        "active": active,
                        "lastActive": project.last_active,
                        "sessionCount": project.session_count
                    })
                })
                .collect();
            json!({ "projects": projects, "noFolderActive": no_folder_active })
        }
        ("GET", "/api/instances") => {
            let mut instances: Vec<serde_json::Value> = settings::load_runtime_instances()
                .into_iter()
                .filter(|instance| {
                    state
                        .pi_children
                        .lock()
                        .map(|children| children.contains_key(&instance.pid))
                        .unwrap_or(false)
                })
                .filter_map(|instance| serde_json::to_value(instance).ok())
                .collect();

            for live in live_tau_instances() {
                let Some(port) = live.get("port").and_then(|value| value.as_u64()) else {
                    continue;
                };
                if !is_compatible_tau_port(port as u16).await {
                    continue;
                }

                if instances.iter().any(|instance| {
                    instance.get("port").and_then(|value| value.as_u64()) == Some(port)
                }) {
                    if let Some(existing) = instances.iter_mut().find(|instance| {
                        instance.get("port").and_then(|value| value.as_u64()) == Some(port)
                    }) {
                        if let Some(map) = existing.as_object_mut() {
                            if let Some(live_map) = live.as_object() {
                                for (key, value) in live_map {
                                    map.insert(key.clone(), value.clone());
                                }
                            }
                            if let Some(cwd) = live
                                .get("cwd")
                                .and_then(|value| value.as_str())
                                .map(str::to_string)
                            {
                                map.insert("projectPath".into(), json!(cwd));
                            }
                        }
                    }
                    continue;
                }

                let mut live = live;
                if let Some(map) = live.as_object_mut() {
                    if let Some(cwd) = map
                        .get("cwd")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                    {
                        map.insert("projectPath".into(), json!(cwd));
                    }
                }
                instances.push(live);
            }

            json!({ "instances": instances })
        }
        ("GET", "/api/sessions") => empty_sessions(),
        ("GET", "/api/search") => {
            let query = parsed
                .query_pairs()
                .find(|(key, _)| key == "q")
                .map(|(_, value)| value.to_string())
                .unwrap_or_default();
            search_sessions(&query)
        }
        ("POST", "/api/rpc") => json!({
            "success": false,
            "error": "Pi is not connected yet. Start Pi from the desktop launcher or run a Tau-enabled Pi session."
        }),
        ("POST", "/api/projects/launch") => {
            let body = request
                .body
                .as_deref()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok())
                .unwrap_or_default();
            let no_folder = body
                .get("noFolder")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let path = if no_folder {
                None
            } else {
                Some(
                    body.get("path")
                        .and_then(|value| value.as_str())
                        .ok_or_else(|| "Missing project path".to_string())?
                        .to_string(),
                )
            };
            let instance = start_pi_process(
                app.clone(),
                state,
                StartPiRequest {
                    path,
                    no_folder: Some(no_folder),
                    port: None,
                },
            )
            .await?;
            json!({ "ok": true, "instance": instance })
        }
        ("POST", "/api/sessions/switch") => json!({ "ok": false }),
        ("POST", "/api/sessions/delete") => {
            let body = request
                .body
                .as_deref()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok())
                .unwrap_or_default();
            let file_path = body
                .get("filePath")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "Missing session file path".to_string())?;
            delete_session(file_path)?
        }
        _ => {
            let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
            if request.method == "GET"
                && parts.len() == 4
                && parts[0] == "api"
                && parts[1] == "sessions"
            {
                return Ok(ApiResponse {
                    status: 200,
                    content_type: "application/json".into(),
                    body: session_file(parts[2], parts[3])?.to_string(),
                });
            }
            return Ok(ApiResponse {
                status: 404,
                content_type: "application/json".into(),
                body: json!({ "error": format!("No desktop fallback for {path}") }).to_string(),
            });
        }
    };

    Ok(ApiResponse {
        status: 200,
        content_type: "application/json".into(),
        body: value.to_string(),
    })
}
