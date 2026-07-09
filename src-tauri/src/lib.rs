mod commands;
mod rpc;
mod settings;
mod tray;
mod ws;

use std::collections::HashMap;
use std::process::{Child, ChildStdin};
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiInstance {
    pub pid: u32,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub transport: PiTransport,
    #[serde(default)]
    pub session_file: Option<String>,
    pub project_path: String,
    #[serde(default)]
    pub no_folder: bool,
    pub started_at: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PiTransport {
    Rpc,
    #[default]
    Mirror,
}

pub struct RpcPending {
    pub pid: u32,
    pub sender: oneshot::Sender<Value>,
}

#[derive(Default)]
pub struct AppState {
    pub pi_children: Mutex<HashMap<u32, Child>>,
    pub active_pid: Mutex<Option<u32>>,
    pub active_instance: Mutex<Option<PiInstance>>,
    pub rpc_writers: Mutex<HashMap<u32, ChildStdin>>,
    pub rpc_pending: Mutex<HashMap<String, RpcPending>>,
    pub rpc_next_id: AtomicU64,
    pub ws_sender: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--from-autostart"]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["Ctrl+Alt+T", "Ctrl+Alt+N"])
                .expect("failed to configure global shortcuts")
                .with_handler(|app, shortcut, event| {
                    if event.state != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }

                    match shortcut.into_string().as_str() {
                        "Ctrl+Alt+T" => tray::toggle_window(app),
                        "Ctrl+Alt+N" => {
                            let _ = tauri::Emitter::emit(app, "pi-studio-command", "show-launcher");
                            tray::show_window(app);
                        }
                        _ => {}
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::api::api_request,
            commands::desktop::get_desktop_settings,
            commands::desktop::ensure_default_pi_session,
            commands::desktop::save_desktop_settings,
            commands::desktop::pick_project_folder,
            commands::desktop::set_autostart,
            commands::desktop::is_autostart_enabled,
            commands::desktop::notify_desktop,
            commands::desktop::open_project_window,
            commands::extensions::install_pi_extension,
            commands::extensions::list_pi_extensions,
            commands::files::list_files,
            commands::sidecar::get_pi_runtime_info,
            commands::sidecar::start_pi,
            commands::sidecar::stop_pi,
            commands::sidecar::list_instances,
            commands::sidecar::switch_instance,
            commands::sessions::list_local_sessions,
            rpc::client::pi_rpc_connect,
            rpc::client::pi_rpc_disconnect,
            rpc::client::pi_rpc_send,
            ws::client::ws_connect,
            ws::client::ws_disconnect,
            ws::client::ws_send,
        ])
        .setup(|app| {
            tray::install(app.handle())?;
            tray::install_menu(app.handle())?;
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                settings::append_desktop_log("setup auto-start task entered");
                match settings::default_launch_target() {
                    Ok(target) => {
                        settings::append_desktop_log(format!(
                            "default target path={} no_folder={}",
                            target.path, target.no_folder
                        ));
                        let state = app_handle.state::<AppState>();
                        if let Err(error) = commands::sidecar::start_pi_process(
                            app_handle.clone(),
                            state,
                            commands::sidecar::StartPiRequest {
                                path: Some(target.path),
                                no_folder: Some(target.no_folder),
                                port: None,
                            },
                        )
                        .await
                        {
                            settings::append_desktop_log(format!("auto-start failed: {error}"));
                            let _ = tauri::Emitter::emit(
                                &app_handle,
                                "tau-pi-status",
                                serde_json::json!({
                                    "status": "error",
                                    "error": error,
                                }),
                            );
                        }
                    }
                    Err(error) => {
                        settings::append_desktop_log(format!(
                            "default target resolution failed: {error}"
                        ));
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pi-studio");
}
