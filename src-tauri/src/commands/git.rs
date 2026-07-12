use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    path: String,
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    root: String,
    branch: Option<String>,
    is_repository: bool,
    changes: Vec<GitChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    path: String,
    diff: String,
}

fn git_output(root: &PathBuf, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(path);
        let probe = git_output(&root, &["rev-parse", "--is-inside-work-tree"])?;
        if !probe.status.success() || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
            return Ok(GitStatus {
                root: root.display().to_string(),
                branch: None,
                is_repository: false,
                changes: Vec::new(),
            });
        }
        let output = git_output(&root, &["status", "--porcelain=v1", "--branch"])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text.lines();
        let branch = lines
            .next()
            .and_then(|line| line.strip_prefix("## "))
            .map(|line| {
                line.split_once("...")
                    .map(|(name, _)| name)
                    .unwrap_or(line)
                    .to_string()
            });
        let changes = lines
            .filter_map(|line| {
                if line.len() < 4 {
                    return None;
                }
                let index_status = line[0..1].to_string();
                let worktree_status = line[1..2].to_string();
                let raw_path = line[3..].to_string();
                let (original_path, path) = raw_path
                    .split_once(" -> ")
                    .map(|(from, to)| (Some(from.to_string()), to.to_string()))
                    .unwrap_or((None, raw_path));
                Some(GitChange {
                    path,
                    original_path,
                    index_status,
                    worktree_status,
                })
            })
            .collect();
        Ok(GitStatus {
            root: root.display().to_string(),
            branch,
            is_repository: true,
            changes,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_git_file_diff(path: String, file_path: String) -> Result<GitFileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let requested = root
            .join(&file_path)
            .canonicalize()
            .unwrap_or_else(|_| root.join(&file_path));
        if !requested.starts_with(&root) {
            return Err("文件不在当前工作区内".to_string());
        }
        let output = git_output(&root, &["diff", "--no-ext-diff", "HEAD", "--", &file_path])?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(GitFileDiff {
            path: file_path,
            diff: String::from_utf8_lossy(&output.stdout).to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
