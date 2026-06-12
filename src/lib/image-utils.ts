/**
 * 图片工具模块
 *
 * 统一的图片处理入口：读取本地文件 → Rust 端压缩/缩放/Base64 编码 →
 * 返回 data: URL 内嵌到 HTML。确保导出/导入完全自包含。
 */
import { imageApi } from '@/lib/tauri-bridge'

/** 编辑器图片：最大宽度 1200px，JPEG 质量 80% */
const EDITOR_MAX_WIDTH = 1200
const EDITOR_QUALITY = 80

/** 封面图片：最大宽度 800px，JPEG 质量 85% */
const COVER_MAX_WIDTH = 800
const COVER_QUALITY = 85

/** 封面图片裁剪宽高比（3:4） */
export const COVER_ASPECT = 3 / 4

/** 裁剪区域参数 */
export interface CropArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 纯前端 Canvas 裁剪 Base64 图片（用于重新裁切已有图片）
 *
 * 当原始文件已不可用时，使用 Canvas API 在前端完成裁剪 + 压缩 + Base64 输出。
 *
 * @param base64Src 已有的 Base64 data URL
 * @param crop 裁剪区域（基于原始图片的像素坐标）
 * @param maxWidth 裁剪后的最大宽度（等比缩放）
 * @param quality JPEG 质量 1-100
 * @returns `data:image/jpeg;base64,...` 格式字符串
 */
export function canvasCropImage(
  base64Src: string,
  crop: CropArea,
  maxWidth: number,
  quality: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // 裁剪区域不能超出原图边界
      const sx = Math.max(0, Math.round(crop.x))
      const sy = Math.max(0, Math.round(crop.y))
      const sw = Math.min(Math.round(crop.width), img.naturalWidth - sx)
      const sh = Math.min(Math.round(crop.height), img.naturalHeight - sy)

      if (sw <= 0 || sh <= 0) {
        reject(new Error('裁剪区域无效'))
        return
      }

      // 计算输出尺寸（等比缩放）
      let outW = sw
      let outH = sh
      if (outW > maxWidth) {
        outH = Math.round(outH * maxWidth / outW)
        outW = maxWidth
      }

      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('无法创建 Canvas 2D 上下文'))
        return
      }

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)
      resolve(canvas.toDataURL('image/jpeg', quality / 100))
    }
    img.onerror = () => reject(new Error('加载图片失败'))
    img.src = base64Src
  })
}

/**
 * 处理编辑器图片：压缩 + 返回 Base64 data URL
 *
 * @returns `data:image/jpeg;base64,...` 格式字符串
 */
export async function processEditorImage(filePath: string): Promise<string> {
  return imageApi.process(filePath, EDITOR_MAX_WIDTH, EDITOR_QUALITY)
}

/**
 * 处理封面图片：压缩 + 返回 Base64 data URL
 */
export async function processCoverImage(filePath: string): Promise<string> {
  return imageApi.process(filePath, COVER_MAX_WIDTH, COVER_QUALITY)
}

/**
 * 裁剪编辑器图片：裁剪 → 压缩 → Base64 data URL
 *
 * @param filePath 源图片本地文件路径
 * @param crop 裁剪区域（像素坐标），由 ImageCropperDialog 提供
 * @returns `data:image/jpeg;base64,...` 格式字符串
 */
export async function processCroppedEditorImage(
  filePath: string,
  crop: CropArea,
): Promise<string> {
  return imageApi.processCropped(
    filePath,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    EDITOR_MAX_WIDTH,
    EDITOR_QUALITY,
  )
}

/**
 * 裁剪封面图片：裁剪 → 压缩 → Base64 data URL
 *
 * 封面专属参数：800px 宽，85% JPEG 质量。
 * 裁剪后在 Rust 端执行像素级裁剪 + Lanczos3 缩放 + JPEG 编码。
 *
 * @param filePath 源图片本地文件路径
 * @param crop 裁剪区域（像素坐标），由 ImageCropperDialog 提供
 * @returns `data:image/jpeg;base64,...` 格式字符串
 */
export async function processCroppedCoverImage(
  filePath: string,
  crop: CropArea,
): Promise<string> {
  return imageApi.processCropped(
    filePath,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    COVER_MAX_WIDTH,
    COVER_QUALITY,
  )
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
