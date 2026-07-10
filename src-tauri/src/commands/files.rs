use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const TEXT_PREVIEW_LIMIT: u64 = 1024 * 1024;
const IMAGE_PREVIEW_LIMIT: u64 = 8 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResponse {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: String,
    pub size: u64,
    pub mtime: Option<u128>,
    pub content: Option<String>,
    pub encoding: Option<String>,
    pub truncated: bool,
    pub language: String,
    pub reason: Option<String>,
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

pub fn canonical_workspace_path(root: &Path, requested: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root)
        .map_err(|err| format!("Failed to resolve workspace root {}: {err}", root.display()))?;
    let requested = fs::canonicalize(requested)
        .map_err(|err| format!("Failed to resolve file {}: {err}", requested.display()))?;
    if requested != root && !requested.starts_with(&root) {
        return Err("Requested path is outside the active workspace".to_string());
    }
    Ok(requested)
}

pub fn read_file_content(path: &Path) -> Result<FileContentResponse, String> {
    let metadata = fs::metadata(path).map_err(|err| err.to_string())?;
    if !metadata.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }

    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let language = language_for_extension(&extension).to_string();

    if let Some(mime_type) = image_mime_type(&extension) {
        if size > IMAGE_PREVIEW_LIMIT {
            return Ok(unsupported_content(
                path,
                name,
                size,
                mtime,
                language,
                "图片超过 8 MiB，请在 VS Code 中查看。",
            ));
        }
        let bytes = fs::read(path).map_err(|err| err.to_string())?;
        return Ok(FileContentResponse {
            path: path.display().to_string(),
            name,
            kind: "image".into(),
            mime_type: mime_type.into(),
            size,
            mtime,
            content: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            encoding: Some("base64".into()),
            truncated: false,
            language,
            reason: None,
        });
    }

    let truncated = size > TEXT_PREVIEW_LIMIT;
    let mut bytes = Vec::with_capacity(size.min(TEXT_PREVIEW_LIMIT) as usize);
    File::open(path)
        .map_err(|err| err.to_string())?
        .take(TEXT_PREVIEW_LIMIT)
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;

    let text = match std::str::from_utf8(&bytes) {
        Ok(value) => value.to_string(),
        Err(error) if truncated && error.error_len().is_none() => {
            String::from_utf8(bytes[..error.valid_up_to()].to_vec())
                .map_err(|err| err.to_string())?
        }
        Err(_) => {
            return Ok(unsupported_content(
                path,
                name,
                size,
                mtime,
                language,
                "此文件不是可预览的 UTF-8 文本。",
            ))
        }
    };

    Ok(FileContentResponse {
        path: path.display().to_string(),
        name,
        kind: "text".into(),
        mime_type: text_mime_type(&extension).into(),
        size,
        mtime,
        content: Some(text),
        encoding: Some("utf8".into()),
        truncated,
        language,
        reason: None,
    })
}

fn unsupported_content(
    path: &Path,
    name: String,
    size: u64,
    mtime: Option<u128>,
    language: String,
    reason: &str,
) -> FileContentResponse {
    FileContentResponse {
        path: path.display().to_string(),
        name,
        kind: "unsupported".into(),
        mime_type: "application/octet-stream".into(),
        size,
        mtime,
        content: None,
        encoding: None,
        truncated: false,
        language,
        reason: Some(reason.into()),
    }
}

fn image_mime_type(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn text_mime_type(extension: &str) -> &'static str {
    match extension {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        _ => "text/plain",
    }
}

fn language_for_extension(extension: &str) -> &'static str {
    match extension {
        "js" | "mjs" | "cjs" => "javascript",
        "ts" | "mts" | "cts" => "typescript",
        "jsx" => "jsx",
        "tsx" => "tsx",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "rb" => "ruby",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "svg" => "xml",
        "md" | "markdown" => "markdown",
        "sh" | "bash" | "zsh" => "shell",
        _ => "text",
    }
}

pub fn open_path(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|err| err.to_string())
}

pub fn open_in_vscode(
    app: &tauri::AppHandle,
    path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), String> {
    let file_url = Url::from_file_path(path)
        .map_err(|_| format!("Unable to create a VS Code URL for {}", path.display()))?;
    let mut vscode_url = format!("vscode://file{}", file_url.path());
    if let Some(line) = line {
        vscode_url.push_str(&format!(":{}:{}", line.max(1), column.unwrap_or(1).max(1)));
    }
    app.opener()
        .open_url(vscode_url, None::<&str>)
        .map_err(|err| format!("Failed to open VS Code: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("pi-studio-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn workspace_path_rejects_files_outside_root() {
        let root = test_dir("root");
        let outside = test_dir("outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        let inside_file = root.join("inside.txt");
        let outside_file = outside.join("outside.txt");
        fs::write(&inside_file, "inside").expect("write inside");
        fs::write(&outside_file, "outside").expect("write outside");

        assert!(canonical_workspace_path(&root, &inside_file).is_ok());
        assert!(canonical_workspace_path(&root, &outside_file).is_err());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn file_content_distinguishes_text_and_binary() {
        let root = test_dir("preview");
        fs::create_dir_all(&root).expect("create root");
        let text_file = root.join("main.rs");
        let binary_file = root.join("data.bin");
        fs::write(&text_file, "fn main() {}\n").expect("write text");
        fs::write(&binary_file, [0xff, 0xfe, 0xfd]).expect("write binary");

        let text = read_file_content(&text_file).expect("read text");
        assert_eq!(text.kind, "text");
        assert_eq!(text.language, "rust");
        assert_eq!(text.content.as_deref(), Some("fn main() {}\n"));

        let binary = read_file_content(&binary_file).expect("read binary");
        assert_eq!(binary.kind, "unsupported");
        assert!(binary.content.is_none());

        let _ = fs::remove_dir_all(root);
    }
}
