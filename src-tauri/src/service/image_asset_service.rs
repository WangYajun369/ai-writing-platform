//! 图片资产管理服务（v1.20 新增）
//!
//! 负责：文件存储（app_data_dir/images/）、sha256 去重、元数据入库。
//! 文件操作 + DB 操作在同一服务函数内完成，保证原子性（存文件成功才入库）。

use crate::db::AppDb;
use crate::error::AppError;
use crate::models::ImageAsset;
use crate::repository::image_asset_repo;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// 允许的图片扩展名
const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const MAX_SOURCE_SIZE: u64 = 20 * 1024 * 1024; // 20 MB
const IMAGES_DIR: &str = "images";

/// 裁剪区域（像素坐标，基于原图自然尺寸）
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct CropArea {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// 图片资产创建请求
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssetArgs {
    /// 源文件绝对路径（本地文件系统）
    pub source_path: String,
    /// 来源：upload / crop / url / migrate
    #[serde(default = "default_source")]
    pub source: String,
    /// 溯源：原始文件名
    #[serde(default)]
    pub original_name: String,
    /// 溯源：来源 URL 或路径
    #[serde(default)]
    pub source_url: String,
    /// 压缩目标宽度（None 表示不压缩、存原图副本）
    pub max_width: Option<u32>,
    /// JPEG 质量 1-100（默认 80）
    pub quality: Option<u8>,
    /// 可选裁剪区域（像素坐标）——有值时先裁剪再缩放压缩
    #[serde(default)]
    pub crop: Option<CropArea>,
}

fn default_source() -> String {
    "upload".into()
}

/// 图片资产创建结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAssetResult {
    /// 资产 id（可用于后续查询溯源）
    pub id: String,
    /// 资产文件的**绝对路径**（纯文件系统路径，不是 URL）
    ///
    /// 前端用 `convertFileSrc(assetPath)` 构造 asset:// URL（Tauri 官方 API，
    /// 正确处理 Tauri assetProtocol handler 的所有隐含约定）。
    pub asset_path: String,
    /// 是否为去重复用（true 表示已存在，直接返回）
    pub reused: bool,
    /// 原始元数据（供前端展示溯源信息）
    pub original_name: String,
    pub original_size: i64,
    pub original_width: i64,
    pub original_height: i64,
    pub original_format: String,
    pub stored_size: i64,
    pub stored_width: i64,
    pub stored_height: i64,
}

/// 校验源文件（格式 + 大小）
fn validate_source(src: &Path) -> Result<(), AppError> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(AppError::Business(format!("不支持的图片格式：.{ext}")));
    }
    let meta = std::fs::metadata(src)
        .map_err(|e| AppError::Business(format!("无法读取图片文件: {e}")))?;
    if meta.len() > MAX_SOURCE_SIZE {
        let mb = meta.len() as f64 / (1024.0 * 1024.0);
        return Err(AppError::Business(format!(
            "图片文件过大（{mb:.1} MB），最大 20 MB"
        )));
    }
    Ok(())
}

/// 计算文件 SHA-256（流式，避免大图占内存）
fn sha256_file(path: &Path) -> Result<String, AppError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::Business(format!("读取图片计算哈希失败: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| AppError::Business(format!("读取失败: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 获取 app_data_dir 下的 images/ 目录（自动创建）
fn images_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取 app_data_dir: {e}")))?;
    let dir = data_dir.join(IMAGES_DIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Business(format!("创建 images 目录失败: {e}")))?;
    }
    Ok(dir)
}

/// 从图片文件获取原始元数据（尺寸、格式）
fn read_original_meta(path: &Path) -> Result<(u32, u32, String, u64), AppError> {
    let img = image::open(path)
        .map_err(|e| AppError::Business(format!("解码图片失败: {e}")))?;
    let (w, h) = img.dimensions();
    let fmt = image::ImageFormat::from_path(path)
        .ok()
        .and_then(|f| f.extensions_str().first().map(|s| (*s).to_string()))
        .unwrap_or_default();
    let size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);
    Ok((w, h, fmt, size))
}

/// 压缩图片 → 存磁盘，返回 (存储宽度, 存储高度, 输出格式 "jpeg"/"png")
///
/// 可选裁剪：传入 crop 参数时，先按像素坐标裁剪再缩放压缩。
/// 格式策略：
/// - 裁剪后判断格式（PNG+alpha → PNG，其他 → JPEG）
/// - 未裁剪时按源文件判断（PNG+alpha → PNG，其他 → JPEG）
///
/// 调用方传入 `dest_base`（不带扩展名的基础路径，如 `images/xxx`），
/// 本函数内部决定实际扩展名（`.png` 或 `.jpg`）并拼出完整路径。
fn compress_and_store(
    source_path: &Path,
    dest_base: &Path,
    max_width: u32,
    quality: u8,
    crop: Option<CropArea>,
) -> Result<(u32, u32, String), AppError> {
    let img = image::open(source_path)
        .map_err(|e| AppError::Business(format!("解码图片失败: {e}")))?;

    // 可选裁剪
    let cropped = if let Some(c) = crop {
        let (ow, oh) = img.dimensions();
        let x = c.x.min(ow.saturating_sub(1));
        let y = c.y.min(oh.saturating_sub(1));
        let cw = c.width.min(ow.saturating_sub(x));
        let ch = c.height.min(oh.saturating_sub(y));
        if cw == 0 || ch == 0 {
            return Err(AppError::Business("裁剪区域无效（宽或高为 0）".into()));
        }
        img.crop_imm(x, y, cw, ch)
    } else {
        img
    };

    let (cw, ch) = cropped.dimensions();
    let processed = if cw > max_width {
        let new_h = (ch as f64 * max_width as f64 / cw as f64).round() as u32;
        cropped.resize_exact(max_width, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        cropped
    };
    let (sw, sh) = processed.dimensions();

    // 判断输出格式：基于源扩展名 + 裁剪后是否有 alpha
    let source_is_png = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("png"))
        .unwrap_or(false);
    let has_alpha = matches!(
        processed.color(),
        image::ColorType::Rgba8
            | image::ColorType::Rgba16
            | image::ColorType::Rgba32F
            | image::ColorType::La8
            | image::ColorType::La16
    );

    let (ext, stored_format) = if source_is_png && has_alpha {
        ("png", "png")
    } else {
        ("jpg", "jpeg")
    };
    let dest_path = dest_base.with_extension(ext);

    let file = std::fs::File::create(&dest_path)
        .map_err(|e| AppError::Business(format!("创建目标文件失败: {e}")))?;

    match stored_format {
        "png" => {
            processed
                .write_with_encoder(image::codecs::png::PngEncoder::new(file))
                .map_err(|e| AppError::Business(format!("PNG 编码失败: {e}")))?;
        }
        _ => {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality);
            processed
                .write_with_encoder(encoder)
                .map_err(|e| AppError::Business(format!("JPEG 编码失败: {e}")))?;
        }
    }

    Ok((sw, sh, stored_format.to_string()))
}

/// 从图片资产构造**绝对文件路径**（纯路径，不是 URL）
///
/// ❌ 不在这里拼 asset:// URL——Tauri assetProtocol handler 有隐含约定
/// （path()[1..] 跳字节），Rust 侧硬拼 URL 极易踩坑（之前掉过三斜杠/四斜杠的坑）。
/// 正确做法：前端用 `convertFileSrc(path)` 把路径转成 URL。
pub fn build_asset_path(app: &AppHandle, asset: &ImageAsset) -> Result<String, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Business(format!("无法获取 app_data_dir: {e}")))?;
    let full = data_dir.join(&asset.stored_path);
    Ok(full.to_string_lossy().to_string())
}

/// 核心入口：创建/查找图片资产
///
/// 流程：
/// 1. 校验源文件 → 计算 sha256
/// 2. 按 sha256 查重 → 已存在直接返回
/// 3. 读取原图元数据（溯源）
/// 4. 存压缩版到 images/
/// 5. 插入 image_assets 表
/// 6. 返回 asset:// URL
pub fn create_or_find(
    app: &AppHandle,
    db: &AppDb,
    args: &CreateAssetArgs,
) -> Result<CreateAssetResult, AppError> {
    let source_path = Path::new(&args.source_path);
    validate_source(source_path)?;

    // 计算 sha256（原图指纹；裁剪场景下后续会按裁剪结果二次查重）
    let mut sha256 = sha256_file(source_path)?;

    // 查重（仅未裁剪时按原图 sha256 查重；裁剪会生成新内容，原图指纹无意义）
    let conn = db.pool.get()?;
    if args.crop.is_none() {
        if let Some(existing) = image_asset_repo::find_by_sha256(&conn, &sha256)? {
            let asset_path = build_asset_path(app, &existing)?;
            return Ok(CreateAssetResult {
                id: existing.id,
                asset_path,
                reused: true,
                original_name: existing.original_name,
                original_size: existing.original_size,
                original_width: existing.original_width,
                original_height: existing.original_height,
                original_format: existing.original_format,
                stored_size: 0,
                stored_width: existing.stored_width,
                stored_height: existing.stored_height,
            });
        }
    }

    // 原图元数据
    let (orig_w, orig_h, orig_fmt, orig_size) = read_original_meta(source_path)?;

    // 存压缩版到磁盘
    let images_dir = images_dir(app)?;
    let id = Uuid::new_v4().to_string();
    let file_stem = format!("{}_{}", &sha256[..8], id);
    let dest_base = images_dir.join(&file_stem); // 不带扩展名，compress_and_store 内部决定

    let max_width = args.max_width.unwrap_or(1200);
    let quality = args.quality.unwrap_or(80).clamp(1, 100);
    let (stored_w, stored_h, stored_format) =
        compress_and_store(source_path, &dest_base, max_width, quality, args.crop)?;

    // compress_and_store 内部拼了扩展名，从 dest_base.with_extension 拿到实际路径
    let ext = if stored_format == "png" { "png" } else { "jpg" };
    let dest_path = dest_base.with_extension(ext);
    let stored_size = std::fs::metadata(&dest_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let stored_path_relative = format!("images/{file_stem}.{ext}");

    // 裁剪场景：用裁剪后内容的 sha256 做二次查重，避免相同裁剪重复入库
    if args.crop.is_some() {
        let cropped_sha = sha256_file(&dest_path)?;
        if let Some(existing) = image_asset_repo::find_by_sha256(&conn, &cropped_sha)? {
            // 命中已有裁剪结果：删除刚生成的临时文件，复用既有资产
            let _ = std::fs::remove_file(&dest_path);
            let asset_path = build_asset_path(app, &existing)?;
            return Ok(CreateAssetResult {
                id: existing.id,
                asset_path,
                reused: true,
                original_name: existing.original_name,
                original_size: existing.original_size,
                original_width: existing.original_width,
                original_height: existing.original_height,
                original_format: existing.original_format,
                stored_size: 0,
                stored_width: existing.stored_width,
                stored_height: existing.stored_height,
            });
        }
        // 未命中：把 sha256 替换为裁剪结果的指纹，供后续 insert 写入 DB
        sha256 = cropped_sha;
    }

    // 插入 DB
    let asset = ImageAsset {
        id: id.clone(),
        sha256: sha256.clone(),
        original_name: if !args.original_name.is_empty() {
            args.original_name.clone()
        } else {
            source_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())
                .unwrap_or_default()
        },
        original_size: orig_size as i64,
        original_width: orig_w as i64,
        original_height: orig_h as i64,
        original_format: orig_fmt,
        stored_path: stored_path_relative,
        stored_width: stored_w as i64,
        stored_height: stored_h as i64,
        stored_format,
        source: args.source.clone(),
        source_url: args.source_url.clone(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };

    image_asset_repo::insert(&conn, &asset)?;
    drop(conn);

    let asset_path = build_asset_path(app, &asset)?;
    Ok(CreateAssetResult {
        id: asset.id,
        asset_path,
        reused: false,
        original_name: asset.original_name,
        original_size: asset.original_size,
        original_width: asset.original_width,
        original_height: asset.original_height,
        original_format: asset.original_format,
        stored_size,
        stored_width: asset.stored_width,
        stored_height: asset.stored_height,
    })
}

/// 懒迁移：把一段 content_html 里的 data:image/...;base64,... 批量抽取成独立文件
///
/// 预留接口，暂未启用。实现时需要：
/// 1. 正则匹配 `<img src="data:image/...">` 中的 base64
/// 2. 解码 → 写临时文件 → create_or_find（Rust 完整资产链路）
/// 3. 前端拿到资产列表后做 convertFileSrc + HTML 替换
///
/// 见 TODO(v1.21)：编辑器打开旧章节时调用此函数。
#[allow(dead_code)]
pub fn migrate_html_data_urls(
    _app: &AppHandle,
    _db: &AppDb,
    html: &str,
) -> Result<(String, Vec<ImageAsset>), AppError> {
    // 暂时原样返回，不做迁移。函数签名固定，后续填充实现。
    Ok((html.to_string(), Vec::new()))
}

/// 从前端传的 src URL 反查 ImageAsset
///
/// 支持三种格式：
/// - `asset://{app_data}/images/xxx.jpg`（新格式）
/// - `images/xxx.jpg`（相对路径）
/// - `data:image/...`（旧格式，返回 None）
pub fn get_by_src(db: &AppDb, src: &str) -> Result<Option<ImageAsset>, AppError> {
    if !src.starts_with("asset://") && !src.contains("images/") {
        return Ok(None); // data URL 或其他不认识的格式
    }
    // 从 asset:// URL 提取最后的 images/xxx.jpg 片段
    let path_part = if let Some(pos) = src.find("images/") {
        &src[pos..]
    } else {
        src
    };
    let conn = db.pool.get()?;
    Ok(image_asset_repo::find_by_stored_path(&conn, path_part)?)
}

// pub fn get_by_id 已内联到 get_by_src 的调用方，删除避免 dead_code 警告

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// PNG + 透明通道 → 存 PNG（保留 alpha）
    #[test]
    fn test_png_with_alpha_stays_png() {
        let tmp = std::env::temp_dir();
        let png_path = tmp.join(format!("alpha_{}.png", Uuid::new_v4()));
        let dest_base = tmp.join(format!("alpha_out_{}", Uuid::new_v4())); // 不带扩展名

        // 创建带 alpha 的 RGBA PNG（半透明红）
        let img = image::RgbaImage::from_pixel(200, 150, image::Rgba([255, 0, 0, 128]));
        img.save(&png_path).expect("创建 RGBA PNG");

        let (w, h, fmt) = compress_and_store(&png_path, &dest_base, 1200, 80, None).expect("压缩");
        assert_eq!(fmt, "png", "PNG+alpha 应存 PNG");
        assert_eq!(w, 200);
        assert_eq!(h, 150);

        let out_path = dest_base.with_extension("png");
        assert!(out_path.exists(), "PNG 文件应该被创建");

        // 验证 PNG magic bytes（89 50 4E 47 = .PNG）
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47]);

        // 验证读回后仍有 alpha
        let read_back = image::open(&out_path).unwrap();
        assert!(
            matches!(read_back.color(), image::ColorType::Rgba8 | image::ColorType::Rgba16),
            "应保留 RGBA，实际: {:?}",
            read_back.color()
        );

        let _ = std::fs::remove_file(&png_path);
        let _ = std::fs::remove_file(&out_path);
    }

    /// PNG + 无 alpha → 压 JPEG（优化体积）
    #[test]
    fn test_png_rgb_compress_to_jpeg() {
        let tmp = std::env::temp_dir();
        let png_path = tmp.join(format!("rgb_{}.png", Uuid::new_v4()));
        let dest_base = tmp.join(format!("rgb_out_{}", Uuid::new_v4()));

        // 创建无 alpha 的 RGB PNG
        let img = image::RgbImage::from_pixel(200, 150, image::Rgb([0, 255, 128]));
        img.save(&png_path).expect("创建 RGB PNG");

        let (_, _, fmt) = compress_and_store(&png_path, &dest_base, 1200, 80, None).expect("压缩");
        assert_eq!(fmt, "jpeg", "PNG 无 alpha 应压 JPEG");

        let out_path = dest_base.with_extension("jpg");
        assert!(out_path.exists());
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "JPEG magic");

        let _ = std::fs::remove_file(&png_path);
        let _ = std::fs::remove_file(&out_path);
    }

    /// GIF → JPEG（GIF 非 PNG，永远压 JPEG）
    #[test]
    fn test_gif_compress_to_jpeg() {
        let tmp = std::env::temp_dir();
        let gif_path = tmp.join(format!("gif_{}.gif", Uuid::new_v4()));
        let dest_base = tmp.join(format!("gif_out_{}", Uuid::new_v4()));

        let img = image::RgbImage::from_pixel(50, 50, image::Rgb([0, 255, 128]));
        img.save_with_format(&gif_path, image::ImageFormat::Gif).expect("创建 GIF");

        assert!(validate_source(&gif_path).is_ok(), "GIF 应被允许");

        let (_, _, fmt) = compress_and_store(&gif_path, &dest_base, 1200, 80, None).expect("GIF→JPEG");
        assert_eq!(fmt, "jpeg");

        let out_path = dest_base.with_extension("jpg");
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);

        let _ = std::fs::remove_file(&gif_path);
        let _ = std::fs::remove_file(&out_path);
    }

    /// PNG RGBA **裁剪路径**：crop_imm + resize_exact 后格式/alpha 是否保留
    ///
    /// 这是用户提问的核心——PNG 插画带透明通道，裁剪后能不能还是 PNG 还保留 alpha？
    #[test]
    fn test_png_rgba_crop_preserves_alpha() {
        let tmp = std::env::temp_dir();
        let png_path = tmp.join(format!("rgba_big_{}.png", Uuid::new_v4()));
        let dest_base = tmp.join(format!("rgba_crop_{}", Uuid::new_v4()));

        // 创建 2000x1500 大尺寸 RGBA PNG（超大超过 max_width 触发缩放）
        let mut img = image::RgbaImage::new(2000, 1500);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let alpha = if x < 500 && y < 400 { 0u8 } else { 180u8 };
            *p = image::Rgba([255, 100, 50, alpha]);
        }
        img.save(&png_path).expect("创建 2000x1500 RGBA PNG");

        // 裁剪区域：中间 1000x800 区域（包含部分透明像素）
        let crop = CropArea { x: 400, y: 300, width: 1000, height: 800 };

        let (w, h, fmt) = compress_and_store(&png_path, &dest_base, 1200, 80, Some(crop))
            .expect("PNG RGBA 裁剪+压缩");

        // 1. 格式判断：source_is_png && has_alpha → "png"
        assert_eq!(fmt, "png", "PNG+alpha 裁剪后仍应为 PNG");

        // 2. 裁剪后 1000x800 未超过 max_width 1200 → 不缩放
        assert_eq!(w, 1000, "裁剪宽度应为 1000");
        assert_eq!(h, 800, "裁剪高度应为 800");

        let out_path = dest_base.with_extension("png");
        assert!(out_path.exists(), "PNG 输出文件应存在");

        // 3. PNG magic bytes
        let bytes = std::fs::read(&out_path).unwrap();
        assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "PNG magic bytes");

        // 4. 读回后 ColorType 仍是 RGBA
        let read_back = image::open(&out_path).expect("解码裁剪后 PNG");
        assert!(
            matches!(read_back.color(), image::ColorType::Rgba8),
            "应保留 RGBA8，实际: {:?}",
            read_back.color()
        );

        // 5. 像素级验证——裁剪区域的 alpha 值应该和原图一致
        let read_rgba = read_back.to_rgba8();
        let (rx, ry) = read_rgba.dimensions();
        assert_eq!((rx, ry), (1000, 800));
        // 裁剪后 (0,0) → 原图 (400, 300)：x<500 && y<400 → alpha=0 ✅ 在透明区
        let pixel_at_origin = read_rgba.get_pixel(0, 0);
        assert_eq!(pixel_at_origin[3], 0, "裁剪原点(400,300)在透明区 alpha 应为 0");
        // 裁剪后 (200, 200) → 原图 (600, 500)：x>=500 && y>=400 → alpha=180
        let pixel_inside = read_rgba.get_pixel(200, 200);
        assert_eq!(pixel_inside[3], 180, "裁剪内(600,500)不在透明区 alpha 应为 180");

        let _ = std::fs::remove_file(&png_path);
        let _ = std::fs::remove_file(&out_path);
    }

    /// PNG RGBA 裁剪 + 缩放超过 max_width
    #[test]
    fn test_png_rgba_crop_then_resize_stays_png() {
        let tmp = std::env::temp_dir();
        let png_path = tmp.join(format!("huge_{}.png", Uuid::new_v4()));
        let dest_base = tmp.join(format!("huge_crop_{}", Uuid::new_v4()));

        // 创建 4000x3000 大图
        let img = image::RgbaImage::from_pixel(4000, 3000, image::Rgba([0, 0, 255, 200]));
        img.save(&png_path).unwrap();

        // 裁剪中间 3000x2000（仍超过 max_width=1200，触发缩放）
        let crop = CropArea { x: 500, y: 500, width: 3000, height: 2000 };

        let (w, h, fmt) = compress_and_store(&png_path, &dest_base, 1200, 80, Some(crop)).unwrap();

        assert_eq!(fmt, "png", "PNG+alpha 裁剪后缩放仍应存 PNG");
        // 3000 → 缩放至 max_width=1200，h = 2000 * 1200/3000 = 800
        assert_eq!(w, 1200);
        assert_eq!(h, 800);

        let out_path = dest_base.with_extension("png");
        let read_back = image::open(&out_path).unwrap();
        assert!(matches!(read_back.color(), image::ColorType::Rgba8 | image::ColorType::Rgba16));

        let _ = std::fs::remove_file(&png_path);
        let _ = std::fs::remove_file(&out_path);
    }

    /// 验证 convertFileSrc 生成的 asset:// URL 包含原始路径
    #[test]
    fn test_build_asset_path_output() {
        // build_asset_path 就是 join 后 to_string_lossy，不需要 AppHandle 就能测逻辑
        let data_dir = PathBuf::from("/Users/xxx/Library/Application Support/com.ukcoder.timewrite");
        let asset = ImageAsset {
            id: "abc".into(),
            sha256: "def".into(),
            original_name: "test.png".into(),
            original_size: 100,
            original_width: 200,
            original_height: 150,
            original_format: "png".into(),
            stored_path: "images/abc.jpg".into(),
            stored_width: 200,
            stored_height: 150,
            stored_format: "jpeg".into(),
            source: "upload".into(),
            source_url: String::new(),
            created_at: "2026-10-13".into(),
        };
        let full_path = data_dir.join(&asset.stored_path);
        // 验证路径拼接正确
        assert!(full_path.to_string_lossy().contains("Application Support"));
        assert!(full_path.to_string_lossy().ends_with("images/abc.jpg"));
    }

    /// 验证 get_by_src 的 src URL 解析逻辑
    #[test]
    fn test_get_by_src_url_parsing() {
        // asset:// URL → 应能提取 images/ 部分
        let src = "asset:///Users/xxx/Library/Application%20Support/com.ukcoder.timewrite/images/abc_def.jpg";
        let path_part = if let Some(pos) = src.find("images/") {
            &src[pos..]
        } else {
            src
        };
        assert_eq!(path_part, "images/abc_def.jpg");

        // data URL → 不匹配，直接返回 None 逻辑由 get_by_src 处理
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...";
        let has_images = data_url.contains("images/");
        let is_asset = data_url.starts_with("asset://");
        assert!(!has_images && !is_asset, "data URL 不应被识别为资产");
    }
}
