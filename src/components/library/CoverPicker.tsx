/**
 * CoverPicker — 封面图片选择 + 裁剪组件
 *
 * 文件选择 → 裁剪（3:4 比例）→ Rust 端裁剪+压缩+Base64 编码 →
 * 通过 onChange 返回 data URL。
 *
 * 与旧版不同，onChange 现在返回的是经过裁剪/压缩后的 Base64 data URL，
 * 而不是文件路径。父组件可直接通过 bookApi.setCoverData() 存入数据库。
 *
 * 限制：
 * - 格式：JPEG / PNG / WebP
 * - 大小：不超过 5 MB
 */
import { useState } from 'react'
import { ImageIcon, UploadIcon, XIcon, AlertTriangleIcon, LoaderIcon } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import { cn } from '@/lib/utils'
import ImageCropperDialog from '@/components/editor/ImageCropperDialog'
import { processCroppedCoverImage, isRenderableSrc, COVER_ASPECT } from '@/lib/image-utils'
import type { CropArea } from '@/lib/image-utils'

/** 允许的图片扩展名 */
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
/** 封面最大文件大小（字节） */
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export interface CoverPickerProps {
  /** 当前封面（data URL 或 undefined） */
  value?: string
  /** 选择/裁剪完成后回调，返回裁剪后的 Base64 data URL */
  onChange: (dataUrl: string) => void
  /** 组件类名 */
  className?: string
}

export default function CoverPicker({ value, onChange, className }: CoverPickerProps) {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [cropperFile, setCropperFile] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  async function handlePick() {
    setError(null)
    setLoading(true)
    try {
      const selected = await open({
        title: '选择封面图片',
        filters: [{ name: '图片文件', extensions: ALLOWED_EXTENSIONS }],
        multiple: false,
        directory: false,
      })

      if (!selected) return
      const filePath = selected as string

      // 校验扩展名
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

      // 打开裁剪弹窗
      setCropperFile(filePath)
    } catch (err) {
      console.error('选择封面失败', err)
      setError('选择封面失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  /** 裁剪确认：调用 Rust 后端处理裁剪 + 压缩 */
  async function handleCropConfirm(crop: CropArea) {
    const filePath = cropperFile!
    setCropperFile(null)
    setProcessing(true)
    setError(null)
    try {
      const dataUrl = await processCroppedCoverImage(filePath, crop)
      onChange(dataUrl)
    } catch (err) {
      console.error('裁剪封面失败', err)
      setError('裁剪封面失败，请重试')
    } finally {
      setProcessing(false)
    }
  }

  function handleCropClose() {
    setCropperFile(null)
  }

  async function handleRemove() {
    setError(null)
    onChange('')
  }

  // 判断是否为可渲染的 URL
  const previewSrc = value && isRenderableSrc(value) ? value : undefined

  return (
    <div className={cn('space-y-2', className)}>
      <div className="relative">
        {previewSrc ? (
          // 已有封面 — 显示预览
          <div className="relative group rounded-lg overflow-hidden border bg-muted">
            <img
              src={previewSrc}
              alt="封面预览"
              className="w-full aspect-[3/4] object-cover"
            />
            {/* 处理中遮罩 */}
            {processing && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <LoaderIcon className="w-6 h-6 text-white animate-spin" />
              </div>
            )}
            {/* 悬浮操作按钮 */}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={handlePick}
                disabled={loading || processing}
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
            disabled={loading || processing}
            className="w-full aspect-[3/4] rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/50 hover:bg-muted hover:border-primary/40 transition-all flex flex-col items-center justify-center gap-3 group"
          >
            <div className="p-3 rounded-full bg-primary/10 group-hover:bg-primary/20 transition-colors">
              <ImageIcon className="w-6 h-6 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-sm text-muted-foreground">
                {loading || processing ? '处理中…' : '点击选择封面图片'}
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                支持 JPG、PNG、WebP，不超过 5 MB，选择后可裁剪
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

      {/* 裁剪弹窗 */}
      {cropperFile && (
        <ImageCropperDialog
          filePath={cropperFile}
          aspectRatio={COVER_ASPECT}
          onConfirm={handleCropConfirm}
          onClose={handleCropClose}
        />
      )}
    </div>
  )
}
