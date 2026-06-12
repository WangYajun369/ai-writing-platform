/**
 * ImageCropperDialog — 图片裁剪弹窗
 *
 * 使用 react-image-crop 提供交互式图片裁剪界面。
 * 支持两种图片来源：
 * - `filePath`：本地文件路径（新图片），通过 Tauri asset protocol 加载
 * - `imageSrc`：可直接渲染的 URL（Base64/data: URL 或 http URL），用于重新裁切已有图片
 *
 * 自由裁切模式下，拖拽裁剪框的边和角即可自由调整大小（原生支持）。
 * 缩放通过改变图片显示尺寸实现；旋转通过 Canvas 预旋转实现。
 *
 * 用户调整裁剪区域后确认，返回裁剪参数（原图自然像素坐标），
 * 由调用方负责实际的裁剪 + 压缩 + Base64 编码。
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import ReactCrop, {
  type Crop as ReactCropType,
  centerCrop,
  makeAspectCrop,
} from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
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

/** 缩放范围 */
const ZOOM_MIN = 1
const ZOOM_MAX = 3
const ZOOM_STEP = 0.3

/**
 * Canvas 预旋转图片（90° 递增）
 *
 * 将图片绘制到旋转后的 canvas 上，返回 PNG data URL。
 * 使用 PNG 避免多次 JPEG 编码导致画质损失。
 */
function rotateImage(src: string, degrees: 90 | 180 | 270): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('无法创建 Canvas')); return }

      if (degrees === 90 || degrees === 270) {
        canvas.width = img.naturalHeight
        canvas.height = img.naturalWidth
      } else {
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
      }

      ctx.translate(canvas.width / 2, canvas.height / 2)
      ctx.rotate((degrees * Math.PI) / 180)
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('旋转：加载图片失败'))
    img.src = src
  })
}

interface ImageCropperDialogProps {
  /** 源图片的本地文件绝对路径（与 imageSrc 二选一） */
  filePath?: string
  /** 可直接渲染的图片 URL（与 filePath 二选一） */
  imageSrc?: string
  /** 裁剪框宽高比，默认 4/3（编辑器图片），封面使用 3/4 */
  aspectRatio?: number
  /** 确认裁剪回调，返回裁剪区域像素参数（原图自然像素坐标） */
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
  /** 百分比制裁剪框状态（zoom 变化时自动保持正确位置） */
  const [crop, setCrop] = useState<ReactCropType>()
  /** 缩放倍率 */
  const [zoom, setZoom] = useState(ZOOM_MIN)
  /** 旋转角度（0, 90, 180, 270） */
  const [rotationDeg, setRotationDeg] = useState(0)
  /** Canvas 预旋转后的 data URL */
  const [rotatedSrc, setRotatedSrc] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [imageError, setImageError] = useState(false)

  /**
   * 当前选中的宽高比预设。
   *
   * - `null` = "自由"模式，裁剪框可自由拉伸
   * - 数字 = 锁定为该比例
   */
  const [activeAspect, setActiveAspect] = useState<number | null>(aspectRatio)

  /** <img> 元素 ref，用于坐标转换 */
  const imgRef = useRef<HTMLImageElement>(null)

  const isFreeMode = activeAspect === null

  /** 原始图片 URL（filePath → convertFileSrc，imageSrc → 直接使用） */
  const baseImageUrl = useMemo(() => {
    setImageError(false)
    if (imageSrc) return imageSrc
    if (filePath) return convertFileSrc(filePath.replace(/\\/g, '/'))
    return ''
  }, [filePath, imageSrc])

  /** 实际展示的图片源（可能经过旋转） */
  const displaySrc = rotatedSrc ?? baseImageUrl

  /** 原始图片 URL 变化时重置旋转状态 */
  useEffect(() => {
    setRotatedSrc(null)
    setRotationDeg(0)
  }, [baseImageUrl])

  /** 图片加载完成：初始化裁剪框 */
  const onImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { width, height } = e.currentTarget
    if (activeAspect) {
      setCrop(
        centerCrop(
          makeAspectCrop({ unit: '%', width: 90 }, activeAspect, width, height),
          width,
          height,
        ),
      )
    } else {
      setCrop({ unit: '%', x: 5, y: 5, width: 90, height: 90 })
    }
  }, [activeAspect])

  /** 旋转按钮点击 */
  const handleRotate = useCallback(async () => {
    const newDeg = ((rotationDeg + 90) % 360) as 0 | 90 | 180 | 270
    try {
      if (newDeg === 0) {
        setRotatedSrc(null)
      } else {
        const rotated = await rotateImage(rotatedSrc ?? baseImageUrl, newDeg)
        setRotatedSrc(rotated)
      }
      setRotationDeg(newDeg)
      // 旋转后重置裁剪框，等 onImageLoad 重新初始化
      setCrop(undefined)
    } catch (err) {
      console.error('旋转失败', err)
    }
  }, [rotationDeg, rotatedSrc, baseImageUrl])

  /** 宽高比切换 */
  const handleAspectChange = useCallback((value: number | null) => {
    setActiveAspect(value)
    // 重新初始化裁剪框
    if (imgRef.current) {
      const { width, height } = imgRef.current
      if (value) {
        setCrop(
          centerCrop(
            makeAspectCrop({ unit: '%', width: 90 }, value, width, height),
            width,
            height,
          ),
        )
      } else {
        setCrop({ unit: '%', x: 5, y: 5, width: 90, height: 90 })
      }
    }
  }, [])

  /** 裁剪框变化：始终存百分比 */
  const handleCropChange = useCallback((_: ReactCropType, percentCrop: ReactCropType) => {
    setCrop(percentCrop)
  }, [])

  /** 确认裁剪：百分比 → 原图自然像素坐标 */
  const handleConfirm = useCallback(() => {
    if (!crop || !imgRef.current || processing) return
    setProcessing(true)

    const img = imgRef.current
    const scaleX = img.naturalWidth / 100
    const scaleY = img.naturalHeight / 100

    onConfirm({
      x: Math.round(crop.x * scaleX),
      y: Math.round(crop.y * scaleY),
      width: Math.round(crop.width * scaleX),
      height: Math.round(crop.height * scaleY),
    })
  }, [crop, processing, onConfirm])

  if (!baseImageUrl) return null

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
          <div
            className="relative flex-1 min-h-0 bg-black/90 overflow-auto"
            style={{
              '--rc-border-color': 'rgba(255,255,255,0.7)',
              '--rc-drag-handle-size': '10px',
              '--rc-drag-handle-bg-colour': 'rgba(255,255,255,0.9)',
              '--rc-drag-handle-border-colour': 'rgba(0,0,0,0.3)',
              '--rc-hover-drag-handle-size': '14px',
            } as React.CSSProperties}
          >
            {!imageError ? (
              <ReactCrop
                crop={crop}
                onChange={handleCropChange}
                aspect={isFreeMode ? undefined : activeAspect ?? undefined}
                ruleOfThirds
                keepSelection
                minWidth={20}
                minHeight={20}
              >
                <img
                  ref={imgRef}
                  src={displaySrc}
                  onLoad={onImageLoad}
                  onError={() => setImageError(true)}
                  alt="裁切图片"
                  style={{ width: `${zoom * 100}%`, display: 'block' }}
                  className="max-w-none"
                  draggable={false}
                />
              </ReactCrop>
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
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
                title="缩小"
              >
                <MinusIcon className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30"
                title="放大"
              >
                <PlusIcon className="w-4 h-4" />
              </button>

              <span className="w-px h-5 bg-border mx-1" />

              <button
                onClick={handleRotate}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                title="旋转 90°"
              >
                <RotateCwIcon className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground w-8 text-center tabular-nums">
                {rotationDeg}°
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
                    onClick={() => handleAspectChange(preset.value === 0 ? null : preset.value)}
                    title={preset.label === '自由' ? '自由裁切（可自由拉伸）' : `宽高比 ${preset.label}`}
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
                disabled={processing || !crop}
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
