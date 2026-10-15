//! 拉取 AI 服务商可用模型列表
//!
//! 调用 `GET {endpoint}/models`，解析完整模型元数据（id / 名称 / 上下文窗口等），
//! 供设置页「获取全部模型」按钮与对话模型下拉复用。鉴权方式与 `test_ai_connection`
//! 一致：可选 Bearer 令牌（DeepSeek 列表接口需要鉴权）。

use super::ModelInfo;
use crate::error::AppError;
use crate::utils::get_http_client;

/// 拉取指定端点的全部可用模型（DeepSeek: GET /models）
///
/// - `endpoint`: 服务商 API 基址（如 https://api.deepseek.com）
/// - `api_key`: 可选 Bearer 令牌；缺失时仍尝试无鉴权请求（部分端点允许）
#[tauri::command]
pub async fn fetch_ai_models(
    endpoint: String,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, AppError> {
    let client = get_http_client();
    let url = format!("{}/models", endpoint.trim_end_matches('/'));

    let mut req = client.get(&url);
    if let Some(ref key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let response = req.send().await.map_err(|e| {
        AppError::Business(format!(
            "无法连接到 AI 服务: {}\n请检查 API 地址和网络连接",
            e
        ))
    })?;

    let status = response.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppError::Business(
                "认证失败 (401): API Key 无效或未提供".to_string(),
            ));
        }
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Business(format!(
            "AI 服务返回错误 ({}): {}",
            status, text
        )));
    }

    let data = response.json::<serde_json::Value>().await.map_err(|e| {
        AppError::Business(format!("无法解析模型列表响应: {}", e))
    })?;

    // 防御式解析：各字段可能缺失或命名不同，逐字段取用并跳过无 id 的项
    let mut models = Vec::new();
    if let Some(arr) = data.get("data").and_then(|v| v.as_array()) {
        for m in arr {
            let id = match m.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            models.push(ModelInfo {
                id,
                name: m.get("name").and_then(|v| v.as_str()).map(String::from),
                owned_by: m.get("owned_by").and_then(|v| v.as_str()).map(String::from),
                context_window: m.get("context_window").and_then(|v| v.as_u64()),
                max_output_tokens: m.get("max_output_tokens").and_then(|v| v.as_u64()),
                input_modalities: m
                    .get("input_modalities")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    }),
                output_modalities: m
                    .get("output_modalities")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    }),
            });
        }
    }

    Ok(models)
}
