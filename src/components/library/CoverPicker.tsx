/**
 * CoverPicker — 封面图片选择组件
 *
 * 使用 Tauri dialog 插件打开系统文件选择器，校验图片格式和大小。
 * 通过 convertFileSrc 将本地路径转为可渲染的 asset URL。
 *
 * 限制：
 * - 格式：JPEG / PNG / WebP
 * - 大小：不超过 5 MB
 */
import { useState } from 'react'
import { ImageIcon, UploadIcon, XIcon, AlertTriangleIcon } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { stat, readFile } from '@tauri-apps/plugin-fs'
import { cn } from '@/lib/utils'

/** 允许的图片扩展名 */
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
/** 封面最大文件大小（字节） */
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export interface CoverPickerProps {
  /** 当前封面路径（asset URL 或空） */
  value?: string
  /** 选择后的回调，返回本地文件绝对路径 */
  onChange: (filePath: string) => void
  /** 组件类名 */
  className?: string
}

export default function CoverPicker({ value, onChange, className }: CoverPickerProps) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handlePick() {
    setError(null)
    setLoading(true)
    try {
      const selected = await open({
        title: '选择封面图片',
        filters: [
          {
            name: '图片文件',
            extensions: ALLOWED_EXTENSIONS,
          },
        ],
        multiple: false,
        directory: false,
      })

      if (!selected) {
        // 用户取消选择
        return
      }

      const filePath = selected as string

      // 校验扩展名（二次确认）
      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setError(`不支持的图片格式 .${ext}，仅支持 jpg、png、webp`)
        return
      }

      // 校验文件大小
      const fileStat = await stat(filePath)
      if (fileStat.size > MAX_SIZE_BYTES) {
        const sizeMB = (fileStat.size / (1024 * 1024)).toFixed(1)
        setError(`图片过大（${sizeMB} MB），封面不能超过 5 MB`)
        return
      }

      onChange(filePath)
    } catch (err) {
      console.error('选择封面失败', err)
      setError('选择封面失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  async function handleRemove() {
    setError(null)
    onChange('')
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* 封面预览/选择区域 */}
      <div className="relative">
        {value ? (
          // 已有封面 — 显示预览
          <div className="relative group rounded-lg overflow-hidden border bg-muted">
            <img
              src={value}
              alt="封面预览"
              className="w-full aspect-[3/4] object-cover"
            />
            {/* 悬浮操作按钮 */}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={handlePick}
                disabled={loading}
                className="px-3 py-1.5 bg-white/90 text-foreground rounded-md text-xs font-medium hover:bg-white transition-colors flex items-center gap-1.5"
              >
                <UploadIcon className="w-3.5 h-3.5" />
                更换
              </button>
              <button
                type="button"
                onClick={handleRemove}
                className="px-3 py-1.5 bg-destructive/80 text-white rounded-md text-xs font-medium hover:bg-destructive transition-colors flex items-center gap-1.5"
              >
                <XIcon className="w-3.5 h-3.5" />
                移除
              </button>
            </div>
          </div>
        ) : (
          // 无封面 — 显示上传区域
          <button
            type="button"
            onClick={handlePick}
            disabled={loading}
            className="w-full aspect-[3/4] rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/50 hover:bg-muted hover:border-primary/40 transition-all flex flex-col items-center justify-center gap-3 group"
          >
            <div className="p-3 rounded-full bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <ImageIcon className="w-6 h-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                {loading ? '打开文件选择器…' : '点击选择封面图片'}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                支持 JPG、PNG、WebP，不超过 5 MB
              </p>
            </div>
          </button>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangleIcon className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 将本地文件路径读取为可渲染的 URL
 *
 * 使用 readFile + data: URL（base64）方式，与编辑器内嵌图片保持一致。
 * data: URL 是纯字符串，不受协议/CSP/WebView2 跨域限制，在所有平台均可可靠渲染。
 *
 * 注意：返回的 data URL 不需要手动释放。
 */
export async function resolveCoverSrc(path: string | undefined | null): Promise<string | undefined> {
  if (!path) return undefined
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:') || path.startsWith('blob:')) {
    return path
  }
  if (path.startsWith('asset://') || path.startsWith('https://asset.')) {
    return path
  }

  try {
    const data = await readFile(path)
    const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeType = ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : 'image/png'
    // 使用 Blob + FileReader 生成 data: URL（base64），
    // 与编辑器图片插入方案一致，避免跨平台协议兼容性问题
    const blob = new Blob([data as BlobPart], { type: mimeType })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    return dataUrl
  } catch (e) {
    console.error('加载封面图片失败:', (e as Error).message)
    return undefined
  }
}
