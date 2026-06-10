/**
 * ImageResizeNodeView — 可缩放图片节点视图
 *
 * 选中图片时显示浮动缩放工具栏，支持缩小/放大/重置/替换/删除。
 * 图片以压缩后的 Base64 data URL 内嵌在 HTML 中。
 */
import { useCallback } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { open } from '@tauri-apps/plugin-dialog'
import {
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  ImageUpIcon,
} from 'lucide-react'
import { processEditorImage } from '@/lib/image-utils.ts'

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
            <button
              onClick={() => changeSize(-STEP)}
              disabled={widthPct <= MIN_WIDTH_PCT}
              title="缩小"
              className="image-resize-btn"
            >
              <MinusIcon className="w-3.5 h-3.5" />
            </button>
            <span className="image-resize-label">{widthPct}%</span>
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
            {/* 删除图片 */}
            <button onClick={handleDelete} title="删除图片" className="image-resize-btn image-resize-btn-danger">
              <Trash2Icon className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  )
}
