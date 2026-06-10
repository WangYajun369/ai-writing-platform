/**
 * 图片工具模块
 *
 * 统一的图片处理入口：读取本地文件 → Rust 端压缩/缩放/Base64 编码 →
 * 返回 data: URL 内嵌到 HTML。确保导出/导入完全自包含。
 */
import { invoke } from '@tauri-apps/api/core'

/** 编辑器图片：最大宽度 1200px，JPEG 质量 80% */
const EDITOR_MAX_WIDTH = 1200
const EDITOR_QUALITY = 80

/** 封面图片：最大宽度 800px，JPEG 质量 85% */
const COVER_MAX_WIDTH = 800
const COVER_QUALITY = 85

/**
 * 处理编辑器图片：压缩 + 返回 Base64 data URL
 *
 * 用于编辑器插入/替换图片。
 * 通过 Rust 端 process_image 命令完成：
 *  - 格式校验（png/jpg/jpeg/gif/webp/bmp/svg）
 *  - 等比缩放（宽 ≤ 1200px）
 *  - JPEG 编码（质量 80%）
 *  - Base64 编码
 *
 * @returns `data:image/jpeg;base64,...` 格式字符串
 */
export async function processEditorImage(filePath: string): Promise<string> {
  return invoke<string>('process_image', {
    sourcePath: filePath,
    maxWidth: EDITOR_MAX_WIDTH,
    quality: EDITOR_QUALITY,
  })
}

/**
 * 处理封面图片：压缩 + 返回 Base64 data URL
 *
 * 封面使用更小的尺寸和更高的质量：
 *  - 等比缩放（宽 ≤ 800px）
 *  - JPEG 编码（质量 85%）
 */
export async function processCoverImage(filePath: string): Promise<string> {
  return invoke<string>('process_image', {
    sourcePath: filePath,
    maxWidth: COVER_MAX_WIDTH,
    quality: COVER_QUALITY,
  })
}

/**
 * 判断 coverImage 是否为可直接渲染的 URL
 *
 * 新方案下 cover_image 直接存 Base64 data URL，
 * 可以直接作为 <img src> 使用，无需额外转换。
 */
export function isRenderableSrc(src: string | undefined | null): src is string {
  return !!src && (src.startsWith('data:') || src.startsWith('http'))
}

/**
 * 兼容旧数据：如果封面仍是文件路径（非 data: URL），
 * 尝试通过 processCoverImage 转换。
 *
 * @deprecated 仅用于迁移旧数据，新数据直接存 Base64
 */
export async function resolveCoverSrc(path: string | undefined | null): Promise<string | undefined> {
  if (!path) return undefined
  if (isRenderableSrc(path)) return path

  // 旧数据：绝对文件路径 → 压缩 + Base64
  try {
    return await processCoverImage(path)
  } catch (e) {
    console.error('resolveCoverSrc 失败:', e)
    return undefined
  }
}
