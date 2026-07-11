use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri_plugin_opener::OpenerExt;

const SUPPORTED_APIS: &[&str] = &[
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsConfigResponse {
    pub path: String,
    pub exists: bool,
    pub config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsConfigRequest {
    pub config: Value,
}

#[tauri::command]
pub async fn get_models_config() -> Result<ModelsConfigResponse, String> {
    let path = models_json_path()?;
    if !path.exists() {
        return Ok(ModelsConfigResponse {
            path: path.display().to_string(),
            exists: false,
            config: json!({ "providers": {} }),
        });
    }

    let raw = fs::read_to_string(&path).map_err(|err| {
        format!("Failed to read models.json at {}: {err}", path.display())
    })?;
    let config = serde_json::from_str::<Value>(&raw).map_err(|err| {
        format!("Failed to parse models.json at {}: {err}", path.display())
    })?;

    Ok(ModelsConfigResponse {
        path: path.display().to_string(),
        exists: true,
        config,
    })
}

#[tauri::command]
pub async fn save_models_config(request: SaveModelsConfigRequest) -> Result<ModelsConfigResponse, String> {
    let path = models_json_path()?;
    let config = normalize_and_validate_config(request.config)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!("Failed to create agent config directory {}: {err}", parent.display())
        })?;
    }

    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("Failed to serialize models.json: {err}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, format!("{pretty}\n")).map_err(|err| {
        format!("Failed to write temporary models.json {}: {err}", temp_path.display())
    })?;
    fs::rename(&temp_path, &path).map_err(|err| {
        // Best-effort cleanup of the temp file if rename fails.
        let _ = fs::remove_file(&temp_path);
        format!("Failed to replace models.json at {}: {err}", path.display())
    })?;

    Ok(ModelsConfigResponse {
        path: path.display().to_string(),
        exists: true,
        config,
    })
}

#[tauri::command]
pub async fn open_models_config(app: tauri::AppHandle) -> Result<String, String> {
    let path = models_json_path()?;
    if !path.exists() {
        // Create an empty scaffold so the editor has something to open.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(&path, "{\n  \"providers\": {}\n}\n").map_err(|err| err.to_string())?;
    }
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|err| format!("Failed to open models.json: {err}"))?;
    Ok(path.display().to_string())
}

fn models_json_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("models.json"))
}

pub fn agent_dir() -> Result<PathBuf, String> {
    env::var("PI_CODING_AGENT_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .ok_or_else(|| "Could not resolve Pi agent directory (~/.pi/agent)".to_string())
}

fn normalize_and_validate_config(mut config: Value) -> Result<Value, String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "models.json root must be an object".to_string())?;

    if !object.contains_key("providers") {
        object.insert("providers".into(), json!({}));
    }

    let providers = object
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "models.json.providers must be an object".to_string())?;

    for (provider_name, provider_value) in providers.iter_mut() {
        validate_provider(provider_name, provider_value)?;
    }

    Ok(config)
}

fn validate_provider(provider_name: &str, provider_value: &mut Value) -> Result<(), String> {
    let provider = provider_value
        .as_object_mut()
        .ok_or_else(|| format!("Provider `{provider_name}` must be an object"))?;

    let models = provider
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let provider_api = provider
        .get("api")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(api) = provider_api.as_deref() {
        ensure_supported_api(provider_name, api)?;
    }

    if !models.is_empty() {
        let base_url = provider
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if base_url.is_none() {
            return Err(format!(
                "Provider `{provider_name}`: baseUrl is required when defining custom models"
            ));
        }

        let mut cleaned_models = Vec::with_capacity(models.len());
        for (index, model_value) in models.iter().enumerate() {
            let model = model_value
                .as_object()
                .ok_or_else(|| format!("Provider `{provider_name}` model[{index}] must be an object"))?;
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("Provider `{provider_name}` model[{index}] is missing id"))?;

            let model_api = model
                .get("api")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(api) = model_api.as_deref() {
                ensure_supported_api(provider_name, api)?;
            }
            if provider_api.is_none() && model_api.is_none() {
                return Err(format!(
                    "Provider `{provider_name}`, model `{id}`: no api specified. Set at provider or model level."
                ));
            }

            if let Some(context_window) = model.get("contextWindow").and_then(Value::as_i64) {
                if context_window <= 0 {
                    return Err(format!(
                        "Provider `{provider_name}`, model `{id}`: contextWindow must be > 0"
                    ));
                }
            }
            if let Some(max_tokens) = model.get("maxTokens").and_then(Value::as_i64) {
                if max_tokens <= 0 {
                    return Err(format!(
                        "Provider `{provider_name}`, model `{id}`: maxTokens must be > 0"
                    ));
                }
            }

            // Keep original model object so unknown fields are preserved.
            cleaned_models.push(model_value.clone());
        }
        provider.insert("models".into(), Value::Array(cleaned_models));
    }

    // Drop empty optional string fields to keep the file tidy.
    trim_optional_string(provider, "baseUrl");
    trim_optional_string(provider, "api");
    trim_optional_string(provider, "apiKey");

    Ok(())
}

fn trim_optional_string(map: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(value)) = map.get(key) {
        if value.trim().is_empty() {
            map.remove(key);
        }
    }
}

fn ensure_supported_api(provider_name: &str, api: &str) -> Result<(), String> {
    if SUPPORTED_APIS.contains(&api) {
        Ok(())
    } else {
        Err(format!(
            "Provider `{provider_name}`: unsupported api `{api}`. Supported: {}",
            SUPPORTED_APIS.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_minimal_custom_provider() {
        let config = json!({
            "providers": {
                "ollama": {
                    "baseUrl": "http://localhost:11434/v1",
                    "api": "openai-completions",
                    "apiKey": "ollama",
                    "models": [{ "id": "llama3.1:8b" }]
                }
            }
        });
        let result = normalize_and_validate_config(config).expect("valid");
        assert!(result["providers"]["ollama"]["models"][0]["id"] == "llama3.1:8b");
    }

    #[test]
    fn rejects_missing_base_url() {
        let config = json!({
            "providers": {
                "custom": {
                    "api": "openai-completions",
                    "models": [{ "id": "m1" }]
                }
            }
        });
        let err = normalize_and_validate_config(config).unwrap_err();
        assert!(err.contains("baseUrl"));
    }
}
