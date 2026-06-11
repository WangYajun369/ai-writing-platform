//! 图片处理 IPC 命令
//!
//! 提供统一的图片压缩、缩放、裁剪和 Base64 编码功能。
//! 图片以压缩后的 Base64 data URL 形式内嵌在 HTML 中，
//! 确保导出/导入完全自包含，无需外部文件依赖。

use image::GenericImageView;
use image::codecs::jpeg::JpegEncoder;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use crate::error::AppError;

const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const MAX_SOURCE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

/// 校验图片文件扩展名和大小
fn validate_source(src: &std::path::Path) -> Result<(), AppError> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::Business(format!("不支持的图片格式：.{ext}")));
    }
    let metadata =
        std::fs::metadata(src).map_err(|e| AppError::Business(format!("无法读取图片文件: {e}")))?;
    if metadata.len() > MAX_SOURCE_SIZE {
        let size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
        return Err(AppError::Business(format!("图片文件过大（{:.1} MB），最大 20 MB", size_mb)));
    }
    Ok(())
}

/// 图片缩放 + JPEG 编码 + Base64
fn encode_image(img: image::DynamicImage, max_width: u32, quality: u8) -> Result<String, AppError> {
    let (w, h) = img.dimensions();
    let quality = quality.clamp(1, 100);

    let processed = if w > max_width {
        let new_h = (h as f64 * max_width as f64 / w as f64).round() as u32;
        img.resize_exact(max_width, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut bytes = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
    processed
        .write_with_encoder(encoder)
        .map_err(|e| AppError::Business(format!("图片编码失败: {e}")))?;

    let b64 = STANDARD.encode(&bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

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
    validate_source(src)?;

    let img = image::open(src).map_err(|e| AppError::Business(format!("解码图片失败: {e}")))?;
    encode_image(img, max_width, quality)
}

/// 带裁剪的图片处理：裁剪 → 缩放 → JPEG 编码 → Base64 data URL
///
/// - `crop_x`, `crop_y`: 裁剪区域左上角坐标（像素）
/// - `crop_w`, `crop_h`: 裁剪区域宽高（像素）
/// - `max_width`: 裁剪后的最大宽度限制
/// - `quality`: JPEG 质量 1-100
pub fn process_image_with_crop(
    source_path: &str,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
    max_width: u32,
    quality: u8,
) -> Result<String, AppError> {
    let src = std::path::Path::new(source_path);
    validate_source(src)?;

    if crop_w == 0 || crop_h == 0 {
        return Err(AppError::Business("裁剪区域无效：宽度或高度为 0".into()));
    }

    let mut img = image::open(src).map_err(|e| AppError::Business(format!("解码图片失败: {e}")))?;
    let (iw, ih) = img.dimensions();

    // 边界检查
    if crop_x >= iw || crop_y >= ih {
        return Err(AppError::Business("裁剪区域超出图片边界".into()));
    }
    let actual_w = crop_w.min(iw - crop_x);
    let actual_h = crop_h.min(ih - crop_y);

    // 裁剪
    img = img.crop_imm(crop_x, crop_y, actual_w, actual_h);

    encode_image(img, max_width, quality)
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

/// Tauri 命令：裁剪图片并返回 Base64 data URL
///
/// 用于编辑器插入裁剪后的图片。前端 react-easy-crop 获取裁剪参数，
/// 后端执行实际的像素级裁剪 + 压缩 + Base64 编码。
#[tauri::command]
pub async fn process_image_cropped(
    source_path: String,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
    max_width: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    process_image_with_crop(
        &source_path,
        crop_x,
        crop_y,
        crop_w,
        crop_h,
        max_width.unwrap_or(1200),
        quality.unwrap_or(80),
    )
}
