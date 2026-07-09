use serde::Deserialize;
use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use crate::settings::{self, DesktopSettings};
use crate::{
    commands::sidecar::{lock_err, start_pi_process, StartPiRequest},
    AppState, PiInstance,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAutostartRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectWindowRequest {
    pub path: String,
}

#[tauri::command]
pub async fn get_desktop_settings() -> Result<DesktopSettings, String> {
    Ok(settings::load())
}

#[tauri::command]
pub async fn ensure_default_pi_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PiInstance, String> {
    if let Some(instance) = state
        .active_instance
        .lock()
        .map_err(lock_err)?
        .as_ref()
        .cloned()
    {
        let is_running = state
            .pi_children
            .lock()
            .map_err(lock_err)?
            .contains_key(&instance.pid);
        if is_running {
            return Ok(instance);
        }
    }

    let target = settings::default_launch_target()?;
    start_pi_process(
        app,
        state,
        StartPiRequest {
            path: Some(target.path),
            no_folder: Some(target.no_folder),
            port: None,
        },
    )
    .await
}

#[tauri::command]
pub async fn save_desktop_settings(settings: DesktopSettings) -> Result<DesktopSettings, String> {
    settings::save(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn pick_project_folder(app: AppHandle) -> Result<Option<String>, String> {
    let folder = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|path| path.to_string())
    })
    .await
    .map_err(|err| err.to_string())?;

    if let Some(path) = &folder {
        let _ = settings::upsert_project(path.clone())?;
    }

    Ok(folder)
}

#[tauri::command]
pub async fn set_autostart(app: AppHandle, request: SetAutostartRequest) -> Result<bool, String> {
    if request.enabled {
        app.autolaunch().enable().map_err(|err| err.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|err| err.to_string())?;
    }

    let mut settings = settings::load();
    settings.autostart = request.enabled;
    settings::save(&settings)?;

    Ok(request.enabled)
}

#[tauri::command]
pub async fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn notify_desktop(app: AppHandle, request: NotifyRequest) -> Result<(), String> {
    let _ = app
        .notification()
        .builder()
        .title(request.title)
        .body(request.body)
        .auto_cancel()
        .show();
    Ok(())
}

#[tauri::command]
pub async fn open_project_window(
    app: AppHandle,
    state: State<'_, AppState>,
    request: OpenProjectWindowRequest,
) -> Result<(), String> {
    let instance = start_pi_process(
        app.clone(),
        state,
        StartPiRequest {
            path: Some(request.path.clone()),
            no_folder: Some(false),
            port: None,
        },
    )
    .await?;

    let label = format!("tau-{}", instance.pid);
    let url = WebviewUrl::App(format!("index.html?tauPort={}", instance.port).into());
    WebviewWindowBuilder::new(&app, label, url)
        .title(format!("pi-studio - {}", request.path))
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 640.0)
        .build()
        .map_err(|err| err.to_string())?;

    Ok(())
}
