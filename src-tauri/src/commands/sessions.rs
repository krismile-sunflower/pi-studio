use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::settings;

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

pub fn delete_session_entry(
    file_path: &str,
    entry_id: &str,
    include_descendants: bool,
) -> Result<Value, String> {
    let entry_id = entry_id.trim();
    if entry_id.is_empty() {
        return Err("Missing session entry id".to_string());
    }
    let path = PathBuf::from(file_path)
        .canonicalize()
        .map_err(|err| format!("Could not resolve session file: {err}"))?;
    let root = sessions_dir()
        .ok_or_else(|| "Could not resolve Pi sessions directory".to_string())?
        .canonicalize()
        .map_err(|err| format!("Could not resolve Pi sessions directory: {err}"))?;
    if !path.starts_with(&root) || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Session file is outside the Pi sessions directory".to_string());
    }

    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let mut entries = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str::<Value>(line)
                .map_err(|err| format!("Invalid JSONL at line {}: {err}", index + 1))
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries = remove_message_entry(entries, entry_id, include_descendants)?;

    let mut output = String::new();
    for entry in &entries {
        output.push_str(&serde_json::to_string(entry).map_err(|err| err.to_string())?);
        output.push('\n');
    }
    let temp_path = path.with_extension("jsonl.tmp");
    fs::write(&temp_path, output).map_err(|err| err.to_string())?;
    fs::rename(&temp_path, &path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        err.to_string()
    })?;

    Ok(json!({ "ok": true, "entries": entries }))
}

fn remove_message_entry(
    mut entries: Vec<Value>,
    entry_id: &str,
    include_descendants: bool,
) -> Result<Vec<Value>, String> {
    let target_index = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(entry_id))
        .ok_or_else(|| "Session entry not found".to_string())?;
    if entries[target_index].get("type").and_then(Value::as_str) != Some("message") {
        return Err("Only message entries can be deleted".to_string());
    }

    let tool_call_ids = entries[target_index]
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("toolCall"))
        .filter_map(|block| block.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<HashSet<_>>();

    let mut removed_ids = HashSet::from([entry_id.to_string()]);
    if include_descendants {
        loop {
            let descendants = entries
                .iter()
                .filter(|entry| {
                    entry
                        .get("parentId")
                        .and_then(Value::as_str)
                        .is_some_and(|parent| removed_ids.contains(parent))
                })
                .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
                .filter(|id| !removed_ids.contains(id))
                .collect::<Vec<_>>();
            if descendants.is_empty() {
                break;
            }
            removed_ids.extend(descendants);
        }
    }
    for entry in &entries {
        let is_related_tool_result = entry.pointer("/message/role").and_then(Value::as_str)
            == Some("toolResult")
            && entry
                .pointer("/message/toolCallId")
                .and_then(Value::as_str)
                .is_some_and(|id| tool_call_ids.contains(id));
        if is_related_tool_result {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                removed_ids.insert(id.to_string());
            }
        }
    }
    loop {
        let referenced = entries
            .iter()
            .filter(|entry| {
                entry
                    .get("targetId")
                    .and_then(Value::as_str)
                    .is_some_and(|target| removed_ids.contains(target))
            })
            .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
            .filter(|id| !removed_ids.contains(id))
            .collect::<Vec<_>>();
        if referenced.is_empty() {
            break;
        }
        removed_ids.extend(referenced);
    }

    let removed_parents = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            removed_ids
                .contains(id)
                .then(|| (id.to_string(), entry.get("parentId").cloned().unwrap_or(Value::Null)))
        })
        .collect::<HashMap<_, _>>();
    entries.retain(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .map_or(true, |id| !removed_ids.contains(id))
    });
    for entry in &mut entries {
        let mut parent_id = entry.get("parentId").cloned().unwrap_or(Value::Null);
        let mut visited = HashSet::new();
        while let Some(parent) = parent_id.as_str() {
            if !visited.insert(parent.to_string()) {
                break;
            }
            let Some(replacement) = removed_parents.get(parent) else {
                break;
            };
            parent_id = replacement.clone();
        }
        if let Some(object) = entry.as_object_mut() {
            object.insert("parentId".into(), parent_id);
        }
    }

    let has_visible_messages = entries.iter().any(|entry| {
        entry.get("type").and_then(Value::as_str) == Some("message")
            && matches!(
                entry.pointer("/message/role").and_then(Value::as_str),
                Some("user" | "assistant")
            )
    });
    if !has_visible_messages {
        entries.retain(|entry| entry.get("type").and_then(Value::as_str) == Some("session"));
    }

    Ok(entries)
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
                let no_folder = summary
                    .cwd
                    .as_deref()
                    .is_some_and(settings::is_no_folder_path);
                sessions.push(json!({
                    "file": file.file_name().to_string_lossy(),
                    "filePath": path.display().to_string(),
                    "mtime": metadata.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or_default(),
                    "id": summary.id,
                    "timestamp": summary.timestamp,
                    "name": summary.name,
                    "firstMessage": summary.first_message,
                    "cwd": summary.cwd,
                    "noFolder": no_folder
                }));
            }
        }
        sessions.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
        if !sessions.is_empty() {
            let raw_project_path = sessions
                .iter()
                .find_map(|session| session["cwd"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| decode_project_dir(&dir_name));
            let no_folder = sessions
                .iter()
                .any(|session| session["noFolder"].as_bool() == Some(true))
                || settings::is_no_folder_path(&raw_project_path);
            let project_path = if no_folder {
                settings::no_folder_launch_path().unwrap_or(raw_project_path)
            } else {
                raw_project_path
            };
            projects.push(json!({
                "path": project_path,
                "dirName": dir_name,
                "displayName": if no_folder { "No folder" } else { "" },
                "noFolder": no_folder,
                "sessions": sessions
            }));
        }
    }

    merge_live_sessions(&mut projects);

    projects.sort_by(|a, b| {
        b["sessions"][0]["mtime"]
            .as_u64()
            .cmp(&a["sessions"][0]["mtime"].as_u64())
    });
    Ok(json!({ "projects": projects }))
}

fn merge_live_sessions(projects: &mut Vec<Value>) {
    for live in live_tau_instances() {
        let session_file = live
            .get("sessionFile")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if session_file.is_empty() {
            continue;
        }

        let file_path = PathBuf::from(session_file);
        let dir_name = file_path
            .parent()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                live.get("cwd")
                    .and_then(|value| value.as_str())
                    .map(encode_project_dir)
                    .unwrap_or_else(|| "live".to_string())
            });
        let raw_project_path = live
            .get("cwd")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| decode_project_dir(&dir_name));
        let no_folder = settings::is_no_folder_path(&raw_project_path);
        let project_path = if no_folder {
            settings::no_folder_launch_path().unwrap_or(raw_project_path)
        } else {
            raw_project_path
        };
        let started_at = live
            .get("startedAt")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let file_exists = file_path.exists();
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();

        let session = json!({
            "file": file_name,
            "filePath": session_file,
            "mtime": session_mtime(&file_path).unwrap_or_else(now_millis),
            "id": live.get("pid").and_then(|value| value.as_u64()).map(|pid| format!("live-{pid}")).unwrap_or_else(|| "live".to_string()),
            "timestamp": started_at,
            "name": "当前会话",
            "firstMessage": null,
            "cwd": project_path,
            "noFolder": no_folder,
            "live": true,
            "fileExists": file_exists,
            "port": live.get("port").cloned().unwrap_or(Value::Null),
            "pid": live.get("pid").cloned().unwrap_or(Value::Null)
        });

        if let Some(project) = projects
            .iter_mut()
            .find(|project| project["dirName"].as_str() == Some(dir_name.as_str()))
        {
            if let Some(sessions) = project["sessions"].as_array_mut() {
                if let Some(existing) = sessions
                    .iter_mut()
                    .find(|item| item["filePath"].as_str() == Some(session_file))
                {
                    if let Some(map) = existing.as_object_mut() {
                        if let Some(live_map) = session.as_object() {
                            for (key, value) in live_map {
                                map.insert(key.clone(), value.clone());
                            }
                        }
                    }
                } else {
                    sessions.push(session);
                    sessions.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
                }
            }
        } else {
            projects.push(json!({
                "path": project_path,
                "dirName": dir_name,
                "displayName": if no_folder { "No folder" } else { "" },
                "noFolder": no_folder,
                "sessions": [session]
            }));
        }
    }
}

pub fn live_tau_instances() -> Vec<Value> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let dir = home.join(".pi").join("tau-instances");
    let Ok(files) = fs::read_dir(dir) else {
        return Vec::new();
    };

    files
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .filter_map(|entry| {
            let path = entry.path();
            let raw = fs::read_to_string(&path).ok()?;
            let value = serde_json::from_str::<Value>(&raw).ok()?;
            let pid = value.get("pid").and_then(|value| value.as_u64())?;
            if process_is_alive(pid) {
                Some(value)
            } else {
                let _ = fs::remove_file(path);
                None
            }
        })
        .collect()
}

fn process_is_alive(pid: u64) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn session_mtime(path: &Path) -> Option<u64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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

fn encode_project_dir(path: &str) -> String {
    format!(
        "--{}--",
        path.trim_start_matches(['/', '\\'])
            .replace(['/', '\\', ':'], "-")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleting_a_message_reconnects_its_child_to_the_previous_parent() {
        let entries = vec![
            json!({ "type": "model_change", "id": "root", "parentId": null }),
            json!({ "type": "message", "id": "user", "parentId": "root", "message": { "role": "user", "content": "hello" } }),
            json!({ "type": "message", "id": "assistant", "parentId": "user", "message": { "role": "assistant", "content": "hi" } }),
        ];

        let result = remove_message_entry(entries, "user", false).expect("message is removable");

        assert_eq!(result.len(), 2);
        assert_eq!(result[1]["id"], "assistant");
        assert_eq!(result[1]["parentId"], "root");
    }

    #[test]
    fn deleting_the_last_visible_message_removes_conversation_metadata() {
        let entries = vec![
            json!({ "type": "session", "id": "session" }),
            json!({ "type": "model_change", "id": "model", "parentId": null }),
            json!({ "type": "thinking_level_change", "id": "thinking", "parentId": "model" }),
            json!({ "type": "message", "id": "user", "parentId": "thinking", "message": { "role": "user", "content": "hello" } }),
        ];

        let result = remove_message_entry(entries, "user", false).expect("message is removable");

        assert_eq!(result, vec![json!({ "type": "session", "id": "session", "parentId": null })]);
    }

    #[test]
    fn deleting_an_assistant_tool_call_removes_its_tool_result() {
        let entries = vec![
            json!({ "type": "session", "id": "session" }),
            json!({ "type": "message", "id": "user", "parentId": null, "message": { "role": "user", "content": "read" } }),
            json!({ "type": "message", "id": "assistant", "parentId": "user", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": "tool-1", "name": "read" }] } }),
            json!({ "type": "message", "id": "result", "parentId": "assistant", "message": { "role": "toolResult", "toolCallId": "tool-1", "content": "ok" } }),
            json!({ "type": "message", "id": "final", "parentId": "result", "message": { "role": "assistant", "content": "done" } }),
        ];

        let result = remove_message_entry(entries, "assistant", false).expect("message is removable");

        assert!(result.iter().all(|entry| entry["id"] != "result"));
        assert_eq!(result.last().and_then(|entry| entry["parentId"].as_str()), Some("user"));
    }

    #[test]
    fn rewinding_a_user_message_removes_its_reply_branch() {
        let entries = vec![
            json!({ "type": "session", "id": "session" }),
            json!({ "type": "message", "id": "first", "parentId": null, "message": { "role": "user", "content": "first" } }),
            json!({ "type": "message", "id": "reply", "parentId": "first", "message": { "role": "assistant", "content": "reply" } }),
            json!({ "type": "message", "id": "last", "parentId": "reply", "message": { "role": "user", "content": "old" } }),
            json!({ "type": "message", "id": "old-reply", "parentId": "last", "message": { "role": "assistant", "content": "old reply" } }),
        ];

        let result = remove_message_entry(entries, "last", true).expect("branch is removable");

        assert_eq!(result.len(), 3);
        assert_eq!(result.last().and_then(|entry| entry["id"].as_str()), Some("reply"));
    }
}
