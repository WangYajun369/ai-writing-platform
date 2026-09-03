//! TTS 朗读命令：豆包语音合成（seed-tts）合成 单词·词组·句子 读音
//!
//! 走火山引擎「豆包语音」开放接口 v3 单向流式（HTTP POST + NDJSON 行响应）：
//!   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
//!
//! 请求头鉴权（API Key 单 key 体系，控制台「豆包语音 → API Key 管理」创建）：
//!   - `X-Api-Key`：豆包语音 API Key（UUID 格式）
//!   - `X-Api-Resource-Id`：模型资源，朗读 `seed-tts-2.0` / 声音复刻 `seed-icl-2.0`
//!   - `X-Api-Request-Id`：每次请求唯一 ID（uuid v4）
//!
//! 注意：不要用 `Authorization: Bearer`（方舟 LLM 鉴权）或旧 AppID+AccessKey 签名体系，二者均不被接受。
//!
//! 响应为 NDJSON 流：`code == 0` 且带 `data`（base64 音频片段）时收集；
//! `code == 20000000` 表示全部推送完毕；其它 code 视为错误。
//! 合成结果聚合成整段 MP3，缓存到 `<app_data>/tts/<sha256(text|speaker)>.mp3`，
//! 同文本重复朗读直接命中缓存（幂等，不再调用接口）。
//! 缓存目录位于 app_data_dir 下，已落入 assetProtocol `$APPDATA/**` scope，前端可 convertFileSrc 播放。

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::utils::get_http_client;

/// 火山引擎「豆包语音」TTS v3 单向流式 HTTP 端点
const TTS_ENDPOINT: &str = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/// 语音合成大模型资源 ID（朗读 TTS）
const TTS_RESOURCE_ID: &str = "seed-tts-2.0";

/// 音频缓存子目录（位于 app_data_dir 下）
const TTS_CACHE_DIR: &str = "tts";

/// 默认音色 ID：Vivi 2.0（青年女声，seed-tts 大模型标准音色，中英文可读；
/// 更多音色在豆包语音控制台「音色库」试听复制）
const DEFAULT_SPEAKER: &str = "zh_female_vv_uranus_bigtts";

/// 合成请求超时（单词级音频通常 < 5s，留足网络余量）
const REQUEST_TIMEOUT_SECS: u64 = 30;

/// 结束标记 code：收到即表示全部音频推送完毕
const FINISH_CODE: i64 = 20000000;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakArgs {
    /// 要朗读的英文文本（单词 / 词组 / 句子）
    pub text: String,
    /// 豆包语音 API Key（UUID，鉴权头 X-Api-Key）
    pub api_key: String,
    /// 音色 ID（seed-tts 大模型音色），缺省使用默认音色
    pub speaker: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakResult {
    /// 音频文件绝对路径（前端 convertFileSrc 后交给 <audio> 播放）
    pub audio_path: String,
    /// 是否命中本地缓存（未重新调用接口）
    pub cached: bool,
}

/// 朗读：幂等合成。缓存命中直接返回，未命中调用火山接口合成后落盘
#[tauri::command]
pub async fn tts_speak(app: AppHandle, args: TtsSpeakArgs) -> Result<TtsSpeakResult, AppError> {
    let text = args.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::Business("朗读文本不能为空".to_string()));
    }

    let api_key = args.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::Business(
            "尚未配置朗读服务（豆包语音 API Key），请在朗读设置中填写".to_string(),
        ));
    }

    let speaker = args
        .speaker
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SPEAKER)
        .to_string();

    // 1. 缓存目录 + 幂等键
    let dir = cache_dir(&app)?;
    let file = dir.join(cache_name(&text, &speaker));
    if file.exists() {
        return Ok(TtsSpeakResult {
            audio_path: path_to_string(&file),
            cached: true,
        });
    }

    // 2. 调用火山接口合成
    let audio = synthesize(&api_key, &speaker, &text).await?;

    // 3. 落盘缓存
    std::fs::write(&file, &audio).map_err(|e| {
        AppError::Business(format!("写入音频缓存失败: {e}"))
    })?;
    crate::app_log!(
        "[TTS] 合成成功 text={:?} speaker={} bytes={}",
        text,
        speaker,
        audio.len()
    );

    Ok(TtsSpeakResult {
        audio_path: path_to_string(&file),
        cached: false,
    })
}

/// 调用豆包语音 v3 单向流式接口，聚合返回完整 MP3 字节
async fn synthesize(api_key: &str, speaker: &str, text: &str) -> Result<Vec<u8>, AppError> {
    let payload = serde_json::json!({
        "user": { "uid": "mirageink" },
        "req_params": {
            "text": text,
            "speaker": speaker,
            "speed_ratio": 1.0,
            "volume_ratio": 1.0,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000
            }
        }
    });

    let request_id = uuid::Uuid::new_v4().to_string();
    let resp = get_http_client()
        .post(TTS_ENDPOINT)
        .header("X-Api-Key", api_key)
        .header("X-Api-Resource-Id", TTS_RESOURCE_ID)
        .header("X-Api-Request-Id", request_id)
        .header("Content-Type", "application/json")
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| AppError::Business(format!("请求豆包语音合成失败: {e}")))?;

    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Business(format!("读取火山语音合成响应失败: {e}")))?;

    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes).trim().to_string();
        return Err(AppError::Business(format!(
            "火山语音合成请求失败 (HTTP {status}): {detail}"
        )));
    }

    // NDJSON：逐行解析，code==0 且带 data(base64) 时收集音频
    let mut audio: Vec<u8> = Vec::new();
    let mut last_error: Option<String> = None;

    for line in bytes.split(|&b| b == b'\n') {
        let line = std::str::from_utf8(line).map(str::trim).unwrap_or("");
        if line.is_empty() {
            continue;
        }
        let item: serde_json::Value = serde_json::from_str(line).unwrap_or_default();
        if !item.is_object() {
            continue;
        }
        let code = item.get("code").and_then(serde_json::Value::as_i64).unwrap_or(-1);
        if code == FINISH_CODE {
            break; // 全部推送完毕
        }
        if code != 0 {
            let message = item
                .get("message")
                .and_then(serde_json::Value::as_str)
                .or_else(|| item.get("msg").and_then(serde_json::Value::as_str))
                .unwrap_or("");
            last_error = Some(format!("code={code} {message}"));
            continue;
        }
        if let Some(b64) = item.get("data").and_then(serde_json::Value::as_str) {
            if let Ok(chunk) = base64::engine::general_purpose::STANDARD.decode(b64) {
                audio.extend_from_slice(&chunk);
            }
        }
    }

    if audio.is_empty() {
        let reason = last_error
            .map(|e| format!("（服务端错误: {e}）"))
            .unwrap_or_else(|| "（未收到任何音频数据）".to_string());
        return Err(AppError::Business(format!("语音合成失败{reason}")));
    }

    Ok(audio)
}

/// 缓存目录：<app_data>/tts（自动创建）
fn cache_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取应用数据目录: {e}")))?
        .join(TTS_CACHE_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Business(format!("创建音频缓存目录失败: {e}")))?;
    Ok(dir)
}

/// 幂等缓存文件名：sha256(text + "\n" + speaker) 前 32 位 hex + .mp3
fn cache_name(text: &str, speaker: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update(b"\n");
    hasher.update(speaker.as_bytes());
    let digest = hasher.finalize();
    format!("{}.mp3", hex_prefix(&digest, 32))
}

/// hex 前缀工具（只取前 n 个字符）
fn hex_prefix(bytes: &[u8], n: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(n);
    for &byte in bytes {
        if out.len() >= n {
            break;
        }
        out.push(HEX[(byte >> 4) as usize] as char);
        if out.len() < n {
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn path_to_string(p: &PathBuf) -> String {
    p.to_string_lossy().to_string()
}
