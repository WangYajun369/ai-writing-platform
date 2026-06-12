/**
 * ImageViewerDialog — 图片查看弹窗
 *
 * 提供全屏/弹窗图片查看，支持缩放、拖拽平移、旋转。
 * 支持两种图片来源：
 * - `filePath`：本地文件路径，通过 Tauri asset protocol 加载
 * - `imageSrc`：可直接渲染的 URL（Base64/data: URL 或 http URL）
 */
import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { XIcon, ZoomInIcon, ZoomOutIcon, RotateCwIcon, MaximizeIcon, ImageOffIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const MIN_SCALE = 0.1
const MAX_SCALE = 5
const ZOOM_STEP = 0.25
const WHEEL_STEP = 0.01

interface ImageViewerDialogProps {
  /** 源图片的本地文件绝对路径（与 imageSrc 二选一） */
  filePath?: string
  /** 可直接渲染的图片 URL（与 filePath 二选一） */
  imageSrc?: string
  /** 关闭回调 */
  onClose: () => void
}

export default function ImageViewerDialog({
  filePath,
  imageSrc,
  onClose,
}: ImageViewerDialogProps) {
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [imageError, setImageError] = useState(false)

  // 平移量用 ref 跟踪（避免拖拽时高频 React 渲染导致抖动）
  const panRef = useRef({ x: 0, y: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)

  // 拖拽状态
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  const imageUrl = useMemo(() => {
    setImageError(false)
    if (imageSrc) return imageSrc
    if (filePath) return convertFileSrc(filePath.replace(/\\/g, '/'))
    return ''
  }, [filePath, imageSrc])

  /** 重置所有变换 */
  const reset = useCallback(() => {
    panRef.current = { x: 0, y: 0 }
    setScale(1)
    setRotation(0)
    if (wrapperRef.current) {
      wrapperRef.current.style.transform = 'translate(0px, 0px) scale(1) rotate(0deg)'
    }
  }, [])

  /** 缩放步进 */
  const zoomIn = useCallback(() => setScale((s) => Math.min(MAX_SCALE, s + ZOOM_STEP)), [])
  const zoomOut = useCallback(() => {
    setScale((s) => {
      const next = Math.max(MIN_SCALE, s - ZOOM_STEP)
      if (next <= 1) {
        panRef.current = { x: 0, y: 0 }
      }
      return next
    })
  }, [])

  /** 滚轮缩放 */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setScale((prev) => {
      const delta = e.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev + delta))
      if (next <= 1) {
        panRef.current = { x: 0, y: 0 }
      }
      return next
    })
  }, [])

  /** 鼠标拖拽开始 */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { x: panRef.current.x, y: panRef.current.y }
  }, [])

  /** 鼠标拖拽移动——直接操作 DOM 避免 React 渲染抖动 */
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging || !wrapperRef.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    panRef.current = {
      x: panStart.current.x + dx,
      y: panStart.current.y + dy,
    }
    wrapperRef.current.style.transform =
      `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${scale}) rotate(${rotation}deg)`
  }, [dragging, scale, rotation])

  /** 鼠标拖拽结束 */
  const handleMouseUp = useCallback(() => {
    setDragging(false)
  }, [])

  /** 旋转 90° */
  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [])

  /** 当 scale/rotation 通过按钮改变时，同步到 DOM（拖拽期间 handleMouseMove 已直接操作 DOM） */
  useEffect(() => {
    if (!wrapperRef.current) return
    const { x, y } = panRef.current
    wrapperRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`
  }, [scale, rotation])

  /** 键盘快捷键 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case '+':
        case '=':
          zoomIn()
          break
        case '-':
          zoomOut()
          break
        case '0':
          reset()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, zoomIn, zoomOut, reset])

  if (!imageUrl) return null

  return createPortal(
    <>
      {/* 全屏遮罩 */}
      <div className="fixed inset-0 bg-black/85 z-[200]" onClick={onClose} />

      {/* 内容区 */}
      <div
        className="fixed inset-0 z-[210] flex flex-col"
        onWheel={handleWheel}
      >
        {/* 顶部工具栏 */}
        <div className="flex items-center justify-between px-4 py-3 bg-black/70 backdrop-blur-sm shrink-0 pointer-events-auto">
          <div className="flex items-center gap-2">
            <span className="text-white/70 text-xs tabular-nums w-14 text-center">
              {Math.round(scale * 100)}%
            </span>
            <span className="w-px h-5 bg-white/20" />
            <button
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              className="p-2 rounded-lg text-white/80 hover:bg-white/10 transition-colors disabled:opacity-30"
              title="缩小 (-)"
            >
              <ZoomOutIcon className="w-5 h-5" />
            </button>
            <button
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              className="p-2 rounded-lg text-white/80 hover:bg-white/10 transition-colors disabled:opacity-30"
              title="放大 (+)"
            >
              <ZoomInIcon className="w-5 h-5" />
            </button>
            <span className="w-px h-5 bg-white/20" />
            <button
              onClick={rotate}
              className="p-2 rounded-lg text-white/80 hover:bg-white/10 transition-colors"
              title="旋转 90°"
            >
              <RotateCwIcon className="w-5 h-5" />
            </button>
            <button
              onClick={reset}
              className="p-2 rounded-lg text-white/80 hover:bg-white/10 transition-colors"
              title="重置 (0)"
            >
              <MaximizeIcon className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-white/50 text-[11px]">
              滚轮缩放 · 拖拽平移 · Esc 关闭
            </span>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-white/80 hover:bg-white/10 transition-colors"
              title="关闭 (Esc)"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 图片区域 */}
        <div
          className={cn(
            'flex-1 min-h-0 overflow-hidden flex items-center justify-center',
            scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
          )}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {imageError ? (
            <div className="flex flex-col items-center gap-3 text-white/50">
              <ImageOffIcon className="w-12 h-12" />
              <p className="text-sm">图片加载失败</p>
            </div>
          ) : (
            <div
              ref={wrapperRef}
              className="select-none"
              style={{
                transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${scale}) rotate(${rotation}deg)`,
                maxWidth: scale <= 1 ? '90vw' : undefined,
                maxHeight: scale <= 1 ? '90vh' : undefined,
                willChange: scale > 1 ? 'transform' : 'auto',
              }}
            >
              <img
                src={imageUrl}
                alt="原图查看"
                className="block max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                draggable={false}
                onError={() => setImageError(true)}
              />
            </div>
          )}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center justify-center py-2 bg-black/60 backdrop-blur-sm shrink-0 pointer-events-auto">
          <p className="text-white/40 text-[11px]">
            {rotation > 0 && `旋转 ${rotation}° · `}
            Esc 关闭 · 滚轮缩放 · 鼠标拖拽 · +/- 缩放 · 0 重置
          </p>
        </div>
      </div>
    </>,
    document.body,
  )
}
