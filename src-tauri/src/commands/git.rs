use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    is_repository: bool,
    changes: Vec<GitChange>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    path: String,
    diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    summary: String,
    output: String,
}

fn git_output(root: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .output()
        .map_err(|error| format!("无法运行 Git：{error}"))
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    }
}

fn require_success(action: &str, output: Output) -> Result<Output, String> {
    if output.status.success() {
        Ok(output)
    } else {
        let detail = output_text(&output);
        Err(if detail.is_empty() {
            format!("{action}失败，Git 未返回错误详情。")
        } else {
            format!("{action}失败：{detail}")
        })
    }
}

fn canonical_root(path: String) -> Result<PathBuf, String> {
    PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("无法访问工作区：{error}"))
}

fn is_repository(root: &Path) -> Result<bool, String> {
    let probe = git_output(root, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(probe.status.success() && String::from_utf8_lossy(&probe.stdout).trim() == "true")
}

fn repository_root(path: String) -> Result<PathBuf, String> {
    let root = canonical_root(path)?;
    if !is_repository(&root)? {
        return Err("当前文件夹不是 Git 仓库。".to_string());
    }
    Ok(root)
}

fn optional_git_text(root: &Path, args: &[&str]) -> Option<String> {
    let output = git_output(root, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn branch_from_header(line: &str) -> Option<String> {
    let value = line.strip_prefix("## ")?;
    let branch = value
        .strip_prefix("No commits yet on ")
        .or_else(|| value.strip_prefix("Initial commit on "))
        .unwrap_or(value);
    let branch = branch
        .split_once("...")
        .map(|(name, _)| name)
        .unwrap_or(branch);
    let branch = branch
        .split_once(" [")
        .map(|(name, _)| name)
        .unwrap_or(branch)
        .trim();
    (!branch.is_empty()).then(|| branch.to_string())
}

fn upstream_distance(root: &Path) -> (u32, u32) {
    let Some(counts) = optional_git_text(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ) else {
        return (0, 0);
    };
    let mut parts = counts.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    (ahead, behind)
}

fn operation_result(summary: &str, output: Output) -> GitOperationResult {
    GitOperationResult {
        summary: summary.to_string(),
        output: output_text(&output),
    }
}

fn validated_file_paths(file_paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for file_path in file_paths {
        if file_path.is_empty() {
            continue;
        }
        let path = Path::new(&file_path);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("文件不在当前工作区内：{file_path}"));
        }
        if !result.contains(&file_path) {
            result.push(file_path);
        }
    }
    if result.is_empty() {
        return Err("没有选择需要操作的文件。".to_string());
    }
    Ok(result)
}

fn git_output_with_paths(
    root: &Path,
    leading_args: &[&str],
    file_paths: &[String],
) -> Result<Output, String> {
    let mut args = leading_args
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    args.extend(file_paths.iter().cloned());
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    git_output(root, &refs)
}

fn has_head(root: &Path) -> bool {
    git_output(root, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        let root = canonical_root(path)?;
        if !is_repository(&root)? {
            return Ok(GitStatus {
                root: root.display().to_string(),
                branch: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                is_repository: false,
                changes: Vec::new(),
            });
        }
        let output = require_success(
            "读取 Git 状态",
            git_output(
                &root,
                &[
                    "-c",
                    "core.quotepath=false",
                    "status",
                    "--porcelain=v1",
                    "--branch",
                ],
            )?,
        )?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text.lines();
        let branch = lines.next().and_then(branch_from_header);
        let upstream = optional_git_text(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        );
        let (ahead, behind) = upstream_distance(&root);
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
            upstream,
            ahead,
            behind,
            is_repository: true,
            changes,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_git_file_diff(
    path: String,
    file_path: String,
    diff_mode: Option<String>,
) -> Result<GitFileDiff, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        validated_file_paths(vec![file_path.clone()])?;
        let requested = root
            .join(&file_path)
            .canonicalize()
            .unwrap_or_else(|_| root.join(&file_path));
        if !requested.starts_with(&root) {
            return Err("文件不在当前工作区内".to_string());
        }
        let output = match diff_mode.as_deref() {
            Some("staged") => require_success(
                "读取暂存差异",
                git_output(
                    &root,
                    &["diff", "--cached", "--no-ext-diff", "--", &file_path],
                )?,
            )?,
            Some("unstaged") => require_success(
                "读取工作区差异",
                git_output(&root, &["diff", "--no-ext-diff", "--", &file_path])?,
            )?,
            _ => require_success(
                "读取文件差异",
                git_output(&root, &["diff", "--no-ext-diff", "HEAD", "--", &file_path])?,
            )?,
        };
        Ok(GitFileDiff {
            path: file_path,
            diff: String::from_utf8_lossy(&output.stdout).to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stage_git_files(
    path: String,
    file_paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let file_paths = validated_file_paths(file_paths)?;
        let output = require_success(
            "暂存文件",
            git_output_with_paths(&root, &["add", "--all", "--"], &file_paths)?,
        )?;
        Ok(operation_result("已暂存所选文件", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn stage_all_git(path: String) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let output = require_success("暂存全部改动", git_output(&root, &["add", "--all"])?)?;
        Ok(operation_result("已暂存全部改动", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn unstage_git_files(
    path: String,
    file_paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let file_paths = validated_file_paths(file_paths)?;
        let output = if has_head(&root) {
            require_success(
                "取消暂存文件",
                git_output_with_paths(&root, &["reset", "--quiet", "HEAD", "--"], &file_paths)?,
            )?
        } else {
            require_success(
                "取消暂存文件",
                git_output_with_paths(
                    &root,
                    &["rm", "--cached", "-r", "--ignore-unmatch", "--"],
                    &file_paths,
                )?,
            )?
        };
        Ok(operation_result("已取消暂存所选文件", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn unstage_all_git(path: String) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let output = if has_head(&root) {
            require_success(
                "取消全部暂存",
                git_output(&root, &["reset", "--quiet", "HEAD", "--"])?,
            )?
        } else {
            require_success(
                "取消全部暂存",
                git_output(
                    &root,
                    &["rm", "--cached", "-r", "--ignore-unmatch", "--", "."],
                )?,
            )?
        };
        Ok(operation_result("已取消全部暂存", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn pull_git(path: String) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        if optional_git_text(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .is_none()
        {
            return Err("当前分支未设置上游分支，暂时无法拉取。".to_string());
        }
        let output = require_success("拉取", git_output(&root, &["pull", "--ff-only"])?)?;
        Ok(operation_result("拉取完成", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn commit_git(path: String, message: String) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let message = message.trim();
        if message.is_empty() {
            return Err("请输入提交说明。".to_string());
        }
        if message.chars().count() > 500 {
            return Err("提交说明不能超过 500 个字符。".to_string());
        }
        let output = require_success(
            "提交",
            git_output(&root, &["commit", "--message", message])?,
        )?;
        Ok(operation_result("提交完成", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn push_git(path: String) -> Result<GitOperationResult, String> {
    tokio::task::spawn_blocking(move || {
        let root = repository_root(path)?;
        let branch = optional_git_text(&root, &["branch", "--show-current"])
            .ok_or_else(|| "当前处于分离 HEAD 状态，无法直接推送。".to_string())?;
        let has_upstream = optional_git_text(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .is_some();
        let output = if has_upstream {
            require_success("推送", git_output(&root, &["push"])?)?
        } else {
            require_success(
                "读取 origin",
                git_output(&root, &["remote", "get-url", "origin"])?,
            )?;
            require_success(
                "推送",
                git_output(&root, &["push", "--set-upstream", "origin", &branch])?,
            )?
        };
        Ok(operation_result("推送完成", output))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{branch_from_header, validated_file_paths};

    #[test]
    fn parses_branch_headers_with_tracking_state() {
        assert_eq!(
            branch_from_header("## feature/git...origin/feature/git [ahead 2, behind 1]")
                .as_deref(),
            Some("feature/git")
        );
    }

    #[test]
    fn parses_branch_headers_before_the_first_commit() {
        assert_eq!(
            branch_from_header("## No commits yet on main").as_deref(),
            Some("main")
        );
    }

    #[test]
    fn rejects_git_paths_outside_the_workspace() {
        assert!(validated_file_paths(vec!["../outside.txt".to_string()]).is_err());
        assert!(validated_file_paths(vec!["src/main.rs".to_string()]).is_ok());
    }
}
