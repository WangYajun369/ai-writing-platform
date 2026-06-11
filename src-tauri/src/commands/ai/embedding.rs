//! RAG 语义检索与 Embedding 生成
//!
//! 对外暴露 Tauri 命令，内部委托给 Service 层处理。
//! 保留 `call_embedding_api` 公开函数供外部调用。

use tauri::{AppHandle, State};
use crate::db::AppDb;
use crate::error::AppError;
use crate::commands::ai::{RagResult, EmbeddingStatus, EmbeddingProgress, ConnectionTestResult};
use crate::service::search_service;
use crate::utils::get_http_client;

/// 调用 SSE 兼容的 Embedding API（智谱等）
pub async fn call_embedding_api(
    endpoint: &str,
    api_key: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    if texts.is_empty() {
        return Ok(vec![]);
    }

    let client = get_http_client();

    let url = format!("{}/embeddings", endpoint.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model,
        "input": texts,
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Business(format!("Embedding API 请求失败: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_text = resp.text().await.unwrap_or_else(|e| format!("(无法读取错误响应体: {e})"));

        let hint = if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&err_text) {
            if let Some(code) = err_json["error"]["code"].as_str() {
                match code {
                    "1210" | "1214" => "（可能原因：单条文本超过了 3072 tokens 限制，已自动截断到 1800 字符；如仍报错请检查 API Key 是否有 Embedding 模型权限）",
                    "1211" => "（模型不存在，请检查 Embedding 模型名称配置）",
                    "1213" => "（缺少必填参数，可能是请求体格式异常）",
                    _ => "",
                }
            } else { "" }
        } else { "" };
        return Err(AppError::Business(format!(
            "Embedding API 返回错误 ({}): {} {}",
            status, err_text, hint
        )));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| AppError::Business(format!("解析响应 JSON 失败: {}", e)))?;

    let items = data["data"]
        .as_array()
        .ok_or_else(|| AppError::Business("Embedding API 返回格式异常: 缺少 data 数组".into()))?;

    let mut indexed: Vec<(usize, Vec<f32>)> = Vec::new();
    for item in items {
        let idx = item["index"].as_u64().unwrap_or(0) as usize;
        if let Some(vec) = item["embedding"].as_array() {
            let floats: Vec<f32> = vec
                .iter()
                .filter_map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            indexed.push((idx, floats));
        }
    }
    indexed.sort_by_key(|(i, _)| *i);

    Ok(indexed.into_iter().map(|(_, v)| v).collect())
}

/// 测试 RAG Embedding API 是否可用
#[tauri::command]
pub async fn test_rag_connection(
    endpoint: String,
    api_key: String,
    embedding_model: String,
) -> Result<ConnectionTestResult, AppError> {
    match call_embedding_api(&endpoint, &api_key, &embedding_model, &["测试连通性".into()]).await {
        Ok(results) => {
            let dim = results.first().map(|v| v.len()).unwrap_or(0);
            Ok(ConnectionTestResult {
                ok: true,
                detail: format!(
                    "RAG Embedding 服务已连接，{} 模型返回向量维度: {}",
                    embedding_model, dim
                ),
            })
        }
        Err(e) => Ok(ConnectionTestResult {
            ok: false,
            detail: format!("RAG Embedding 连接失败: {}", e),
        }),
    }
}

/// RAG 语义检索（向量相似度搜索）
#[tauri::command]
pub async fn rag_search(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    query: String,
    top_n: usize,
    endpoint: Option<String>,
    api_key: Option<String>,
    embedding_model: Option<String>,
) -> Result<Vec<RagResult>, AppError> {
    search_service::rag_search(
        &app, &db, &book_id, &query, top_n,
        endpoint.as_deref(), api_key.as_deref(), embedding_model.as_deref(),
    ).await
}

/// 检查 Embedding 索引状态
#[tauri::command]
pub fn check_embedding_status(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
) -> Result<EmbeddingStatus, AppError> {
    search_service::check_embedding_status(&app, &db, &book_id)
}

/// 触发 Embedding 生成
#[tauri::command]
pub async fn trigger_embedding(
    app: AppHandle,
    db: State<'_, AppDb>,
    book_id: String,
    endpoint: String,
    api_key: String,
    embedding_model: String,
) -> Result<EmbeddingProgress, AppError> {
    search_service::trigger_embedding(&app, &db, &book_id, &endpoint, &api_key, &embedding_model)
        .await
}
