use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiExtensionInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub kind: String,
    pub source: String,
    pub source_path: String,
    pub installed: bool,
    pub installed_path: Option<String>,
    pub requires_dependencies: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiExtensionsCatalog {
    pub install_dir: String,
    pub catalog_roots: Vec<String>,
    pub extensions: Vec<PiExtensionInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPiExtensionRequest {
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPiExtensionResult {
    pub extension: PiExtensionInfo,
    pub installed_path: String,
    pub dependency_status: Option<String>,
    pub warning: Option<String>,
}

struct CatalogRoot {
    path: PathBuf,
    source: String,
}

#[tauri::command]
pub async fn list_pi_extensions(app: AppHandle) -> Result<PiExtensionsCatalog, String> {
    discover_extensions(&app)
}

#[tauri::command]
pub async fn install_pi_extension(
    app: AppHandle,
    request: InstallPiExtensionRequest,
) -> Result<InstallPiExtensionResult, String> {
    let catalog = discover_extensions(&app)?;
    let extension = catalog
        .extensions
        .into_iter()
        .find(|extension| extension.id == request.id)
        .ok_or_else(|| format!("Pi extension not found: {}", request.id))?;

    let install_dir = user_extensions_dir()?;
    fs::create_dir_all(&install_dir).map_err(|err| {
        format!(
            "Failed to create Pi extensions directory {}: {err}",
            install_dir.display()
        )
    })?;

    let target = install_target_path(&install_dir, &extension);
    let source = PathBuf::from(&extension.source_path);

    if !target.exists() {
        if !source.exists() {
            return Err(format!(
                "Pi extension source is missing: {}",
                source.display()
            ));
        }

        if source.is_dir() {
            copy_dir_all(&source, &target)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::copy(&source, &target).map_err(|err| {
                format!(
                    "Failed to install {} to {}: {err}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }

    let mut dependency_status = None;
    let mut warning = Some(
        "Installed globally. Start a new Pi session or restart Pi to load this extension."
            .to_string(),
    );

    if target.is_dir() && target.join("package.json").exists() {
        match install_extension_dependencies(&target) {
            Ok(status) => dependency_status = Some(status),
            Err(err) => {
                dependency_status = Some(format!("failed: {err}"));
                warning = Some(format!(
                    "Installed, but dependency installation failed. Run npm install in {} before using it.",
                    target.display()
                ));
            }
        }
    }

    let installed_path = target.display().to_string();
    let mut installed_extension = extension;
    installed_extension.installed = true;
    installed_extension.installed_path = Some(installed_path.clone());

    Ok(InstallPiExtensionResult {
        extension: installed_extension,
        installed_path,
        dependency_status,
        warning,
    })
}

fn discover_extensions(app: &AppHandle) -> Result<PiExtensionsCatalog, String> {
    let install_dir = user_extensions_dir()?;
    let roots = candidate_catalog_roots(app);
    let mut catalog_roots = Vec::new();
    let mut extensions = Vec::new();
    let mut seen = HashSet::new();

    for root in roots {
        if !root.path.is_dir() {
            continue;
        }
        catalog_roots.push(root.path.display().to_string());
        for extension in scan_catalog_root(&root, &install_dir)? {
            if seen.insert(extension.id.clone()) {
                extensions.push(extension);
            }
        }
    }

    for extension in scan_installed_extensions(&install_dir)? {
        if seen.insert(extension.id.clone()) {
            extensions.push(extension);
        }
    }

    extensions.sort_by(|a, b| {
        b.installed
            .cmp(&a.installed)
            .then_with(|| a.category.to_lowercase().cmp(&b.category.to_lowercase()))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(PiExtensionsCatalog {
        install_dir: install_dir.display().to_string(),
        catalog_roots,
        extensions,
    })
}

fn candidate_catalog_roots(app: &AppHandle) -> Vec<CatalogRoot> {
    let mut roots = Vec::new();

    for package_root in system_pi_package_roots() {
        add_extension_root(
            &mut roots,
            package_root.join("examples").join("extensions"),
            "System Pi".into(),
        );
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        add_platform_roots(
            &mut roots,
            resource_dir.join("binaries"),
            "Bundled Pi".into(),
        );
    }

    add_platform_roots(
        &mut roots,
        Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"),
        "Local bundled Pi".into(),
    );

    roots
}

fn add_platform_roots(roots: &mut Vec<CatalogRoot>, binaries_root: PathBuf, source: String) {
    let Ok(platform) = platform_binaries_dir() else {
        return;
    };
    let platform_dir = binaries_root.join(platform);
    add_extension_root(
        roots,
        platform_dir
            .join("pi-package")
            .join("examples")
            .join("extensions"),
        source.clone(),
    );
    add_extension_root(
        roots,
        platform_dir
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("examples")
            .join("extensions"),
        source,
    );
}

fn add_extension_root(roots: &mut Vec<CatalogRoot>, path: PathBuf, source: String) {
    if !path.is_dir() {
        return;
    }

    let key = path
        .canonicalize()
        .unwrap_or_else(|_| path.clone())
        .display()
        .to_string();
    if roots.iter().any(|root| {
        root.path
            .canonicalize()
            .unwrap_or_else(|_| root.path.clone())
            .display()
            .to_string()
            == key
    }) {
        return;
    }

    roots.push(CatalogRoot { path, source });
}

fn system_pi_package_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Ok(path) = std::env::var("PI_DESKTOP_CLI") {
        add_package_root_from_command_path(&mut roots, PathBuf::from(path));
    }

    for command_path in locate_pi_commands() {
        add_package_root_from_command_path(&mut roots, command_path);
    }

    if let Some(global_root) = npm_global_root() {
        roots.push(global_root.join("@earendil-works").join("pi-coding-agent"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| root.is_dir())
        .filter(|root| {
            let key = root
                .canonicalize()
                .unwrap_or_else(|_| root.clone())
                .display()
                .to_string();
            seen.insert(key)
        })
        .collect()
}

fn locate_pi_commands() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let output = if cfg!(windows) {
        hidden_command("where.exe").arg("pi").output()
    } else {
        hidden_command("which").arg("pi").output()
    };

    let Ok(output) = output else {
        return paths;
    };
    if !output.status.success() {
        return paths;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed));
        }
    }

    paths
}

fn add_package_root_from_command_path(roots: &mut Vec<PathBuf>, command_path: PathBuf) {
    let command_path = command_path.canonicalize().unwrap_or(command_path);

    if command_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("cli.js"))
    {
        if let Some(package_root) = command_path.parent().and_then(|dir| dir.parent()) {
            roots.push(package_root.to_path_buf());
        }
    }

    if let Some(bin_dir) = command_path.parent() {
        roots.push(
            bin_dir
                .join("node_modules")
                .join("@earendil-works")
                .join("pi-coding-agent"),
        );

        if let Some(prefix) = bin_dir.parent() {
            roots.push(
                prefix
                    .join("lib")
                    .join("node_modules")
                    .join("@earendil-works")
                    .join("pi-coding-agent"),
            );
        }
    }
}

fn npm_global_root() -> Option<PathBuf> {
    let output = hidden_command(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .args(["root", "-g"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let path = stdout.lines().next()?.trim();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

fn scan_catalog_root(
    root: &CatalogRoot,
    install_dir: &Path,
) -> Result<Vec<PiExtensionInfo>, String> {
    let metadata = read_catalog_metadata(&root.path);
    let mut extensions = Vec::new();

    for entry in fs::read_dir(&root.path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        let (id, name, kind) = if path.is_file() && path.extension().is_some_and(|ext| ext == "ts")
        {
            (
                file_name.clone(),
                file_name.trim_end_matches(".ts").to_string(),
                "file".to_string(),
            )
        } else if path.is_dir() && path.join("index.ts").is_file() {
            (
                file_name.clone(),
                file_name.clone(),
                "directory".to_string(),
            )
        } else {
            continue;
        };

        let target = install_target_path_by_id(install_dir, &id, &kind);
        let (category, description) = metadata
            .get(&id)
            .or_else(|| metadata.get(&name))
            .cloned()
            .unwrap_or_else(|| {
                (
                    "General".into(),
                    if kind == "directory" {
                        "Directory-based Pi extension.".into()
                    } else {
                        "Pi extension example.".into()
                    },
                )
            });

        extensions.push(PiExtensionInfo {
            id,
            name,
            description,
            category,
            kind,
            source: root.source.clone(),
            source_path: path.display().to_string(),
            installed: target.exists(),
            installed_path: target.exists().then(|| target.display().to_string()),
            requires_dependencies: path.join("package.json").is_file(),
        });
    }

    Ok(extensions)
}

fn scan_installed_extensions(install_dir: &Path) -> Result<Vec<PiExtensionInfo>, String> {
    if !install_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut extensions = Vec::new();
    for entry in fs::read_dir(install_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        let (id, name, kind) = if path.is_file() && path.extension().is_some_and(|ext| ext == "ts")
        {
            (
                file_name.clone(),
                file_name.trim_end_matches(".ts").to_string(),
                "file".to_string(),
            )
        } else if path.is_dir() && path.join("index.ts").is_file() {
            (
                file_name.clone(),
                file_name.clone(),
                "directory".to_string(),
            )
        } else {
            continue;
        };

        extensions.push(PiExtensionInfo {
            id,
            name,
            description: "Installed in the global Pi extensions directory.".into(),
            category: "Installed".into(),
            kind,
            source: "Installed".into(),
            source_path: path.display().to_string(),
            installed: true,
            installed_path: Some(path.display().to_string()),
            requires_dependencies: path.join("package.json").is_file(),
        });
    }

    Ok(extensions)
}

fn read_catalog_metadata(root: &Path) -> HashMap<String, (String, String)> {
    let mut metadata = HashMap::new();
    let Ok(readme) = fs::read_to_string(root.join("README.md")) else {
        return metadata;
    };

    let mut category = "General".to_string();
    for line in readme.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("### ") {
            category = rest.trim().to_string();
            continue;
        }

        if !trimmed.starts_with("| `") {
            continue;
        }

        let cells: Vec<_> = trimmed
            .trim_matches('|')
            .split('|')
            .map(|cell| cell.trim())
            .collect();
        if cells.len() < 2 {
            continue;
        }

        let id = cells[0].trim_matches('`').trim_end_matches('/').to_string();
        if id.is_empty() || id == "Extension" {
            continue;
        }

        metadata.insert(id, (category.clone(), clean_markdown(cells[1])));
    }

    metadata
}

fn clean_markdown(value: &str) -> String {
    value.replace('`', "")
}

fn install_target_path(install_dir: &Path, extension: &PiExtensionInfo) -> PathBuf {
    install_target_path_by_id(install_dir, &extension.id, &extension.kind)
}

fn install_target_path_by_id(install_dir: &Path, id: &str, kind: &str) -> PathBuf {
    if kind == "file" {
        install_dir.join(id)
    } else {
        install_dir.join(id.trim_end_matches('/'))
    }
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|err| {
        format!(
            "Failed to create extension directory {}: {err}",
            target.display()
        )
    })?;

    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|err| {
                format!(
                    "Failed to copy {} to {}: {err}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn install_extension_dependencies(extension_dir: &Path) -> Result<String, String> {
    if extension_dir.join("node_modules").exists() {
        return Ok("already installed".into());
    }

    let output = hidden_command(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .arg("install")
        .arg("--omit=dev")
        .current_dir(extension_dir)
        .output()
        .map_err(|err| format!("failed to start npm: {err}"))?;

    if output.status.success() {
        Ok("installed".into())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            Err(format!("npm exited with {}", output.status))
        } else {
            Err(stderr)
        }
    }
}

fn user_extensions_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join("extensions"))
        .ok_or_else(|| "Could not resolve the user home directory for Pi extensions".to_string())
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn platform_binaries_dir() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        _ => Err("Unsupported platform for bundled Pi extension catalog".into()),
    }
}
