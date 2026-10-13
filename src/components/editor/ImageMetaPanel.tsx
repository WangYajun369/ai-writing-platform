/**
 * ImageMetaPanel — 图片溯源元数据弹窗
 *
 * 展示 image_assets 表记录的完整溯源信息：
 *   - 原始信息（文件名、尺寸、格式、大小）
 *   - 存储信息（压缩后尺寸、文件路径）
 *   - 来源标记（upload / crop / cover / migrate）
 *   - 上传时间、内容哈希（sha256 去重）
 *
 * 仅 asset:// 格式图片有数据；data URL（历史遗留）会显示「无溯源记录」。
 */
import { XIcon } from 'lucide-react'

export interface ImageAssetMeta {
  id: string
  sha256: string
  originalName: string
  originalSize: number
  originalWidth: number
  originalHeight: number
  originalFormat: string
  storedPath: string
  storedWidth: number
  storedHeight: number
  storedFormat: string
  source: string
  sourceUrl: string
  createdAt: string
}

interface Props {
  meta: ImageAssetMeta | null
  loading?: boolean
  error?: string | null
  onClose: () => void
}

const SOURCE_LABELS: Record<string, string> = {
  upload: '用户上传',
  crop: '编辑器裁切',
  cover: '书籍封面',
  migrate: '历史迁移',
  url: '网络图片',
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function shaShort(sha: string): string {
  if (sha.length <= 16) return sha
  return `${sha.slice(0, 8)}…${sha.slice(-8)}`
}

export default function ImageMetaPanel({ meta, loading, error, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
         onClick={onClose}>
      <div
        className="w-[440px] max-h-[80vh] overflow-auto rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <span className="text-base">🔍</span>
            图片溯源
          </h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-4">
          {loading && (
            <div className="text-center py-8 text-muted-foreground text-sm">加载中…</div>
          )}

          {error && !loading && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && !meta && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-center">
              <div className="text-2xl mb-2">📭</div>
              <p className="text-sm text-muted-foreground">
                这是一张历史遗留的内嵌图片（data URL）
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                暂无溯源记录 — 可在编辑器打开时自动迁移为独立资产
              </p>
            </div>
          )}

          {meta && (
            <>
              {/* 来源 + 时间 */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                  {SOURCE_LABELS[meta.source] ?? meta.source}
                </span>
                <span className="text-xs text-muted-foreground">{meta.createdAt}</span>
              </div>

              {/* 原始信息 */}
              <section>
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  原始文件
                </h4>
                <dl className="space-y-1.5 text-xs">
                  <Row label="文件名" value={meta.originalName || '—'} mono />
                  <Row label="尺寸" value={meta.originalWidth > 0 ? `${meta.originalWidth} × ${meta.originalHeight} px` : '—'} />
                  <Row label="格式" value={meta.originalFormat || '—'} />
                  <Row label="大小" value={formatSize(meta.originalSize)} />
                </dl>
              </section>

              {/* 存储信息 */}
              <section>
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  存储（压缩后）
                </h4>
                <dl className="space-y-1.5 text-xs">
                  <Row label="格式" value={meta.storedFormat.toUpperCase()} />
                  <Row label="尺寸" value={`${meta.storedWidth} × ${meta.storedHeight} px`} />
                  <Row label="路径" value={meta.storedPath} mono />
                </dl>
              </section>

              {/* 溯源标记 */}
              <section>
                <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                  溯源标记
                </h4>
                <dl className="space-y-1.5 text-xs">
                  <Row
                    label="SHA-256"
                    value={shaShort(meta.sha256)}
                    mono
                    title={meta.sha256}
                  />
                  {meta.sourceUrl && (
                    <Row label="来源" value={meta.sourceUrl} mono />
                  )}
                </dl>
              </section>

              {/* 压缩比 */}
              {meta.originalSize > 0 && (
                <section>
                  <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    压缩效果
                  </h4>
                  {(() => {
                    // stored_size 不在 meta 里，但 stored_path 指向的文件可以估算
                    // 我们用 width 比估：sqrt(stored_w * stored_h / orig_w * orig_h)
                    const areaRatio = (meta.storedWidth * meta.storedHeight) /
                                      Math.max(1, meta.originalWidth * meta.originalHeight)
                    const areaPct = (areaRatio * 100).toFixed(1)
                    return (
                      <p className="text-xs text-muted-foreground">
                        像素体积 ≈ 原始的 <span className="font-medium text-foreground">{areaPct}%</span>
                      </p>
                    )
                  })()}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  title,
}: {
  label: string
  value: string
  mono?: boolean
  title?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground shrink-0 w-16">{label}</dt>
      <dd
        className={`text-right text-foreground break-all ${mono ? 'font-mono' : ''}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  )
}
