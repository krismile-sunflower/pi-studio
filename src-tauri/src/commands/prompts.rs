//! Prompt templates as defined by Pi (`docs/prompt-templates.md`).
//!
//! A template is a Markdown file whose filename becomes the `/name` command.
//! Optional frontmatter carries `description` and `argument-hint`; when the
//! description is missing Pi falls back to the first non-empty body line
//! (truncated at 60 characters).
//!
//! Discovery mirrors Pi's package manager rather than the standalone loader in
//! `core/prompt-templates.js` — the runtime calls that loader with
//! `includeDefaults: false` and feeds it paths the package manager resolved:
//!
//! 1. `~/.pi/agent/prompts/*.md` — flat scan, no recursion, dotfiles skipped
//! 2. `<project>/.pi/prompts/*.md` — same, and only once the project is trusted
//! 3. packages declared in a `packages` array — never the rest of
//!    `node_modules`. A package that ships a `pi` manifest contributes exactly
//!    what `pi.prompts` lists; only manifest-less packages fall back to the
//!    conventional `prompts/` directory. Package scans do recurse.
//!
//! A `prompts` array in `settings.json` is a filter over (1) and (2), not an
//! extra source: only `!`, `+` and `-` prefixed patterns have any effect.
//!
//! Only (1) and (2) are writable from the UI; package templates belong to
//! whatever installed them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DESCRIPTION_FALLBACK_LIMIT: usize = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPromptTemplate {
    /// Filename without `.md`; this is what `/name` matches.
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    /// Template body with the frontmatter block stripped.
    pub body: String,
    pub file_path: String,
    /// `user` | `project` | `package`
    pub scope: String,
    /// Where the template came from, for display (package name, settings entry…).
    pub origin: String,
    pub editable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPromptCatalog {
    pub user_dir: String,
    pub project_dir: Option<String>,
    /// Pi skips project prompts entirely until the project is trusted.
    pub project_trusted: bool,
    pub templates: Vec<PiPromptTemplate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPiPromptsRequest {
    pub project_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePiPromptRequest {
    /// `user` or `project`.
    pub scope: String,
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub body: String,
    pub project_path: Option<String>,
    /// Set when renaming an existing template so the old file is removed.
    pub original_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePiPromptRequest {
    pub path: String,
}

#[tauri::command]
pub async fn list_pi_prompts(
    request: ListPiPromptsRequest,
) -> Result<PiPromptCatalog, String> {
    discover_prompts(request.project_path.as_deref())
}

#[tauri::command]
pub async fn save_pi_prompt(request: SavePiPromptRequest) -> Result<PiPromptCatalog, String> {
    let name = validate_name(&request.name)?;
    let dir = writable_dir(&request.scope, request.project_path.as_deref())?;
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed to create prompt directory {}: {err}", dir.display()))?;

    let target = dir.join(format!("{name}.md"));
    if let Some(original) = request.original_path.as_deref().filter(|path| !path.is_empty()) {
        let original = PathBuf::from(original);
        if original != target {
            // A rename must not silently clobber another template.
            if target.exists() {
                return Err(format!("已存在同名模板：/{name}"));
            }
            let _ = fs::remove_file(&original);
        }
    } else if target.exists() {
        return Err(format!("已存在同名模板：/{name}"));
    }

    fs::write(&target, render_template(&request))
        .map_err(|err| format!("Failed to write {}: {err}", target.display()))?;

    discover_prompts(request.project_path.as_deref())
}

#[tauri::command]
pub async fn delete_pi_prompt(request: DeletePiPromptRequest) -> Result<PiPromptCatalog, String> {
    let path = PathBuf::from(&request.path);
    let user_dir = user_prompts_dir()?;
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let is_project = parent.ends_with(Path::new(".pi").join("prompts"));
    if parent != user_dir && !is_project {
        return Err("只能删除全局或项目提示模板。".into());
    }
    fs::remove_file(&path)
        .map_err(|err| format!("Failed to delete {}: {err}", path.display()))?;

    // The project catalog is rebuilt from the deleted file's own project root.
    let project_path = is_project
        .then(|| parent.parent().and_then(Path::parent).map(|root| root.to_string_lossy().to_string()))
        .flatten();
    discover_prompts(project_path.as_deref())
}

fn render_template(request: &SavePiPromptRequest) -> String {
    let mut frontmatter = Vec::new();
    if let Some(description) = trimmed(request.description.as_deref()) {
        frontmatter.push(format!("description: {}", yaml_scalar(&description)));
    }
    if let Some(hint) = trimmed(request.argument_hint.as_deref()) {
        frontmatter.push(format!("argument-hint: {}", yaml_scalar(&hint)));
    }
    let body = request.body.replace("\r\n", "\n");
    let body = body.trim_end();
    if frontmatter.is_empty() {
        return format!("{body}\n");
    }
    format!("---\n{}\n---\n{body}\n", frontmatter.join("\n"))
}

/// Quote when the value could otherwise be misread as YAML structure.
fn yaml_scalar(value: &str) -> String {
    let needs_quotes = value.starts_with(['"', '\'', '[', '{', '&', '*', '#', '!', '|', '>', '%', '@', '`'])
        || value.contains(": ")
        || value.contains('\n')
        || value.ends_with(':');
    if needs_quotes {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim().trim_start_matches('/');
    if name.is_empty() {
        return Err("模板名称不能为空。".into());
    }
    if name.len() > 64 {
        return Err("模板名称不能超过 64 个字符。".into());
    }
    // The name becomes both a filename and a `/command`, so keep it path-safe.
    if name.contains(['/', '\\', ' ', '\t', ':', '*', '?', '"', '<', '>', '|']) || name.contains("..") {
        return Err("模板名称不能包含空格、路径分隔符或特殊字符。".into());
    }
    Ok(name.to_string())
}

fn writable_dir(scope: &str, project_path: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "user" => user_prompts_dir(),
        "project" => project_prompts_dir(project_path)
            .ok_or_else(|| "当前没有打开的项目，无法保存项目级模板。".to_string()),
        other => Err(format!("未知的模板作用域：{other}")),
    }
}

fn agent_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent"))
        .ok_or_else(|| "Could not resolve the user home directory for Pi prompts".to_string())
}

fn user_prompts_dir() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("prompts"))
}

fn project_prompts_dir(project_path: Option<&str>) -> Option<PathBuf> {
    project_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| Path::new(path).join(".pi").join("prompts"))
}

/// A package declared in `settings.json`, resolved to its install root.
struct DeclaredPackage {
    name: String,
    root: PathBuf,
    /// `prompts` patterns from an object-form package entry, when present.
    filter: Option<Vec<String>>,
}

fn discover_prompts(project_path: Option<&str>) -> Result<PiPromptCatalog, String> {
    let agent_dir = agent_dir()?;
    let user_dir = agent_dir.join("prompts");
    let project_base = project_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| Path::new(path).join(".pi"));
    // Pi only reads project resources once the project has been trusted.
    let project_trusted = project_path.is_some_and(|path| is_project_trusted(&agent_dir, path));
    let project_dir = project_base.as_ref().map(|base| base.join("prompts"));

    let global_settings = read_json(&agent_dir.join("settings.json"));
    let project_settings = project_base
        .as_ref()
        .filter(|_| project_trusted)
        .and_then(|base| read_json(&base.join("settings.json")));

    let mut templates = Vec::new();
    let mut seen = HashSet::new();

    if project_trusted {
        if let (Some(dir), Some(base)) = (project_dir.as_ref(), project_base.as_ref()) {
            let overrides = string_array(project_settings.as_ref(), "prompts");
            collect_auto_dir(dir, base, &overrides, "project", "项目", true, &mut templates, &mut seen);
        }
    }
    let overrides = string_array(global_settings.as_ref(), "prompts");
    collect_auto_dir(&user_dir, &agent_dir, &overrides, "user", "全局", true, &mut templates, &mut seen);

    // Project-scoped packages take precedence, matching Pi's resolution order.
    if project_trusted {
        if let Some(base) = project_base.as_ref() {
            for package in declared_packages(project_settings.as_ref(), base) {
                collect_package(&package, &mut templates, &mut seen);
            }
        }
    }
    for package in declared_packages(global_settings.as_ref(), &agent_dir) {
        collect_package(&package, &mut templates, &mut seen);
    }

    templates.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(PiPromptCatalog {
        user_dir: user_dir.to_string_lossy().to_string(),
        project_dir: project_dir.map(|dir| dir.to_string_lossy().to_string()),
        project_trusted,
        templates,
    })
}

fn is_project_trusted(agent_dir: &Path, project_path: &str) -> bool {
    read_json(&agent_dir.join("trust.json"))
        .and_then(|trust| trust.get(project_path).and_then(Value::as_bool))
        .unwrap_or(false)
}

fn string_array(settings: Option<&Value>, key: &str) -> Vec<String> {
    settings
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Resolves each `packages` entry to the directory Pi installs it into.
fn declared_packages(settings: Option<&Value>, base_dir: &Path) -> Vec<DeclaredPackage> {
    let Some(entries) = settings.and_then(|value| value.get("packages")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut packages = Vec::new();
    for entry in entries {
        let (source, filter) = match entry {
            Value::String(source) => (source.clone(), None),
            Value::Object(_) => {
                let Some(source) = entry.get("source").and_then(Value::as_str) else {
                    continue;
                };
                (source.to_string(), entry.get("prompts").and_then(Value::as_array).map(|patterns| {
                    patterns.iter().filter_map(Value::as_str).map(str::to_string).collect()
                }))
            }
            _ => continue,
        };
        let Some((name, root)) = resolve_package_root(&source, base_dir) else {
            continue;
        };
        packages.push(DeclaredPackage { name, root, filter });
    }
    packages
}

fn resolve_package_root(source: &str, base_dir: &Path) -> Option<(String, PathBuf)> {
    if let Some(spec) = source.strip_prefix("npm:") {
        let name = npm_package_name(spec.trim())?;
        return Some((name.clone(), base_dir.join("npm").join("node_modules").join(name)));
    }
    if let Some((host, path)) = git_source_parts(source) {
        return Some((path.clone(), base_dir.join("git").join(host).join(path)));
    }
    // Everything else is a local path, resolved against the scope's base dir.
    let path = Path::new(source);
    let root = if path.is_absolute() { path.to_path_buf() } else { base_dir.join(path) };
    let name = root.file_name()?.to_string_lossy().to_string();
    Some((name, root))
}

/// `npm:@scope/name@1.2.3` → `@scope/name`; `npm:name@1` → `name`.
fn npm_package_name(spec: &str) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let (scope, rest) = match spec.strip_prefix('@') {
        Some(rest) => {
            let (scope, rest) = rest.split_once('/')?;
            (Some(scope), rest)
        }
        None => (None, spec),
    };
    let name = rest.split('@').next().filter(|value| !value.is_empty())?;
    Some(match scope {
        Some(scope) => format!("@{scope}/{name}"),
        None => name.to_string(),
    })
}

/// `github.com/user/repo` (with or without a scheme) → host + repo path, which
/// is how Pi lays out `<base>/git/<host>/<path>`.
fn git_source_parts(source: &str) -> Option<(String, String)> {
    let rest = source
        .strip_prefix("git+https://")
        .or_else(|| source.strip_prefix("https://"))
        .or_else(|| source.strip_prefix("http://"))
        .unwrap_or(source);
    let (host, path) = rest.split_once('/')?;
    // Without a dotted host this is a plain relative path, not a git source.
    if !host.contains('.') || path.is_empty() {
        return None;
    }
    Some((host.to_string(), path.trim_end_matches(".git").to_string()))
}

/// A `pi` manifest is authoritative: Pi only falls back to the conventional
/// `prompts/` directory for packages that ship no manifest at all.
fn collect_package(
    package: &DeclaredPackage,
    templates: &mut Vec<PiPromptTemplate>,
    seen: &mut HashSet<PathBuf>,
) {
    if package.filter.as_ref().is_some_and(|patterns| patterns.is_empty()) {
        return; // An explicit empty array disables every prompt from this package.
    }
    let manifest = read_json(&package.root.join("package.json"));
    let manifest_entries = manifest.as_ref().and_then(|value| value.get("pi"));
    let files = match manifest_entries {
        Some(pi) => {
            let Some(entries) = pi.get("prompts").and_then(Value::as_array) else {
                return; // Manifest present but silent about prompts: nothing to load.
            };
            entries
                .iter()
                .filter_map(Value::as_str)
                .flat_map(|entry| collect_markdown(&package.root.join(entry.trim())))
                .collect::<Vec<_>>()
        }
        None => collect_markdown(&package.root.join("prompts")),
    };
    let patterns = package.filter.clone().unwrap_or_default();
    for file in files {
        if !is_enabled_by_overrides(&file, &patterns, &package.root) {
            continue;
        }
        push_template(&file, "package", &package.name, false, templates, seen);
    }
}

/// Package prompt collection recurses, unlike the flat global/project scan.
fn collect_markdown(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        return match path.extension().and_then(|ext| ext.to_str()) {
            Some("md") => vec![path.to_path_buf()],
            _ => Vec::new(),
        };
    }
    let mut files = Vec::new();
    let Ok(entries) = fs::read_dir(path) else {
        return files;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let child = entry.path();
        if child.is_dir() {
            files.extend(collect_markdown(&child));
        } else if child.extension().and_then(|ext| ext.to_str()) == Some("md") {
            files.push(child);
        }
    }
    files.sort();
    files
}

/// Pi scans the global and project prompt directories flat: `.md` files only,
/// no recursion, skipping dotfiles.
fn collect_auto_dir(
    dir: &Path,
    base_dir: &Path,
    overrides: &[String],
    scope: &str,
    origin: &str,
    editable: bool,
    templates: &mut Vec<PiPromptTemplate>,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("md")
                && !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'))
        })
        .collect();
    files.sort();
    for file in files {
        if !is_enabled_by_overrides(&file, overrides, base_dir) {
            continue;
        }
        push_template(&file, scope, origin, editable, templates, seen);
    }
}

fn push_template(
    path: &Path,
    scope: &str,
    origin: &str,
    editable: bool,
    templates: &mut Vec<PiPromptTemplate>,
    seen: &mut HashSet<PathBuf>,
) {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.insert(canonical) {
        return;
    }
    if let Some(template) = read_template(path, scope, origin, editable) {
        templates.push(template);
    }
}

/// Mirrors Pi's override semantics: only `!` (exclude), `+` (force include)
/// and `-` (force exclude) prefixed entries act as filters; plain entries are
/// ignored. Patterns are matched against the basename and the path relative to
/// the owning base directory.
fn is_enabled_by_overrides(path: &Path, patterns: &[String], base_dir: &Path) -> bool {
    let mut enabled = true;
    let matches = |prefix: char| {
        patterns
            .iter()
            .filter_map(|pattern| pattern.strip_prefix(prefix))
            .any(|pattern| matches_pattern(path, pattern, base_dir))
    };
    if matches('!') {
        enabled = false;
    }
    if matches('+') {
        enabled = true;
    }
    if matches('-') {
        enabled = false;
    }
    enabled
}

fn matches_pattern(path: &Path, pattern: &str, base_dir: &Path) -> bool {
    let full = path.to_string_lossy().replace('\\', "/");
    let name = path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    let relative = path
        .strip_prefix(base_dir)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| full.clone());
    let pattern = pattern.replace('\\', "/");
    [relative.as_str(), name.as_str(), full.as_str()]
        .iter()
        .any(|candidate| glob_matches(candidate, &pattern))
}

/// Minimal glob: `*` matches within a segment, `**` across segments, `?` one char.
fn glob_matches(value: &str, pattern: &str) -> bool {
    glob_at(value.as_bytes(), pattern.as_bytes())
}

fn glob_at(value: &[u8], pattern: &[u8]) -> bool {
    if pattern.is_empty() {
        return value.is_empty();
    }
    if pattern[0] == b'*' {
        let double = pattern.len() > 1 && pattern[1] == b'*';
        let rest = &pattern[if double { 2 } else { 1 }..];
        // `**/` also matches zero directories.
        let rest = if double && rest.first() == Some(&b'/') && glob_at(value, &rest[1..]) {
            return true;
        } else {
            rest
        };
        for index in 0..=value.len() {
            if !double && value[..index].contains(&b'/') {
                break;
            }
            if glob_at(&value[index..], rest) {
                return true;
            }
        }
        return false;
    }
    if value.is_empty() {
        return false;
    }
    if pattern[0] == b'?' || pattern[0] == value[0] {
        return glob_at(&value[1..], &pattern[1..]);
    }
    false
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_template(
    path: &Path,
    scope: &str,
    origin: &str,
    editable: bool,
) -> Option<PiPromptTemplate> {
    let raw = fs::read_to_string(path).ok()?;
    let (frontmatter, body) = split_frontmatter(&raw);
    let name = path.file_stem()?.to_string_lossy().to_string();
    let description = frontmatter_value(&frontmatter, "description")
        .unwrap_or_else(|| fallback_description(&body));
    Some(PiPromptTemplate {
        name,
        description,
        argument_hint: frontmatter_value(&frontmatter, "argument-hint"),
        body,
        file_path: path.to_string_lossy().to_string(),
        scope: scope.to_string(),
        origin: origin.to_string(),
        editable,
    })
}

/// Mirrors Pi's frontmatter split: a leading `---` closed by a line-initial `---`.
fn split_frontmatter(content: &str) -> (String, String) {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---") {
        return (String::new(), normalized);
    }
    match normalized[3..].find("\n---") {
        Some(offset) => {
            let end = offset + 3;
            (normalized[4..end].to_string(), normalized[end + 4..].trim().to_string())
        }
        None => (String::new(), normalized),
    }
}

/// Reads a top-level scalar out of the frontmatter block.
fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .map(|inner| inner.replace("\\\"", "\"").replace("\\\\", "\\"))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|rest| rest.strip_suffix('\''))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| value.to_string());
        return trimmed(Some(&value));
    }
    None
}

/// Pi falls back to the first non-empty body line, truncated at 60 characters.
fn fallback_description(body: &str) -> String {
    let Some(line) = body.lines().find(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    if line.chars().count() > DESCRIPTION_FALLBACK_LIMIT {
        let head: String = line.chars().take(DESCRIPTION_FALLBACK_LIMIT).collect();
        format!("{head}...")
    } else {
        line.to_string()
    }
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_frontmatter_like_pi() {
        let (frontmatter, body) = split_frontmatter("---\ndescription: Review\n---\nDo the thing\n");
        assert_eq!(frontmatter, "description: Review");
        assert_eq!(body, "Do the thing");
    }

    #[test]
    fn treats_an_unterminated_block_as_body() {
        let (frontmatter, body) = split_frontmatter("---\ndescription: Review\n");
        assert!(frontmatter.is_empty());
        assert_eq!(body, "---\ndescription: Review\n");
    }

    #[test]
    fn reads_quoted_and_bare_scalars() {
        let frontmatter = "description: Review staged changes\nargument-hint: \"<PR-URL>\"";
        assert_eq!(
            frontmatter_value(frontmatter, "description").as_deref(),
            Some("Review staged changes")
        );
        assert_eq!(frontmatter_value(frontmatter, "argument-hint").as_deref(), Some("<PR-URL>"));
        assert_eq!(frontmatter_value(frontmatter, "missing"), None);
    }

    #[test]
    fn falls_back_to_the_first_body_line() {
        assert_eq!(fallback_description("\n\nReview the diff\nmore"), "Review the diff");
        assert_eq!(fallback_description(&"x".repeat(70)).chars().count(), 63);
    }

    #[test]
    fn round_trips_a_rendered_template() {
        let rendered = render_template(&SavePiPromptRequest {
            scope: "user".into(),
            name: "review".into(),
            description: Some("Review staged changes".into()),
            argument_hint: Some("<PR-URL>".into()),
            body: "Review `git diff --cached`.\n".into(),
            project_path: None,
            original_path: None,
        });
        let (frontmatter, body) = split_frontmatter(&rendered);
        assert_eq!(
            frontmatter_value(&frontmatter, "description").as_deref(),
            Some("Review staged changes")
        );
        assert_eq!(frontmatter_value(&frontmatter, "argument-hint").as_deref(), Some("<PR-URL>"));
        assert_eq!(body, "Review `git diff --cached`.");
    }

    #[test]
    fn quotes_scalars_that_would_break_yaml() {
        assert_eq!(yaml_scalar("plain value"), "plain value");
        assert_eq!(yaml_scalar("key: value"), "\"key: value\"");
        assert_eq!(yaml_scalar("\"quoted\""), "\"\\\"quoted\\\"\"");
    }

    #[test]
    fn writes_and_reads_back_a_directory_of_templates() {
        let dir = std::env::temp_dir().join(format!("pi-prompts-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        fs::write(
            dir.join("review.md"),
            render_template(&SavePiPromptRequest {
                scope: "user".into(),
                name: "review".into(),
                description: Some("Review staged changes".into()),
                argument_hint: Some("<PR-URL>".into()),
                body: "Review `git diff --cached`.".into(),
                project_path: None,
                original_path: None,
            }),
        )
        .unwrap();
        // No frontmatter: the description falls back to the first body line.
        fs::write(dir.join("ship.md"), "Ship it end to end.\n").unwrap();
        // Non-Markdown files are ignored, and scanning does not recurse.
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested").join("deep.md"), "ignored").unwrap();

        let mut templates = Vec::new();
        let mut seen = HashSet::new();
        collect_auto_dir(&dir, &dir, &[], "user", "全局", true, &mut templates, &mut seen);
        templates.sort_by(|left, right| left.name.cmp(&right.name));

        assert_eq!(templates.len(), 2);
        assert_eq!(templates[0].name, "review");
        assert_eq!(templates[0].description, "Review staged changes");
        assert_eq!(templates[0].argument_hint.as_deref(), Some("<PR-URL>"));
        assert_eq!(templates[0].body, "Review `git diff --cached`.");
        assert!(templates[0].editable);
        assert_eq!(templates[1].name, "ship");
        assert_eq!(templates[1].description, "Ship it end to end.");
        assert_eq!(templates[1].argument_hint, None);

        // A second pass over the same file must not duplicate it.
        collect_auto_dir(&dir, &dir, &[], "user", "全局", true, &mut templates, &mut seen);
        assert_eq!(templates.len(), 2);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolves_declared_package_install_roots() {
        let base = Path::new("/home/me/.pi/agent");
        assert_eq!(
            resolve_package_root("npm:pi-subagents", base),
            Some(("pi-subagents".into(), base.join("npm/node_modules/pi-subagents")))
        );
        assert_eq!(
            resolve_package_root("npm:@scope/pkg@1.2.3", base),
            Some(("@scope/pkg".into(), base.join("npm/node_modules/@scope/pkg")))
        );
        assert_eq!(
            resolve_package_root("https://github.com/user/repo.git", base),
            Some(("user/repo".into(), base.join("git/github.com/user/repo")))
        );
    }

    #[test]
    fn a_pi_manifest_without_prompts_contributes_nothing() {
        let dir = std::env::temp_dir().join(format!("pi-pkg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("prompts")).unwrap();
        fs::write(dir.join("prompts").join("stray.md"), "Should not load.\n").unwrap();
        // Manifest present but silent about prompts: Pi ignores the directory.
        fs::write(dir.join("package.json"), r#"{"pi":{"extensions":["./index.ts"]}}"#).unwrap();

        let mut templates = Vec::new();
        let mut seen = HashSet::new();
        let package = DeclaredPackage { name: "demo".into(), root: dir.clone(), filter: None };
        collect_package(&package, &mut templates, &mut seen);
        assert!(templates.is_empty());

        // Drop the manifest and the conventional directory takes over, recursively.
        fs::remove_file(dir.join("package.json")).unwrap();
        fs::create_dir_all(dir.join("prompts").join("nested")).unwrap();
        fs::write(dir.join("prompts").join("nested").join("deep.md"), "Deep.\n").unwrap();
        collect_package(&package, &mut templates, &mut seen);
        let mut names: Vec<_> = templates.iter().map(|item| item.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["deep", "stray"]);
        assert!(templates.iter().all(|item| !item.editable && item.scope == "package"));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn applies_only_prefixed_override_patterns() {
        let base = Path::new("/base");
        let path = Path::new("/base/prompts/review.md");
        // Plain entries are not overrides, so nothing is filtered.
        assert!(is_enabled_by_overrides(path, &["review.md".into()], base));
        assert!(!is_enabled_by_overrides(path, &["!review.md".into()], base));
        assert!(!is_enabled_by_overrides(path, &["!prompts/*.md".into()], base));
        // A force-include wins over an exclude; a force-exclude wins over both.
        assert!(is_enabled_by_overrides(path, &["!*.md".into(), "+review.md".into()], base));
        assert!(!is_enabled_by_overrides(path, &["+review.md".into(), "-review.md".into()], base));
        assert!(is_enabled_by_overrides(path, &["!other.md".into()], base));
    }

    #[test]
    fn glob_stops_at_segment_boundaries_unless_doubled() {
        assert!(glob_matches("review.md", "*.md"));
        assert!(!glob_matches("nested/review.md", "*.md"));
        assert!(glob_matches("nested/review.md", "**/*.md"));
        assert!(glob_matches("review.md", "**/*.md"));
        assert!(glob_matches("review.md", "rev?ew.md"));
        assert!(!glob_matches("review.md", "review"));
    }

    #[test]
    fn rejects_unsafe_template_names() {
        assert_eq!(validate_name("  /review ").as_deref(), Ok("review"));
        assert!(validate_name("").is_err());
        assert!(validate_name("../escape").is_err());
        assert!(validate_name("two words").is_err());
    }
}


