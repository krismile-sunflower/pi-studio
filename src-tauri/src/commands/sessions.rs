use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub fn empty_sessions() -> serde_json::Value {
    sessions_list().unwrap_or_else(|_| json!({ "projects": [] }))
}

#[tauri::command]
pub async fn list_local_sessions() -> Result<Value, String> {
    sessions_list()
}

pub fn empty_search() -> serde_json::Value {
    json!({ "results": [] })
}

pub fn search_sessions(query: &str) -> Value {
    if query.trim().len() < 2 {
        return empty_search();
    }

    let q = query.to_lowercase();
    let mut results = Vec::new();
    let Some(root) = sessions_dir() else {
        return empty_search();
    };

    let Ok(project_dirs) = fs::read_dir(root) else {
        return empty_search();
    };

    for project in project_dirs.flatten().filter(|entry| entry.path().is_dir()) {
        let dir_name = project.file_name().to_string_lossy().to_string();
        let project_path = decode_project_dir(&dir_name);
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };

        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(result) = search_file(&path, &q, &project_path) {
                results.push(result);
            }
            if results.len() >= 30 {
                return json!({ "results": results });
            }
        }
    }

    json!({ "results": results })
}

pub fn session_file(dir_name: &str, file: &str) -> Result<Value, String> {
    let path = sessions_dir()
        .ok_or_else(|| "Could not resolve Pi sessions directory".to_string())?
        .join(dir_name)
        .join(file);

    let reader = BufReader::new(fs::File::open(path).map_err(|err| err.to_string())?);
    let entries: Vec<Value> = reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect();
    Ok(json!({ "entries": entries }))
}

pub fn delete_session(file_path: &str) -> Result<Value, String> {
    fs::remove_file(file_path).map_err(|err| err.to_string())?;
    Ok(json!({ "ok": true }))
}

fn sessions_list() -> Result<Value, String> {
    let root =
        sessions_dir().ok_or_else(|| "Could not resolve Pi sessions directory".to_string())?;
    if !root.exists() {
        return Ok(json!({ "projects": [] }));
    }

    let mut projects = Vec::new();
    for project in fs::read_dir(root).map_err(|err| err.to_string())? {
        let project = project.map_err(|err| err.to_string())?;
        if !project.path().is_dir() {
            continue;
        }

        let dir_name = project.file_name().to_string_lossy().to_string();
        let mut sessions = Vec::new();
        for file in fs::read_dir(project.path()).map_err(|err| err.to_string())? {
            let file = file.map_err(|err| err.to_string())?;
            let path = file.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(summary) = summarize_session(&path) {
                let metadata = file.metadata().ok();
                sessions.push(json!({
                    "file": file.file_name().to_string_lossy(),
                    "filePath": path.display().to_string(),
                    "mtime": metadata.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or_default(),
                    "id": summary.id,
                    "timestamp": summary.timestamp,
                    "name": summary.name,
                    "firstMessage": summary.first_message,
                    "cwd": summary.cwd
                }));
            }
        }
        sessions.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
        if !sessions.is_empty() {
            let project_path = sessions
                .iter()
                .find_map(|session| session["cwd"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| decode_project_dir(&dir_name));
            projects.push(json!({
                "path": project_path,
                "dirName": dir_name,
                "sessions": sessions
            }));
        }
    }

    projects.sort_by(|a, b| {
        b["sessions"][0]["mtime"]
            .as_u64()
            .cmp(&a["sessions"][0]["mtime"].as_u64())
    });
    Ok(json!({ "projects": projects }))
}

struct SessionSummary {
    id: String,
    timestamp: String,
    name: Option<String>,
    first_message: Option<String>,
    cwd: Option<String>,
}

fn summarize_session(path: &Path) -> Option<SessionSummary> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    let mut id = String::new();
    let mut timestamp = String::new();
    let mut name = None;
    let mut first_message = None;
    let mut cwd = None;
    let mut line_count = 0;

    for line in reader.lines().map_while(Result::ok).take(80) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        line_count += 1;
        match value.get("type").and_then(|value| value.as_str()) {
            Some("session") => {
                id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                timestamp = value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                cwd = value
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            Some("session_info") => {
                name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            Some("message") if first_message.is_none() => {
                if value["message"]["role"].as_str() == Some("user") {
                    first_message = message_text(&value["message"])
                        .map(|text| text.chars().take(120).collect::<String>());
                }
            }
            _ => {}
        }
    }

    if id.is_empty() || line_count <= 1 {
        return None;
    }

    Some(SessionSummary {
        id,
        timestamp,
        name,
        first_message,
        cwd,
    })
}

fn search_file(path: &Path, q: &str, project_path: &str) -> Option<Value> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    let mut session_id = String::new();
    let mut session_name = String::new();
    let mut session_timestamp = String::new();
    let mut first_message = String::new();
    let mut matches = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(|value| value.as_str()) {
            Some("session") => {
                session_id = value["id"].as_str().unwrap_or("").to_string();
                session_timestamp = value["timestamp"].as_str().unwrap_or("").to_string();
            }
            Some("session_info") => {
                session_name = value["name"].as_str().unwrap_or("").to_string();
            }
            Some("message") => {
                let Some(text) = message_text(&value["message"]) else {
                    continue;
                };
                if first_message.is_empty() && value["message"]["role"].as_str() == Some("user") {
                    first_message = text.chars().take(120).collect();
                }
                let lower = text.to_lowercase();
                if let Some(idx) = lower.find(q) {
                    let start = text[..idx].chars().count().saturating_sub(60);
                    let end = text[..(idx + q.len()).min(text.len())].chars().count() + 60;
                    let snippet = text
                        .chars()
                        .skip(start)
                        .take(end.saturating_sub(start))
                        .collect::<String>();
                    matches.push(json!({
                        "role": value["message"]["role"].as_str().unwrap_or("unknown"),
                        "snippet": snippet.replace('\n', " ")
                    }));
                    if matches.len() >= 3 {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    if matches.is_empty() {
        None
    } else {
        Some(json!({
            "filePath": path.display().to_string(),
            "project": project_path,
            "sessionId": session_id,
            "sessionName": session_name,
            "sessionTimestamp": session_timestamp,
            "firstMessage": first_message,
            "matches": matches
        }))
    }
}

fn message_text(message: &Value) -> Option<String> {
    let content = &message["content"];
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = content.as_array() {
        let text = items
            .iter()
            .filter(|item| item["type"].as_str() == Some("text"))
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

fn sessions_dir() -> Option<PathBuf> {
    std::env::var("PI_CODING_AGENT_SESSION_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent").join("sessions")))
}

fn decode_project_dir(dir_name: &str) -> String {
    dir_name
        .trim_start_matches("--")
        .trim_end_matches("--")
        .replace('-', "/")
}
