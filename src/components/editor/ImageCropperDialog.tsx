/**
 * ImageCropperDialog — 图片裁剪弹窗
 *
 * 使用 react-easy-crop 提供交互式图片裁剪界面。
 * 支持两种图片来源：
 * - `filePath`：本地文件路径（新图片），通过 Tauri asset protocol 加载
 * - `imageSrc`：可直接渲染的 URL（Base64/data: URL 或 http URL），用于重新裁切已有图片
 *
 * 用户调整裁剪区域后确认，返回裁剪参数（像素坐标），
 * 由调用方负责实际的裁剪 + 压缩 + Base64 编码。
 */
import { useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Cropper, { type Area, type Point } from 'react-easy-crop'
import { convertFileSrc } from '@tauri-apps/api/core'
import { XIcon, RotateCwIcon, MinusIcon, PlusIcon, ImageOffIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CropArea } from '@/lib/image-utils.ts'

/** 预设宽高比 */
const ASPECT_RATIO_PRESETS = [
  { label: '自由', value: 0 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '2:1', value: 2 },
  { label: '1:2', value: 1 / 2 },
  { label: '21:9', value: 21 / 9 },
] as const

interface ImageCropperDialogProps {
  /** 源图片的本地文件绝对路径（与 imageSrc 二选一） */
  filePath?: string
  /** 可直接渲染的图片 URL（与 filePath 二选一） */
  imageSrc?: string
  /** 裁剪框宽高比，默认 4/3（编辑器图片），封面使用 3/4 */
  aspectRatio?: number
  /** 确认裁剪回调，返回裁剪区域像素参数 */
  onConfirm: (crop: CropArea) => void
  /** 取消回调 */
  onClose: () => void
}

export default function ImageCropperDialog({
  filePath,
  imageSrc,
  aspectRatio = 4 / 3,
  onConfirm,
  onClose,
}: ImageCropperDialogProps) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [processing, setProcessing] = useState(false)
  const [imageError, setImageError] = useState(false)

  /** 图片原始尺寸（onMediaLoaded 后可用） */
  const [mediaNaturalRatio, setMediaNaturalRatio] = useState<number>(1)

  /**
   * 当前选中的宽高比预设。
   *
   * - `null` = "自由"模式，使用图片原始比例（mediaNaturalRatio）
   * - 数字 = 锁定为该比例
   */
  const [activeAspect, setActiveAspect] = useState<number | null>(aspectRatio)

  /** 实际传给 Cropper 的宽高比 */
  const effectiveAspect = activeAspect ?? mediaNaturalRatio

  const imageUrl = useMemo(() => {
    setImageError(false)
    if (imageSrc) return imageSrc
    if (filePath) return convertFileSrc(filePath)
    return ''
  }, [filePath, imageSrc])

  const onCropComplete = useCallback((_: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  const handleConfirm = useCallback(async () => {
    if (!croppedAreaPixels || processing) return
    setProcessing(true)
    onConfirm({
      x: croppedAreaPixels.x,
      y: croppedAreaPixels.y,
      width: croppedAreaPixels.width,
      height: croppedAreaPixels.height,
    })
  }, [croppedAreaPixels, processing, onConfirm])

  if (!imageUrl) return null

  return createPortal(
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/60 z-[80]" onClick={onClose} />

      {/* 弹窗 */}
      <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
        <div className="bg-card border rounded-2xl shadow-2xl w-full max-w-3xl h-[80vh] flex flex-col overflow-hidden">
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
            <h2 className="text-base font-semibold">裁切图片</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          {/* 裁剪区域 */}
          <div className="relative flex-1 min-h-0 bg-black/90">
            {!imageError ? (
              <Cropper
                image={imageUrl}
                crop={crop}
                zoom={zoom}
                rotation={rotation}
                aspect={effectiveAspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onRotationChange={setRotation}
                onCropComplete={onCropComplete}
                onMediaLoaded={(size) => {
                  const { naturalWidth, naturalHeight } = size
                  if (naturalWidth > 0 && naturalHeight > 0) {
                    setMediaNaturalRatio(naturalWidth / naturalHeight)
                  }
                }}
                cropShape="rect"
                showGrid
                classes={{
                  containerClassName: '!bg-black/90',
                  mediaClassName: '',
                  cropAreaClassName: '!border-white !border-2',
                }}
                mediaProps={{ onError: () => setImageError(true) }}
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
                <ImageOffIcon className="w-10 h-10" />
                <p className="text-sm">图片加载失败</p>
              </div>
            )}
          </div>

          {/* 工具栏 */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t bg-muted/30 shrink-0">
            {/* 左侧：缩放 + 旋转 */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setZoom((z) => Math.max(1, z - 0.3))}
                disabled={zoom <= 1}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
                title="缩小"
              >
                <MinusIcon className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(3, z + 0.3))}
                disabled={zoom >= 3}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
                title="放大"
              >
                <PlusIcon className="w-4 h-4" />
              </button>

              <span className="w-px h-5 bg-border mx-1" />

              <button
                onClick={() => setRotation((r) => (r + 90) % 360)}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                title="旋转 90°"
              >
                <RotateCwIcon className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground w-8 text-center tabular-nums">
                {rotation}°
              </span>
            </div>

            {/* 中间：宽高比预设 */}
            <div className="flex items-center gap-0.5">
              <span className="text-[10px] text-muted-foreground mr-0.5 shrink-0">比例:</span>
              {ASPECT_RATIO_PRESETS.map((preset) => {
                const isActive = preset.value === 0
                  ? activeAspect === null
                  : activeAspect === preset.value
                return (
                  <button
                    key={preset.label}
                    onClick={() => setActiveAspect(preset.value === 0 ? null : preset.value)}
                    title={preset.label === '自由' ? '自由裁切（原始比例）' : `宽高比 ${preset.label}`}
                    className={cn(
                      'px-2 py-1 rounded text-[11px] font-medium transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>

            {/* 右侧：操作按钮 */}
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border text-sm hover:bg-muted transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirm}
                disabled={processing}
                className="px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {processing ? '处理中…' : '确认裁切'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
