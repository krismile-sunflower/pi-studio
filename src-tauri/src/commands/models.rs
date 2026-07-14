use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri_plugin_opener::OpenerExt;
use url::Url;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelDefaultsResponse {
    pub path: String,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPiModelDefaultsRequest {
    pub provider: String,
    pub model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsConfigRequest {
    pub config: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProviderModelsRequest {
    pub provider: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProviderModelsResponse {
    pub models: Vec<FetchedModel>,
    pub metadata_matched: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestProviderModelRequest {
    pub provider: Value,
    pub model_id: String,
    pub reasoning_profile: Option<String>,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    pub thinking_level_map: Option<Value>,
}

fn default_thinking_level() -> String {
    "off".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestProviderModelResponse {
    pub output: String,
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

    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read models.json at {}: {err}", path.display()))?;
    let config = serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("Failed to parse models.json at {}: {err}", path.display()))?;

    Ok(ModelsConfigResponse {
        path: path.display().to_string(),
        exists: true,
        config,
    })
}

#[tauri::command]
pub async fn get_pi_model_defaults() -> Result<PiModelDefaultsResponse, String> {
    read_pi_model_defaults()
}

#[tauri::command]
pub async fn set_pi_model_defaults(
    request: SetPiModelDefaultsRequest,
) -> Result<PiModelDefaultsResponse, String> {
    let provider = request.provider.trim();
    let model_id = request.model_id.trim();
    if provider.is_empty() || model_id.is_empty() {
        return Err("Provider and model are required".to_string());
    }

    let path = settings_json_path()?;
    let mut settings = if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read settings.json at {}: {err}", path.display()))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("Failed to parse settings.json at {}: {err}", path.display()))?
    } else {
        json!({})
    };
    let object = settings
        .as_object_mut()
        .ok_or_else(|| "settings.json root must be an object".to_string())?;
    object.insert(
        "defaultProvider".into(),
        Value::String(provider.to_string()),
    );
    object.insert("defaultModel".into(), Value::String(model_id.to_string()));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, format!("{pretty}\n")).map_err(|err| err.to_string())?;
    fs::rename(&temp_path, &path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "Failed to replace settings.json at {}: {err}",
            path.display()
        )
    })?;

    read_pi_model_defaults()
}

#[tauri::command]
pub async fn save_models_config(
    request: SaveModelsConfigRequest,
) -> Result<ModelsConfigResponse, String> {
    let path = models_json_path()?;
    let config = normalize_and_validate_config(request.config)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create agent config directory {}: {err}",
                parent.display()
            )
        })?;
    }

    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("Failed to serialize models.json: {err}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, format!("{pretty}\n")).map_err(|err| {
        format!(
            "Failed to write temporary models.json {}: {err}",
            temp_path.display()
        )
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
pub async fn fetch_provider_models(
    request: FetchProviderModelsRequest,
) -> Result<FetchProviderModelsResponse, String> {
    let provider = request
        .provider
        .as_object()
        .ok_or_else(|| "Provider configuration must be an object".to_string())?;
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请先填写 Base URL，再拉取模型。".to_string())?;
    let api = provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    ensure_supported_api("current provider", api)?;
    if api == "anthropic-messages" {
        return Err("Anthropic 未提供可用于此处自动发现模型的列表接口，请手动添加模型。".into());
    }

    let mut url = Url::parse(base_url).map_err(|err| format!("Base URL 无效：{err}"))?;
    if !url.path().trim_end_matches('/').ends_with("/models") {
        let path = format!("{}/models", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }

    let api_key = resolve_api_key(provider.get("apiKey").and_then(Value::as_str))?;
    if api == "google-generative-ai" {
        if let Some(key) = api_key.as_deref() {
            url.query_pairs_mut().append_pair("key", key);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|err| format!("无法创建请求客户端：{err}"))?;
    let mut request = client.get(url);
    if api != "google-generative-ai" {
        if let Some(key) = api_key {
            request = request.bearer_auth(key);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("拉取模型失败：{err}"))?
        .error_for_status()
        .map_err(|err| format!("模型服务返回错误：{err}"))?;
    let payload = response
        .json::<Value>()
        .await
        .map_err(|err| format!("无法解析模型列表：{err}"))?;
    let mut models = parse_fetched_models(&payload);
    if models.is_empty() {
        return Err("服务未返回可识别的模型列表。请确认 Base URL、API 类型和密钥。".into());
    }
    // Provider APIs usually return only ID/name. Enrich known public models from
    // models.dev without sending the provider URL, model list, or API key there.
    let public_catalog = fetch_public_model_catalog(&client).await;
    let mut metadata_matched = 0;
    for model in &mut models {
        if let Some(metadata) = public_catalog
            .iter()
            .find(|item| item.id.eq_ignore_ascii_case(&model.id))
        {
            model.context_window = metadata.context_window;
            model.max_tokens = metadata.max_tokens;
            model.input = metadata.input.clone();
            model.reasoning = metadata.reasoning;
            if model.name == model.id && metadata.name != metadata.id {
                model.name = metadata.name.clone();
            }
            metadata_matched += 1;
        }
    }
    Ok(FetchProviderModelsResponse {
        models,
        metadata_matched,
    })
}

#[tauri::command]
pub async fn test_provider_model(
    request: TestProviderModelRequest,
) -> Result<TestProviderModelResponse, String> {
    let provider = request
        .provider
        .as_object()
        .ok_or_else(|| "Provider configuration must be an object".to_string())?;
    let base_url = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "请先填写 Base URL。".to_string())?;
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err("请先填写模型 ID。".into());
    }
    let api = provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    ensure_supported_api("current provider", api)?;
    let api_key = resolve_api_key(provider.get("apiKey").and_then(Value::as_str))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|err| format!("无法创建请求客户端：{err}"))?;
    let prompt = "请只回复：连接成功";
    let mut url = Url::parse(base_url).map_err(|err| format!("Base URL 无效：{err}"))?;
    let reasoning = resolve_reasoning_value(
        provider,
        request.reasoning_profile.as_deref(),
        request.thinking_level_map.as_ref(),
        &request.thinking_level,
    )?;
    let (http_request, extract): (reqwest::RequestBuilder, fn(&Value) -> Option<String>) = match api
    {
        "openai-completions" => {
            append_path(&mut url, "chat/completions");
            let payload = build_openai_payload(api, model_id, prompt, reasoning.as_deref());
            let mut call = client.post(url).json(&payload);
            if let Some(key) = api_key.as_deref() {
                call = call.bearer_auth(key);
            }
            (call, extract_openai_completion)
        }
        "openai-responses" => {
            append_path(&mut url, "responses");
            let payload = build_openai_payload(api, model_id, prompt, reasoning.as_deref());
            let mut call = client.post(url).json(&payload);
            if let Some(key) = api_key.as_deref() {
                call = call.bearer_auth(key);
            }
            (call, extract_openai_response)
        }
        "anthropic-messages" => {
            append_path(&mut url, "messages");
            let mut call = client.post(url).header("anthropic-version", "2023-06-01")
                .json(&json!({ "model": model_id, "max_tokens": 32, "messages": [{ "role": "user", "content": prompt }] }));
            if let Some(key) = api_key.as_deref() {
                call = call.header("x-api-key", key);
            }
            (call, extract_anthropic_response)
        }
        "google-generative-ai" => {
            let google_model_id = model_id.strip_prefix("models/").unwrap_or(model_id);
            append_path(
                &mut url,
                &format!("models/{google_model_id}:generateContent"),
            );
            if let Some(key) = api_key.as_deref() {
                url.query_pairs_mut().append_pair("key", key);
            }
            (
                client
                    .post(url)
                    .json(&json!({ "contents": [{ "parts": [{ "text": prompt }] }] })),
                extract_google_response,
            )
        }
        _ => return Err("不支持的 API 类型。".into()),
    };
    let response = http_request
        .send()
        .await
        .map_err(|err| format!("模型测试请求失败：{err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("无法读取模型测试响应：{err}"))?;
    if !status.is_success() {
        return Err(format!(
            "模型测试失败（{status}）：{}",
            sanitize_error_body(&body)
        ));
    }
    let payload = serde_json::from_str::<Value>(&body)
        .map_err(|err| format!("无法解析模型测试响应：{err}"))?;
    let output = extract(&payload)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "模型已响应，但未返回可显示的文本。".to_string())?;
    Ok(TestProviderModelResponse { output })
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

fn settings_json_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("settings.json"))
}

fn read_pi_model_defaults() -> Result<PiModelDefaultsResponse, String> {
    let path = settings_json_path()?;
    let settings = if path.exists() {
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read settings.json at {}: {err}", path.display()))?;
        serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("Failed to parse settings.json at {}: {err}", path.display()))?
    } else {
        json!({})
    };
    Ok(PiModelDefaultsResponse {
        path: path.display().to_string(),
        default_provider: settings
            .get("defaultProvider")
            .and_then(Value::as_str)
            .map(str::to_string),
        default_model: settings
            .get("defaultModel")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
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

    migrate_reasoning_profiles(provider);
    let profiles = provider.get("reasoningProfiles").cloned();
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
            let model = model_value.as_object().ok_or_else(|| {
                format!("Provider `{provider_name}` model[{index}] must be an object")
            })?;
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    format!("Provider `{provider_name}` model[{index}] is missing id")
                })?;

            let model_api = model.get("api").and_then(Value::as_str).map(str::to_string);
            if let Some(api) = model_api.as_deref() {
                ensure_supported_api(provider_name, api)?;
            }
            if provider_api.is_none() && model_api.is_none() {
                return Err(format!(
                    "Provider `{provider_name}`, model `{id}`: no api specified. Set at provider or model level."
                ));
            }

            if let Some(context_window) = model.get("contextWindow").and_then(Value::as_i64) {
                if context_window < 0 {
                    return Err(format!(
                        "Provider `{provider_name}`, model `{id}`: contextWindow must not be negative"
                    ));
                }
            }
            if let Some(max_tokens) = model.get("maxTokens").and_then(Value::as_i64) {
                if max_tokens < 0 {
                    return Err(format!(
                        "Provider `{provider_name}`, model `{id}`: maxTokens must not be negative"
                    ));
                }
            }
            if let Some(thinking_map) = model.get("thinkingLevelMap") {
                validate_thinking_level_map(provider_name, id, thinking_map)?;
            }

            // Materialize the selected profile to Pi's model map. Pi uses null
            // for unsupported; omission of `off` means a normal request with no reasoning field.
            let mut cleaned = model_value.clone();
            // Public model catalogs use 0 when no text-output limit is known
            // (notably for image models). Pi expects this optional field to be
            // absent rather than zero.
            if cleaned.get("maxTokens").and_then(Value::as_i64) == Some(0) {
                cleaned.as_object_mut().expect("model is an object").remove("maxTokens");
            }
            if cleaned.get("contextWindow").and_then(Value::as_i64) == Some(0) {
                cleaned.as_object_mut().expect("model is an object").remove("contextWindow");
            }
            if let Some(input) = cleaned.get_mut("input").and_then(Value::as_array_mut) {
                input.retain(|item| matches!(item.as_str(), Some("text" | "image")));
                if input.is_empty() {
                    input.push(Value::String("text".into()));
                }
            }
            if let (Some(profile_id), Some(all_profiles)) = (
                model.get("reasoningProfile").and_then(Value::as_str),
                profiles.as_ref(),
            ) {
                if let Some(level_map) = all_profiles
                    .pointer(&format!("/{}/levelMap", escape_pointer(profile_id)))
                    .and_then(Value::as_object)
                {
                    let pi_map: Map<String, Value> = level_map
                        .iter()
                        .filter_map(|(level, mapped)| match mapped.as_str() {
                            // Pi keeps `off` selectable only when the map has a
                            // string. The bundled reasoning-payload extension
                            // removes this sentinel before the HTTP request.
                            Some("omit") => Some((level.clone(), Value::String("omit".into()))),
                            Some("unsupported") => Some((level.clone(), Value::Null)),
                            Some(value) => Some((level.clone(), Value::String(value.into()))),
                            None => None,
                        })
                        .collect();
                    cleaned["thinkingLevelMap"] = Value::Object(pi_map);
                    cleaned["reasoning"] = Value::Bool(true);
                }
            }
            cleaned_models.push(cleaned);
        }
        provider.insert("models".into(), Value::Array(cleaned_models));
    }

    // Drop empty optional string fields to keep the file tidy.
    trim_optional_string(provider, "baseUrl");
    trim_optional_string(provider, "api");
    trim_optional_string(provider, "apiKey");

    Ok(())
}

fn migrate_reasoning_profiles(provider: &mut Map<String, Value>) {
    if let Some(profiles) = provider
        .get_mut("reasoningProfiles")
        .and_then(Value::as_object_mut)
    {
        for profile in profiles.values_mut() {
            if let Some(map) = profile.get_mut("levelMap").and_then(Value::as_object_mut) {
                if matches!(map.get("off").and_then(Value::as_str), Some("unsupported")) {
                    map.insert("off".into(), json!("omit"));
                }
                if matches!(map.get("xhigh").and_then(Value::as_str), Some("high")) {
                    map.insert("xhigh".into(), json!("xhigh"));
                }
            }
        }
    }
    if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
        for model in models {
            if let Some(map) = model
                .get_mut("thinkingLevelMap")
                .and_then(Value::as_object_mut)
            {
                if map
                    .get("off")
                    .is_some_and(|value| value.is_null() || value.as_str() == Some("unsupported"))
                {
                    map.insert("off".into(), json!("omit"));
                }
                if matches!(map.get("xhigh").and_then(Value::as_str), Some("high")) {
                    map.insert("xhigh".into(), json!("xhigh"));
                }
            }
        }
    }
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn resolve_reasoning_value(
    provider: &Map<String, Value>,
    profile_id: Option<&str>,
    thinking_level_map: Option<&Value>,
    level: &str,
) -> Result<Option<String>, String> {
    if level == "off" {
        return Ok(None);
    }
    if let Some(value) = thinking_level_map
        .and_then(Value::as_object)
        .and_then(|map| map.get(level))
    {
        return match value.as_str() {
            Some("omit") => Ok(None),
            Some("unsupported") | None => Err("此模型不支持该强度".into()),
            Some(value) => Ok(Some(value.into())),
        };
    }
    let Some(profile_id) = profile_id else {
        return Ok(None);
    };
    let mapped = provider
        .get("reasoningProfiles")
        .and_then(|value| value.get(profile_id))
        .and_then(|value| value.get("levelMap"))
        .and_then(|value| value.get(level))
        .and_then(Value::as_str)
        .unwrap_or("unsupported");
    match mapped {
        "omit" => Ok(None),
        "unsupported" => Err("此模型不支持该强度".into()),
        value => Ok(Some(value.into())),
    }
}

fn build_openai_payload(api: &str, model_id: &str, prompt: &str, reasoning: Option<&str>) -> Value {
    let mut payload = if api == "openai-responses" {
        json!({ "model": model_id, "input": prompt, "stream": false })
    } else {
        json!({ "model": model_id, "messages": [{ "role": "user", "content": prompt }], "stream": false })
    };
    if let Some(value) = reasoning {
        if api == "openai-responses" {
            payload["reasoning"] = json!({ "effort": value });
        } else {
            payload["reasoning_effort"] = json!(value);
        }
    }
    payload
}

fn sanitize_error_body(body: &str) -> String {
    let mut value = body.chars().take(2000).collect::<String>();
    for marker in ["sk-", "Bearer "] {
        if let Some(index) = value.find(marker) {
            value.replace_range(index..value.len().min(index + 80), "[REDACTED]");
        }
    }
    value
}

fn validate_thinking_level_map(
    provider_name: &str,
    model_id: &str,
    value: &Value,
) -> Result<(), String> {
    const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];
    let map = value.as_object().ok_or_else(|| {
        format!("Provider `{provider_name}` model `{model_id}`: thinkingLevelMap must be an object")
    })?;
    for (level, mapped) in map {
        if !LEVELS.contains(&level.as_str()) {
            return Err(format!(
                "Provider `{provider_name}` model `{model_id}`: unsupported thinking level `{level}`"
            ));
        }
        if !mapped.is_string() && !mapped.is_null() {
            return Err(format!(
                "Provider `{provider_name}` model `{model_id}`: thinking level `{level}` must map to a string or null"
            ));
        }
    }
    Ok(())
}

fn trim_optional_string(map: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(value)) = map.get(key) {
        if value.trim().is_empty() {
            map.remove(key);
        }
    }
}

fn resolve_api_key(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if let Some(name) = value.strip_prefix('$').or_else(|| {
        value
            .strip_prefix("${")
            .and_then(|item| item.strip_suffix('}'))
    }) {
        return env::var(name)
            .map(Some)
            .map_err(|_| format!("环境变量 `{name}` 未设置"));
    }
    if value.starts_with('!') {
        return Err("拉取模型不执行 !command 形式的 API Key；请暂时填写密钥或使用 $ENV。".into());
    }
    Ok(Some(value.to_string()))
}

fn append_path(url: &mut Url, suffix: &str) {
    let path = format!(
        "{}/{}",
        url.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    );
    url.set_path(&path);
}

fn extract_openai_completion(payload: &Value) -> Option<String> {
    payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn extract_openai_response(payload: &Value) -> Option<String> {
    payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .pointer("/output/0/content/0/text")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn extract_anthropic_response(payload: &Value) -> Option<String> {
    payload
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn extract_google_response(payload: &Value) -> Option<String> {
    payload
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn parse_fetched_models(payload: &Value) -> Vec<FetchedModel> {
    let entries = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    entries
        .into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)?
                .trim();
            (!id.is_empty()).then(|| FetchedModel {
                id: id.to_string(),
                name: item
                    .get("display_name")
                    .or_else(|| item.get("displayName"))
                    .or_else(|| item.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: None,
                max_tokens: None,
                input: None,
                reasoning: None,
            })
        })
        .collect()
}

async fn fetch_public_model_catalog(client: &reqwest::Client) -> Vec<FetchedModel> {
    let response = match client.get("https://models.dev/api.json").send().await {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(_) => return Vec::new(),
    };
    let payload = match response.json::<Value>().await {
        Ok(payload) => payload,
        Err(_) => return Vec::new(),
    };
    let providers = match payload
        .get("providers")
        .and_then(Value::as_object)
        .or_else(|| payload.as_object())
    {
        Some(providers) => providers,
        None => return Vec::new(),
    };
    providers
        .values()
        .flat_map(|provider| {
            provider
                .get("models")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|models| models.values())
        })
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?.trim();
            (!id.is_empty()).then(|| FetchedModel {
                id: id.to_string(),
                name: model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                context_window: model.pointer("/limit/context").and_then(Value::as_u64),
                max_tokens: model.pointer("/limit/output").and_then(Value::as_u64),
                input: model
                    .pointer("/modalities/input")
                    .and_then(Value::as_array)
                    .map(|items| {
                        let supported: Vec<String> = items
                            .iter()
                            .filter_map(Value::as_str)
                            .filter(|item| matches!(*item, "text" | "image"))
                            .map(str::to_string)
                            .collect();
                        if supported.is_empty() { vec!["text".into()] } else { supported }
                    }),
                reasoning: model.get("reasoning").and_then(Value::as_bool),
            })
        })
        .collect()
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
    fn removes_input_modalities_not_supported_by_pi() {
        let config = json!({
            "providers": {
                "custom": {
                    "baseUrl": "https://example.com/v1",
                    "api": "openai-completions",
                    "models": [{
                        "id": "multimodal",
                        "input": ["text", "image", "video", "pdf"]
                    }]
                }
            }
        });

        let result = normalize_and_validate_config(config).expect("valid after normalization");
        assert_eq!(
            result["providers"]["custom"]["models"][0]["input"],
            json!(["text", "image"])
        );
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

    #[test]
    fn parses_openai_and_google_model_payloads() {
        assert_eq!(
            parse_fetched_models(&json!({ "data": [{ "id": "gpt-test" }] }))[0].id,
            "gpt-test"
        );
        assert_eq!(parse_fetched_models(&json!({ "models": [{ "name": "models/gemini-test", "displayName": "Gemini Test" }] }))[0].name, "Gemini Test");
    }

    #[test]
    fn accepts_reasoning_level_map() {
        let config = json!({ "providers": { "openai": {
            "baseUrl": "https://api.example.com/v1", "api": "openai-completions",
            "models": [{ "id": "gpt-test", "reasoning": true,
                "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "high" }
            }]
        }}});
        let normalized = normalize_and_validate_config(config).expect("valid");
        assert_eq!(
            normalized["providers"]["openai"]["models"][0]["thinkingLevelMap"]["xhigh"],
            "xhigh"
        );
    }

    #[test]
    fn omits_zero_max_tokens_from_catalog_metadata() {
        let config = json!({ "providers": { "images": {
            "baseUrl": "https://api.example.com/v1", "api": "openai-completions",
            "models": [{ "id": "gpt-image", "contextWindow": 0, "maxTokens": 0 }]
        }}});
        let normalized = normalize_and_validate_config(config).expect("valid");
        assert!(normalized["providers"]["images"]["models"][0]
            .get("maxTokens")
            .is_none());
        assert!(normalized["providers"]["images"]["models"][0]
            .get("contextWindow")
            .is_none());
    }

    #[test]
    fn migrates_legacy_off_and_materializes_profile() {
        let config = json!({ "providers": { "openai": {
            "baseUrl": "https://api.example.com/v1", "api": "openai-completions",
            "reasoningProfiles": { "standard": { "levelMap": { "off": "unsupported", "low": "low" } } },
            "models": [{ "id": "any-id", "reasoningProfile": "standard", "thinkingLevelMap": { "off": null } }]
        }}});
        let normalized = normalize_and_validate_config(config).expect("valid");
        assert_eq!(
            normalized["providers"]["openai"]["reasoningProfiles"]["standard"]["levelMap"]["off"],
            "omit"
        );
        assert_eq!(
            normalized["providers"]["openai"]["models"][0]["thinkingLevelMap"]["off"],
            "omit"
        );
        assert_eq!(
            normalized["providers"]["openai"]["models"][0]["thinkingLevelMap"]["low"],
            "low"
        );
    }

    #[test]
    fn builds_shared_reasoning_payload_by_api() {
        let off = build_openai_payload("openai-completions", "m", "p", None);
        assert!(off.get("reasoning_effort").is_none());
        assert!(off.get("reasoning").is_none());
        assert_eq!(
            build_openai_payload("openai-completions", "m", "p", Some("low"))["reasoning_effort"],
            "low"
        );
        assert_eq!(
            build_openai_payload("openai-responses", "m", "p", Some("low"))["reasoning"]["effort"],
            "low"
        );
    }

    #[test]
    fn unsupported_rejects_only_selected_level() {
        let provider = json!({ "reasoningProfiles": { "p": { "levelMap": { "off": "omit", "low": "unsupported", "high": "high" } } } });
        let provider = provider.as_object().unwrap();
        assert_eq!(
            resolve_reasoning_value(provider, Some("p"), None, "off").unwrap(),
            None
        );
        assert!(resolve_reasoning_value(provider, Some("p"), None, "low")
            .unwrap_err()
            .contains("不支持"));
        assert_eq!(
            resolve_reasoning_value(provider, Some("p"), None, "high").unwrap(),
            Some("high".into())
        );
    }

    #[test]
    fn direct_model_map_is_used_when_testing_a_model() {
        let provider = json!({}).as_object().unwrap().clone();
        let map = json!({ "minimal": "low", "high": "high", "xhigh": "xhigh" });
        assert_eq!(
            resolve_reasoning_value(&provider, None, Some(&map), "minimal").unwrap(),
            Some("low".into())
        );
        assert_eq!(
            resolve_reasoning_value(&provider, None, Some(&map), "xhigh").unwrap(),
            Some("xhigh".into())
        );
    }

    #[test]
    fn extracts_non_streaming_test_responses() {
        assert_eq!(
            extract_openai_completion(
                &json!({ "choices": [{ "message": { "content": "连接成功" } }] })
            ),
            Some("连接成功".into())
        );
        assert_eq!(
            extract_openai_response(&json!({ "output_text": "连接成功" })),
            Some("连接成功".into())
        );
    }
}
