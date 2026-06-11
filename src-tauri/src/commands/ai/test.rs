//! AI 服务连接测试
//!
//! 验证 API 端点的可达性和认证有效性。

use crate::error::AppError;
use crate::utils::get_http_client;
use super::ConnectionTestResult;

/// 测试 AI 服务连接：GET /models，验证可达性和认证
#[tauri::command]
pub async fn test_ai_connection(
    _provider: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<ConnectionTestResult, AppError> {
    let client = get_http_client();

    let url = format!("{}/models", endpoint.trim_end_matches('/'));

    let mut req = client.get(&url);
    if let Some(ref key) = api_key {
        req = req.header("Authorization", format!("Bearer {}", key));
    }

    let response = req
        .send()
        .await
        .map_err(|e| AppError::Business(format!("无法连接到 AI 服务: {}\n请检查 API 地址和网络连接", e)))?;

    let status = response.status();

    if status.is_success() {
        match response.json::<serde_json::Value>().await {
            Ok(data) => {
                let models: Vec<String> = data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["id"].as_str().map(String::from))
                            .take(10)
                            .collect()
                    })
                    .unwrap_or_default();

                let detail = if models.is_empty() {
                    "AI 服务已连接".to_string()
                } else if models.len() >= 10 {
                    format!("AI 服务已连接，可用模型: {}...", models.join(", "))
                } else {
                    format!("AI 服务已连接，可用模型: {}", models.join(", "))
                };
                Ok(ConnectionTestResult { ok: true, detail })
            }
            Err(_) => Ok(ConnectionTestResult {
                ok: true,
                detail: "AI 服务已连接（无法解析模型列表）".to_string(),
            }),
        }
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        Ok(ConnectionTestResult {
            ok: false,
            detail: "认证失败 (401): API Key 无效或未提供".to_string(),
        })
    } else {
        let text = response.text().await.unwrap_or_default();
        Ok(ConnectionTestResult {
            ok: false,
            detail: format!("AI 服务返回错误 ({}): {}", status, text),
        })
    }
}
