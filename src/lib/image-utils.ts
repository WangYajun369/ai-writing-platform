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

/** 生成封面用的字体栈（CJK 友好，回退 sans-serif） */
const COVER_FONT = "'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"

/** 转义 SVG 文本中的特殊字符，避免破坏标签 */
function escapeSvgText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 将书名按字符切块换行（最多 maxLines 行，末行超长补省略号）。
 * 对 CJK 与拉丁混排均可用：以字为单位切断，避免行溢出封面。
 */
function wrapCoverTitle(title: string, maxPerLine: number, maxLines: number): string[] {
  const chars = Array.from(title)
  const raw: string[] = []
  for (let i = 0; i < chars.length; i += maxPerLine) {
    raw.push(chars.slice(i, i + maxPerLine).join(''))
  }
  if (raw.length === 0) return [title]
  if (raw.length <= maxLines) return raw
  const head = raw.slice(0, maxLines - 1)
  const tail = raw.slice(maxLines - 1).join('')
  const tailChars = Array.from(tail)
  head.push(tailChars.length > maxPerLine ? tailChars.slice(0, maxPerLine).join('') + '…' : tail)
  return head
}

/**
 * 确定性生成「无封面」作品的 SVG 封面，返回 data URL（`data:image/svg+xml;...`）。
 *
 * 用途：
 * - 新建作品未上传封面时，由前端生成并以 data URL 存入 coverImage（随备份/导出携带）。
 * - 任何封面为 null 的展示场景（书库卡片、编辑弹窗预览）回退到此图，保证永不空白。
 *
 * 设计：色相由 book.id 稳定派生（同书恒定），文本取自书名/作者并自动换行；
 * 一个 3:4 渐变底 + 半透明装饰圆/线 + 大号首字水印 + 底部书名/作者。
 *
 * 纯前端、离线、零依赖；输出为文本型 SVG data URL，内嵌自包含。
 *
 * @param seed.id    书籍 id（稳定性优先，缺省时回退到 title）
 * @param seed.title 书名（参与配色与文字）
 * @param seed.author 作者（可选，参与文字）
 */
export function generateBookCoverSvg(seed: {
  id?: string
  title: string
  author?: string
}): string {
  const title = (seed.title || '').trim() || '未命名作品'
  const author = (seed.author || '').trim()
  const key = seed.id || title

  // FNV-1a 哈希 → 色相（稳定且分布均匀）
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const n = h >>> 0
  const hue = n % 360
  const hue2 = (hue + 38) % 360
  const hue3 = (hue + 320) % 360

  const lines = wrapCoverTitle(title, 12, 3)
  const titleSize = lines.length >= 3 ? 26 : 30
  const lineH = titleSize + 6
  const blockBottom = 352
  const firstY = blockBottom - (lines.length - 1) * lineH
  const titleSpans = lines
    .map(
      (ln, i) =>
        `<text x="26" y="${firstY + i * lineH}" font-family="${COVER_FONT}" font-size="${titleSize}" font-weight="700" fill="rgba(255,255,255,0.96)">${escapeSvgText(ln)}</text>`,
    )
    .join('')

  const authorLine = author
    ? `<text x="26" y="${blockBottom + 30}" font-family="${COVER_FONT}" font-size="15" fill="rgba(255,255,255,0.78)">${escapeSvgText(author)}</text>`
    : ''

  const initial = escapeSvgText(title.charAt(0))

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},58%,46%)"/>
      <stop offset="1" stop-color="hsl(${hue2},52%,30%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="400" fill="url(#bg)"/>
  <circle cx="248" cy="64" r="96" fill="hsla(${hue3},80%,72%,0.20)"/>
  <circle cx="54" cy="338" r="130" fill="hsla(${hue2},70%,82%,0.14)"/>
  <g stroke="rgba(255,255,255,0.10)" stroke-width="1">
    <line x1="0" y1="120" x2="300" y2="60"/>
    <line x1="0" y1="170" x2="300" y2="110"/>
    <line x1="0" y1="220" x2="300" y2="160"/>
  </g>
  <text x="26" y="104" font-family="${COVER_FONT}" font-size="120" font-weight="800" fill="rgba(255,255,255,0.10)">${initial}</text>
  <rect x="0" y="300" width="300" height="100" fill="rgba(0,0,0,0.22)"/>
  ${titleSpans}
  ${authorLine}
</svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
