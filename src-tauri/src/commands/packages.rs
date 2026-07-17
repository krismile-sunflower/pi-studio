use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::sidecar::run_pi_package_command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageInfo {
    pub source: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackagesCatalog {
    pub settings_path: String,
    pub packages: Vec<PiPackageInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageCatalogItem {
    pub name: String,
    pub description: String,
    pub package_type: String,
    pub downloads: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagePiPackageRequest {
    pub source: String,
}

#[tauri::command]
pub async fn list_pi_packages() -> Result<PiPackagesCatalog, String> {
    let path = agent_settings_path()?;
    let packages = read_packages(&path)?;
    Ok(PiPackagesCatalog {
        settings_path: path.display().to_string(),
        packages,
    })
}

#[tauri::command]
pub async fn install_pi_package(
    app: AppHandle,
    request: ManagePiPackageRequest,
) -> Result<PiPackagesCatalog, String> {
    let source = validate_source(&request.source)?;
    run_pi_package_command(&app, &["install".into(), source])?;
    list_pi_packages().await
}

#[tauri::command]
pub async fn remove_pi_package(
    app: AppHandle,
    request: ManagePiPackageRequest,
) -> Result<PiPackagesCatalog, String> {
    let source = validate_source(&request.source)?;
    run_pi_package_command(&app, &["remove".into(), source])?;
    list_pi_packages().await
}

#[tauri::command]
pub async fn search_pi_packages(query: String) -> Result<Vec<PiPackageCatalogItem>, String> {
    let params = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("name", query.trim());
        serializer.append_pair("sort", "downloads");
        serializer.finish()
    };
    let url = format!("https://pi.dev/packages?{params}");
    let body = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|err| format!("无法创建软件包目录请求：{err}"))?
        .get(url)
        .send()
        .await
        .map_err(|err| format!("无法访问 Pi 软件包目录：{err}"))?
        .error_for_status()
        .map_err(|err| format!("Pi 软件包目录请求失败：{err}"))?
        .text()
        .await
        .map_err(|err| format!("无法读取 Pi 软件包目录：{err}"))?;
    Ok(parse_catalog(&body))
}

fn agent_settings_path() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join("settings.json"))
        .ok_or_else(|| "无法确定 Pi 用户设置目录。".to_string())
}

fn read_packages(path: &std::path::Path) -> Result<Vec<PiPackageInfo>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("无法读取 Pi 设置 {}：{err}", path.display()))?;
    let settings: Value = serde_json::from_str(&raw)
        .map_err(|err| format!("无法解析 Pi 设置 {}：{err}", path.display()))?;
    let Some(values) = settings.get("packages").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    Ok(values.iter().filter_map(package_info).collect())
}

fn package_info(value: &Value) -> Option<PiPackageInfo> {
    match value {
        Value::String(source) if !source.trim().is_empty() => Some(PiPackageInfo {
            source: source.clone(),
            enabled: true,
        }),
        Value::Object(object) => object
            .get("source")
            .and_then(Value::as_str)
            .filter(|source| !source.trim().is_empty())
            .map(|source| PiPackageInfo {
                source: source.to_string(),
                enabled: object.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            }),
        _ => None,
    }
}

fn validate_source(value: &str) -> Result<String, String> {
    let source = value.trim();
    if source.is_empty() {
        return Err("请输入 npm:、git: 或本地路径格式的软件包来源。".into());
    }
    if source.contains('\0') || source.len() > 2_048 {
        return Err("软件包来源格式无效。".into());
    }
    Ok(source.to_string())
}

fn parse_catalog(html: &str) -> Vec<PiPackageCatalogItem> {
    html.split("data-package-card=\"true\"")
        .skip(1)
        .filter_map(|chunk| {
            let name = attribute(chunk, "data-package-name=")?;
            Some(PiPackageCatalogItem {
                name,
                description: text_after(chunk, "<p class=\"packages-desc\">").unwrap_or_default(),
                package_type: attribute(chunk, "data-package-types=").unwrap_or_else(|| "package".into()),
                downloads: text_after(chunk, "<div class=\"packages-meta\"><span>")
                    .and_then(|meta| meta.split("</span><span>").nth(1).map(html_text))
                    .unwrap_or_default(),
            })
        })
        .take(50)
        .collect()
}

fn attribute(chunk: &str, prefix: &str) -> Option<String> {
    let start = chunk.find(prefix)? + prefix.len();
    let rest = chunk.get(start..)?;
    let quote = rest.chars().next()?;
    if quote != '\"' && quote != '\'' { return None; }
    Some(html_text(rest.get(1..)?.split(quote).next()?))
}

fn text_after(chunk: &str, prefix: &str) -> Option<String> {
    Some(html_text(chunk.split(prefix).nth(1)?.split("</p>").next()?))
}

fn html_text(value: &str) -> String {
    value.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::package_info;
    use serde_json::json;

    #[test]
    fn reads_string_and_object_package_entries() {
        assert_eq!(package_info(&json!("npm:example")).unwrap().source, "npm:example");
        let disabled = package_info(&json!({ "source": "git:github.com/example/pkg", "enabled": false })).unwrap();
        assert!(!disabled.enabled);
    }
}
