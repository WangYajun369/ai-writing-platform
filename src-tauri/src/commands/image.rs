//! 图片处理 IPC 命令
//!
//! v1.20 重构：编辑器图片从 data URL 内嵌迁移到独立文件存储。
//! 命令调用 `image_asset_service::create_or_find` 完成：
//!   1. 校验源文件（格式 + 大小）
//!   2. SHA-256 去重（相同内容不重复存）
//!   3. 存压缩版到 `{app_data_dir}/images/`
//!   4. 插入 image_assets 表（含原图元数据用于溯源）
//!   5. 返回 asset:// 协议 URL（Tauri assetProtocol 直接可渲染）
//!
//! 向后兼容：历史 content_html 里的 `data:image/...;base64,...` 仍然正常渲染
//! （前端渲染兼容层支持两种 src 格式），懒迁移在章节打开时触发。

use crate::db::AppDb;
use crate::error::AppError;
use crate::service::image_asset_service::{self, CreateAssetArgs, CreateAssetResult, CropArea};
use crate::models::ImageAsset;
use tauri::{AppHandle, State};

const DEFAULT_MAX_WIDTH: u32 = 1200;
const DEFAULT_QUALITY: u8 = 80;

/// 编辑器插图：上传本地文件 → 存资产 → 返回 asset URL
#[tauri::command]
pub async fn process_image(
    app: AppHandle,
    db: State<'_, AppDb>,
    source_path: String,
    max_width: Option<u32>,
    quality: Option<u8>,
) -> Result<CreateAssetResult, AppError> {
    let args = CreateAssetArgs {
        source_path,
        source: "upload".into(),
        original_name: String::new(),
        source_url: String::new(),
        max_width: max_width.or(Some(DEFAULT_MAX_WIDTH)),
        quality: quality.or(Some(DEFAULT_QUALITY)),
        crop: None,
    };
    image_asset_service::create_or_find(&app, &db, &args)
}

/// 编辑器裁剪插图：Rust 端按 crop 参数裁剪 → 存资产 → 返回 asset URL
///
/// 裁剪由 **Rust image crate** 在服务端完成（`crop_imm`），
/// 保证像素级精确裁剪、坐标安全边界校验、与压缩/格式选择同一条流水线。
/// 前端 ImageCropperDialog 只负责收集裁剪区域参数（原图自然像素坐标）。
#[tauri::command]
pub async fn process_image_cropped(
    app: AppHandle,
    db: State<'_, AppDb>,
    source_path: String,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
    max_width: Option<u32>,
    quality: Option<u8>,
) -> Result<CreateAssetResult, AppError> {
    let crop = CropArea {
        x: crop_x,
        y: crop_y,
        width: crop_w,
        height: crop_h,
    };
    let args = CreateAssetArgs {
        source_path,
        source: "crop".into(),
        original_name: String::new(),
        source_url: String::new(),
        max_width: max_width.or(Some(DEFAULT_MAX_WIDTH)),
        quality: quality.or(Some(DEFAULT_QUALITY)),
        crop: Some(crop),
    };
    image_asset_service::create_or_find(&app, &db, &args)
}

/// 溯源面板：从 img src URL 反查资产元数据（含原图尺寸/格式/来源/上传时间）
///
/// 支持 asset:// 格式（新）和 data URL（旧，返回 None）。
#[tauri::command]
pub async fn image_asset_get_by_src(
    db: State<'_, AppDb>,
    src: String,
) -> Result<Option<ImageAsset>, AppError> {
    image_asset_service::get_by_src(&db, &src)
}
