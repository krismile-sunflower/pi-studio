use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::PiInstance;

const APP_CONFIG_DIR: &str = "pi-studio";
const LEGACY_CONFIG_DIR: &str = "tau-desktop";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProject {
    pub path: String,
    pub name: String,
    pub last_active: Option<u128>,
    pub session_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub projects: Vec<DesktopProject>,
    pub default_project_path: Option<String>,
    #[serde(default)]
    pub no_folder_mode: bool,
    pub tau_port: u16,
    pub minimize_to_tray: bool,
    pub autostart: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            projects: default_projects(),
            default_project_path: None,
            no_folder_mode: false,
            tau_port: 3001,
            minimize_to_tray: true,
            autostart: false,
        }
    }
}

pub fn load() -> DesktopSettings {
    let Some(path) = settings_read_path() else {
        return DesktopSettings::default();
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(settings: &DesktopSettings) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "Could not resolve settings directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())
}

pub fn upsert_project(path: String) -> Result<DesktopSettings, String> {
    let mut settings = load();
    let name = PathBuf::from(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| path.clone());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    if let Some(project) = settings
        .projects
        .iter_mut()
        .find(|project| project.path == path)
    {
        project.name = name;
        project.last_active = Some(now);
    } else {
        settings.projects.push(DesktopProject {
            path: path.clone(),
            name,
            last_active: Some(now),
            session_count: 0,
        });
    }
    settings.default_project_path = Some(path);
    settings.no_folder_mode = false;
    save(&settings)?;
    Ok(settings)
}

#[derive(Debug, Clone)]
pub struct LaunchTarget {
    pub path: String,
    pub no_folder: bool,
}

pub fn activate_no_folder() -> Result<DesktopSettings, String> {
    let mut settings = load();
    settings.no_folder_mode = true;
    save(&settings)?;
    Ok(settings)
}

pub fn no_folder_launch_path() -> Result<String, String> {
    let dir = dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .ok_or_else(|| "Could not resolve app data directory".to_string())?
        .join(APP_CONFIG_DIR)
        .join("no-folder");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.display().to_string())
}

pub fn default_launch_target() -> Result<LaunchTarget, String> {
    if std::env::var("PI_DESKTOP_NO_FOLDER").ok().as_deref() == Some("1") {
        return Ok(LaunchTarget {
            path: no_folder_launch_path()?,
            no_folder: true,
        });
    }

    if let Ok(path) = std::env::var("PI_DESKTOP_PROJECT") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(LaunchTarget {
                path: path.display().to_string(),
                no_folder: false,
            });
        }
    }

    let settings = load();
    if settings.no_folder_mode {
        return Ok(LaunchTarget {
            path: no_folder_launch_path()?,
            no_folder: true,
        });
    }

    if let Some(path) = settings.default_project_path {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(LaunchTarget {
                path: path.display().to_string(),
                no_folder: false,
            });
        }
    }

    let mut projects = settings.projects;
    projects.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    for project in projects {
        let path = PathBuf::from(project.path);
        if path.exists() {
            return Ok(LaunchTarget {
                path: path.display().to_string(),
                no_folder: false,
            });
        }
    }

    if let Ok(path) = std::env::current_dir() {
        if path.exists() {
            return Ok(LaunchTarget {
                path: path.display().to_string(),
                no_folder: false,
            });
        }
    }

    if let Some(path) = dirs::home_dir() {
        if path.exists() {
            return Ok(LaunchTarget {
                path: path.display().to_string(),
                no_folder: false,
            });
        }
    }

    Err("Could not find a valid directory for starting Pi.".to_string())
}

pub fn load_runtime_instances() -> Vec<PiInstance> {
    let Some(path) = runtime_instances_read_path() else {
        return Vec::new();
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn upsert_runtime_instance(instance: PiInstance) {
    let Some(path) = runtime_instances_path() else {
        return;
    };
    let mut instances = load_runtime_instances();
    instances.retain(|item| item.pid != instance.pid && item.port != instance.port);
    instances.push(instance);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(&instances) {
        let _ = fs::write(path, raw);
    }
}

pub fn remove_runtime_instance(pid: u32) {
    let Some(path) = runtime_instances_path() else {
        return;
    };
    let mut instances = load_runtime_instances();
    instances.retain(|item| item.pid != pid);
    if let Ok(raw) = serde_json::to_string_pretty(&instances) {
        let _ = fs::write(path, raw);
    }
}

fn settings_path() -> Option<PathBuf> {
    config_path("settings.json")
}

fn settings_read_path() -> Option<PathBuf> {
    config_read_path("settings.json")
}

fn runtime_instances_path() -> Option<PathBuf> {
    config_path("instances.json")
}

fn runtime_instances_read_path() -> Option<PathBuf> {
    config_read_path("instances.json")
}

fn config_path(filename: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(APP_CONFIG_DIR).join(filename))
}

fn config_read_path(filename: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| {
        let current = dir.join(APP_CONFIG_DIR).join(filename);
        let legacy = dir.join(LEGACY_CONFIG_DIR).join(filename);
        if current.exists() || !legacy.exists() {
            current
        } else {
            legacy
        }
    })
}

fn default_projects() -> Vec<DesktopProject> {
    let cwd = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| ".".into());
    let name = PathBuf::from(&cwd)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Current workspace")
        .to_string();

    vec![DesktopProject {
        path: cwd,
        name,
        last_active: None,
        session_count: 0,
    }]
}
