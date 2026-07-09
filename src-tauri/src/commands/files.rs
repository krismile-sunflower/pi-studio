use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesRequest {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    pub mtime: Option<u128>,
}

#[derive(Debug, Serialize)]
pub struct FileListResponse {
    pub path: String,
    pub items: Vec<FileItem>,
}

#[tauri::command]
pub async fn list_files(request: ListFilesRequest) -> Result<FileListResponse, String> {
    list_files_inner(request.path.map(PathBuf::from))
}

pub fn list_files_inner(path: Option<PathBuf>) -> Result<FileListResponse, String> {
    let dir =
        path.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let ignored = [
        "node_modules",
        ".git",
        "__pycache__",
        ".next",
        "dist",
        "target",
        ".upstream-tau",
    ];

    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if ignored.contains(&name.as_str()) {
            continue;
        }
        if name.starts_with('.') && name != ".env" {
            continue;
        }

        let path = entry.path();
        let metadata = entry.metadata().ok();
        let is_directory = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata
            .as_ref()
            .and_then(|m| if m.is_file() { Some(m.len()) } else { None });
        let mtime = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());

        items.push(FileItem {
            name,
            path: path.display().to_string(),
            is_directory,
            size,
            mtime,
        });
    }

    items.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileListResponse {
        path: dir.display().to_string(),
        items,
    })
}

pub fn open_path(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}
