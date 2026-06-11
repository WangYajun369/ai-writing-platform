//! 图片处理 IPC 命令
//!
//! 提供统一的图片压缩、缩放和 Base64 编码功能。
//! 图片以压缩后的 Base64 data URL 形式内嵌在 HTML 中，
//! 确保导出/导入完全自包含，无需外部文件依赖。

use image::GenericImageView;
use image::codecs::jpeg::JpegEncoder;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use crate::error::AppError;

const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const MAX_SOURCE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

/// 核心图片处理函数：读取 → 缩放 → JPEG 编码 → Base64 data URL
///
/// - `max_width`: 最大宽度（像素），等比缩放，默认 1200
/// - `quality`: JPEG 质量 1-100，默认 80
///
/// 返回 `data:image/jpeg;base64,...` 格式的字符串。
pub fn process_image_data(
    source_path: &str,
    max_width: u32,
    quality: u8,
) -> Result<String, AppError> {
    let src = std::path::Path::new(source_path);

    // 校验扩展名
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::Business(format!("不支持的图片格式：.{ext}")));
    }

    // 校验文件大小
    let metadata =
        std::fs::metadata(src).map_err(|e| AppError::Business(format!("无法读取图片文件: {e}")))?;
    if metadata.len() > MAX_SOURCE_SIZE {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        return Err(AppError::Business(format!("图片文件过大（{:.1} MB），最大 20 MB", size_mb)));
    }

    // 解码图片
    let img = image::open(src).map_err(|e| AppError::Business(format!("解码图片失败: {e}")))?;
    let (w, h) = img.dimensions();
    let quality = quality.clamp(1, 100);

    // 等比缩放（仅当宽度超过限制时）
    let processed = if w > max_width {
        let new_h = (h as f64 * max_width as f64 / w as f64).round() as u32;
        img.resize_exact(max_width, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // JPEG 编码到内存缓冲区（使用指定质量）
    let mut bytes = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
    processed
        .write_with_encoder(encoder)
        .map_err(|e| AppError::Business(format!("图片编码失败: {e}")))?;

    // Base64 编码
    let b64 = STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

/// Tauri 命令：处理图片并返回 Base64 data URL
///
/// 用于编辑器插入/替换图片。
#[tauri::command]
pub async fn process_image(
    source_path: String,
    max_width: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    process_image_data(&source_path, max_width.unwrap_or(1200), quality.unwrap_or(80))
}
