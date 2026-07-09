mod commands;
mod settings;
mod tray;
mod ws;

use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiInstance {
    pub pid: u32,
    pub port: u16,
    pub project_path: String,
    #[serde(default)]
    pub no_folder: bool,
    pub started_at: String,
}

#[derive(Default)]
pub struct AppState {
    pub pi_children: Mutex<HashMap<u32, Child>>,
    pub active_pid: Mutex<Option<u32>>,
    pub active_instance: Mutex<Option<PiInstance>>,
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
                            let _ =
                                tauri::Emitter::emit(app, "pi-studio-command", "show-launcher");
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
            ws::client::ws_connect,
            ws::client::ws_disconnect,
            ws::client::ws_send,
        ])
        .setup(|app| {
            tray::install(app.handle())?;
            tray::install_menu(app.handle())?;
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(target) = settings::default_launch_target() {
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
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running pi-studio");
}
