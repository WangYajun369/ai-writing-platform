/**
 * ImageResizeNodeView — 可缩放图片节点视图
 *
 * 选中图片时显示浮动缩放工具栏，支持缩小/放大/重置/替换/删除/重新裁切。
 * 新图片以 asset:// URL 存储（后端独立文件资产），历史 data URL 走 Canvas fallback。
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
  InfoIcon,
} from 'lucide-react'
import { processEditorImage, canvasCropImage } from '@/lib/image-utils.ts'
import { imageApi } from '@/lib/tauri-bridge.ts'
import { toast } from '@/lib/toast'
import ImageCropperDialog from './ImageCropperDialog'
import ImageViewerDialog from './ImageViewerDialog'
import ImageMetaPanel from './ImageMetaPanel'
import type { ImageAssetMeta } from './ImageMetaPanel'

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

  // 查看大图弹窗
  const [viewerOpen, setViewerOpen] = useState(false)

  // 溯源面板状态
  const [metaOpen, setMetaOpen] = useState(false)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaData, setMetaData] = useState<ImageAssetMeta | null>(null)

  /** 打开溯源面板：从后端查资产元数据 */
  const openMetaPanel = useCallback(async () => {
    setMetaOpen(true)
    setMetaLoading(true)
    try {
      const src = node.attrs.src as string
      const meta = await imageApi.getMetaBySrc(src)
      setMetaData(meta)
    } catch (err) {
      console.warn('[Image·溯源] 查询失败:', err)
      setMetaData(null)
    } finally {
      setMetaLoading(false)
    }
  }, [node.attrs.src])

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

  /** 替换图片源：选新文件 → Rust 压缩存资产 → 更新 asset:// URL */
  const handleReplace = useCallback(async () => {
    try {
      const selectedPath = await open({
        title: '选择新图片',
        multiple: false,
        filters: [
          {
            name: '图片文件',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
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

  /** 确认重新裁切
   *
   * 两条路径：
   * 1. src 是 asset://（新方案）→ 从 URL 提取文件路径 → imageApi.processCropped
   *    Rust 端裁剪 → 存新资产 → 返回新 asset:// URL（像素级精确、无二次画质损失）
   * 2. src 是 data URL（旧方案历史遗留）→ Canvas 裁剪 + 压缩（暂不迁移，下次重传自动走新链路）
   */
  const handleReCropConfirm = useCallback(async (crop: { x: number; y: number; width: number; height: number }) => {
    try {
      const src = node.attrs.src as string

      if (src.startsWith('asset://') || src.startsWith('http://asset.localhost') || src.startsWith('https://asset.localhost')) {
        // 路径 1：从 asset:// URL 提取绝对文件路径 → Rust 端裁剪
        // 兼容 Tauri v2 多种 asset:// URL 输出格式：
        //  - asset://localhost/<path>（Tauri v2 macOS/Linux 标准输出，由 convertFileSrc 生成）
        //  - asset:////<path>（Tauri v1 四斜杠残留）
        //  - asset:///<path>（Tauri v1 三斜杠残留）
        let filePath: string
        if (src.startsWith('asset://localhost/')) {
          filePath = src.slice('asset://localhost/'.length)
        } else if (src.startsWith('http://asset.localhost/')) {
          filePath = src.slice('http://asset.localhost/'.length)
        } else if (src.startsWith('https://asset.localhost/')) {
          filePath = src.slice('https://asset.localhost/'.length)
        } else if (src.startsWith('asset:////')) {
          filePath = src.slice('asset:////'.length)
        } else if (src.startsWith('asset:///')) {
          filePath = src.slice('asset:///'.length)
        } else {
          // 兜底：去掉 asset:// 或 http(s):// 前缀及可能的 host 段，仅保留 path 部分
          const rest = src.startsWith('asset://')
            ? src.slice('asset://'.length)
            : src.replace(/^https?:\/\//, '')
          const slash = rest.indexOf('/')
          filePath = slash >= 0 ? rest.slice(slash + 1) : rest
        }
        filePath = decodeURIComponent(filePath)

        const newSrc = await imageApi.processCropped(
          filePath,
          crop.x, crop.y, crop.width, crop.height,
          1200, 80,
        )
        updateAttributes({ src: newSrc })
      } else if (src.startsWith('data:')) {
        // 路径 2：旧方案遗留 data URL → Canvas 裁剪
        // TODO(v1.21): 加 Rust data_url_to_file 命令，把旧图也迁移到资产存储
        const dataUrl = await canvasCropImage(src, crop, 1200, 80)
        updateAttributes({ src: dataUrl })
      } else {
        console.warn('重新裁切：不支持的 src 类型', src?.slice?.(0, 50))
      }
    } catch (err) {
      console.error('重新裁切失败:', err)
      toast.error(`重新裁切失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReCropOpen(false)
    }
  }, [node.attrs.src, updateAttributes])

  return (
    // data-drag-handle 使 ProseMirror 允许按住图片区域拖动调整文档内位置
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
            {/* 溯源信息 */}
            <button
              onClick={openMetaPanel}
              title="图片溯源信息"
              className="image-resize-btn"
            >
              <InfoIcon className="w-3.5 h-3.5" />
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

      {/* 溯源元数据弹窗 */}
      {metaOpen && (
        <ImageMetaPanel
          meta={metaData}
          loading={metaLoading}
          onClose={() => setMetaOpen(false)}
        />
      )}
    </NodeViewWrapper>
  )
}
