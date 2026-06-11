/**
 * ImageResizeNodeView — 可缩放图片节点视图
 *
 * 选中图片时显示浮动缩放工具栏，支持缩小/放大/重置/替换/删除/重新裁切。
 * 图片以压缩后的 Base64 data URL 内嵌在 HTML 中。
 */
import { useCallback, useState, useRef, useEffect } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  ImageUpIcon,
  CropIcon,
  EyeIcon,
} from 'lucide-react'
import { processEditorImage, canvasCropImage } from '@/lib/image-utils.ts'
import ImageCropperDialog from './ImageCropperDialog'
import ImageViewerDialog from './ImageViewerDialog'

const MIN_WIDTH_PCT = 20
const MAX_WIDTH_PCT = 100
const STEP = 10

export default function ImageResizeNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
}: NodeViewProps) {
  const widthPct = parseFloat(node.attrs.width as string) || MAX_WIDTH_PCT

  // 重新裁切状态
  const [reCropOpen, setReCropOpen] = useState(false)

  // 图片查看状态
  const [viewerOpen, setViewerOpen] = useState(false)

  // 手动输入宽度
  const [editingWidth, setEditingWidth] = useState(false)
  const [widthInput, setWidthInput] = useState(`${widthPct}`)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingWidth && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingWidth])

  const changeSize = useCallback(
    (delta: number) => {
      const next = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, widthPct + delta))
      if (next !== widthPct) {
        updateAttributes({ width: `${next}%` })
      }
    },
    [widthPct, updateAttributes]
  )

  const resetSize = useCallback(() => {
    if (widthPct !== MAX_WIDTH_PCT) {
      updateAttributes({ width: `${MAX_WIDTH_PCT}%` })
    }
  }, [widthPct, updateAttributes])

  /** 提交手动输入的宽度 */
  const commitWidth = useCallback(() => {
    const val = parseInt(widthInput, 10)
    if (!isNaN(val)) {
      const clamped = Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, val))
      updateAttributes({ width: `${clamped}%` })
    }
    setEditingWidth(false)
  }, [widthInput, updateAttributes])

  /** 开始编辑宽度 */
  const startEditing = useCallback(() => {
    setWidthInput(`${widthPct}`)
    setEditingWidth(true)
  }, [widthPct])

  /** 替换图片源（压缩后以 Base64 内嵌） */
  const handleReplace = useCallback(async () => {
    try {
      const selectedPath = await open({
        title: '选择新图片',
        multiple: false,
        filters: [
          {
            name: '图片文件',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'],
          },
        ],
      })
      if (!selectedPath) return

      const filePath = selectedPath as string
      const dataUrl = await processEditorImage(filePath)
      updateAttributes({ src: dataUrl })
    } catch (err) {
      console.error('替换图片失败', err)
    }
  }, [updateAttributes])

  /** 删除图片节点 */
  const handleDelete = useCallback(() => {
    deleteNode()
  }, [deleteNode])

  /** 确认重新裁切（前端 Canvas 处理，因原始文件已不可用） */
  const handleReCropConfirm = useCallback(async (crop: { x: number; y: number; width: number; height: number }) => {
    try {
      const src = node.attrs.src as string
      // 前端 Canvas 裁剪 + 压缩 + Base64
      const dataUrl = await canvasCropImage(src, crop, 1200, 80)
      updateAttributes({ src: dataUrl })
    } catch (err) {
      console.error('重新裁切失败', err)
    } finally {
      setReCropOpen(false)
    }
  }, [node.attrs.src, updateAttributes])

  return (
    <NodeViewWrapper className="image-node-wrapper" data-drag-handle="">
      <div className="image-node-container" style={{ width: `${widthPct}%` }}>
        <img
          src={node.attrs.src}
          alt={node.attrs.alt ?? ''}
          title={node.attrs.title ?? ''}
          className="image-node-img"
          draggable={false}
        />
        {selected && (
          <div className="image-resize-toolbar">
            {/* 查看大图 */}
            <button
              onClick={() => setViewerOpen(true)}
              title="查看大图"
              className="image-resize-btn"
            >
              <EyeIcon className="w-3.5 h-3.5" />
            </button>
            <span className="image-toolbar-divider" />
            <button
              onClick={() => changeSize(-STEP)}
              disabled={widthPct <= MIN_WIDTH_PCT}
              title="缩小"
              className="image-resize-btn"
            >
              <MinusIcon className="w-3.5 h-3.5" />
            </button>
            <span className="image-resize-label">
              {editingWidth ? (
                <input
                  ref={inputRef}
                  type="number"
                  min={MIN_WIDTH_PCT}
                  max={MAX_WIDTH_PCT}
                  value={widthInput}
                  onChange={(e) => setWidthInput(e.target.value)}
                  onBlur={commitWidth}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitWidth()
                    if (e.key === 'Escape') setEditingWidth(false)
                  }}
                  className="w-12 h-5 px-1 text-center text-xs rounded border border-primary bg-background text-foreground outline-none"
                />
              ) : (
                <button
                  onClick={startEditing}
                  title="点击输入宽度 (20-100)"
                  className="text-xs font-medium tabular-nums hover:text-primary transition-colors cursor-text"
                >
                  {widthPct}%
                </button>
              )}
            </span>
            <button
              onClick={() => changeSize(STEP)}
              disabled={widthPct >= MAX_WIDTH_PCT}
              title="放大"
              className="image-resize-btn"
            >
              <PlusIcon className="w-3.5 h-3.5" />
            </button>
            {widthPct !== MAX_WIDTH_PCT && (
              <button onClick={resetSize} title="重置为 100%" className="image-resize-btn">
                <RotateCcwIcon className="w-3 h-3" />
              </button>
            )}
            {/* 分隔线 */}
            <span className="image-toolbar-divider" />
            {/* 替换图片 */}
            <button onClick={handleReplace} title="替换图片" className="image-resize-btn">
              <ImageUpIcon className="w-3.5 h-3.5" />
            </button>
            {/* 重新裁切 */}
            <button
              onClick={() => setReCropOpen(true)}
              title="重新裁切"
              className="image-resize-btn"
            >
              <CropIcon className="w-3.5 h-3.5" />
            </button>
            {/* 删除图片 */}
            <button onClick={handleDelete} title="删除图片" className="image-resize-btn image-resize-btn-danger">
              <Trash2Icon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 重新裁切弹窗 */}
      {reCropOpen && (
        <ImageCropperDialog
          imageSrc={node.attrs.src as string}
          onConfirm={handleReCropConfirm}
          onClose={() => setReCropOpen(false)}
        />
      )}

      {/* 查看大图弹窗 */}
      {viewerOpen && (
        <ImageViewerDialog
          imageSrc={node.attrs.src as string}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </NodeViewWrapper>
  )
}
