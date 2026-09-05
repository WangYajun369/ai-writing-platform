/**
 * ImportPreviewDialog — 导入预览对话框（Spec §12.1）
 *
 * 读取 inspect_backup 报告展示：
 * ① 文件概况（类型 / 大小 / 行数）
 * ② 幂等提示（duplicateOf：曾于何时导入）
 * ③ 引用/指纹校验问题（ok=false 时禁止导入）
 * ④ 目标库对账清单（matched / missing / targetStale / targetNewer）
 * ⑤ 导入策略单选（merge 默认 / fill-gaps / replace 覆盖）
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { XIcon, AlertTriangleIcon, HistoryIcon, FileArchiveIcon } from 'lucide-react'
import type { BackupInspectReport, ImportStrategy, RowReconcile } from '@/lib/tauri-bridge'

interface ImportPreviewDialogProps {
  report: BackupInspectReport
  onCancel: () => void
  onConfirm: (strategy: ImportStrategy) => void
}

const TABLE_ROWS: { key: keyof BackupInspectReport['counts']; label: string; reconcileKey: keyof Omit<BackupInspectReport['reconcile'], 'worldCards'> | 'worldCards' }[] = [
  { key: 'chapters', label: '章节', reconcileKey: 'chapters' },
  { key: 'books', label: '书籍', reconcileKey: 'books' },
  { key: 'volumes', label: '卷', reconcileKey: 'volumes' },
  { key: 'snapshots', label: '快照', reconcileKey: 'snapshots' },
  { key: 'worldCards', label: '世界卡', reconcileKey: 'worldCards' },
]

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

function reconcileTotal(r: RowReconcile): number {
  return r.matched + r.targetStale + r.targetNewer + r.missing
}

export default function ImportPreviewDialog({
  report,
  onCancel,
  onConfirm,
}: ImportPreviewDialogProps) {
  const [strategy, setStrategy] = useState<ImportStrategy>('merge')

  const rowsTotal = TABLE_ROWS.reduce((sum, t) => sum + report.counts[t.key], 0)
  const rec = report.reconcile
  const rc = [
    { label: '书籍', r: rec.books },
    { label: '卷', r: rec.volumes },
    { label: '章节', r: rec.chapters },
    { label: '快照', r: rec.snapshots },
    { label: '世界卡', r: rec.worldCards },
  ]
  const totalMatched = rc.reduce((s, x) => s + x.r.matched, 0)
  const totalMissing = rc.reduce((s, x) => s + x.r.missing, 0)
  const totalStale = rc.reduce((s, x) => s + x.r.targetStale, 0)
  const totalNewer = rc.reduce((s, x) => s + x.r.targetNewer, 0)
  const allMatched = rowsTotal > 0 && totalMatched === rowsTotal

  const typeLabel =
    report.backupType === 'single' && report.singleBook
      ? `单作品备份 ·《${report.singleBook.title}》`
      : '全量备份'

  const strategies: { value: ImportStrategy; title: string; desc: string; warn?: boolean }[] = [
    {
      value: 'merge',
      title: '智能合并（推荐）',
      desc: '逐行择优：备份中更新的内容会覆盖，目标库新增内容完整保留，最安全。',
    },
    {
      value: 'fill-gaps',
      title: '仅补齐缺失',
      desc: '只导入目标库中没有的行，不修改任何已有内容。',
    },
    {
      value: 'replace',
      title: '覆盖式导入',
      desc: '清空受影响范围后按备份重建；目标库该范围内的新增内容会被删除（24 小时内可回退撤销）。',
      warn: true,
    },
  ]

  return createPortal(
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/50 z-60" onClick={onCancel} />

      {/* 弹窗 */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-70 w-full max-w-2xl bg-card border rounded-2xl shadow-xl p-6 max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileArchiveIcon className="w-5 h-5" />
            导入预览
          </h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-muted">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* ① 文件概况 */}
        <div className="rounded-xl border bg-muted/40 px-4 py-3 mb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium">{report.fileName}</span>
            <span className="text-muted-foreground">{typeLabel}</span>
            <span className="text-muted-foreground">{fmtBytes(report.fileSizeBytes)}</span>
            <span className="text-muted-foreground">备份内容 {rowsTotal} 行</span>
            {report.payloadHash && (
              <span className="text-muted-foreground text-xs truncate max-w-[180px]" title={report.payloadHash}>
                payloadHash {report.payloadHash.slice(0, 10)}…
              </span>
            )}
          </div>
        </div>

        {/* ② 幂等提示 */}
        {report.duplicateOf && (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 mb-4 flex gap-2 text-sm">
            <HistoryIcon className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
            <div>
              <span className="font-medium text-amber-800 dark:text-amber-300">该文件此前已导入过</span>
              <span className="text-amber-700 dark:text-amber-300/80">
                （{fmtTime(report.duplicateOf.importedAt)}，来源文件：{report.duplicateOf.fileName}）。若期间未改动，
                无需重复导入。
              </span>
            </div>
          </div>
        )}

        {/* ③ 校验问题（阻断） */}
        {!report.ok && (
          <div className="rounded-xl border border-red-300/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 mb-4 flex gap-2 text-sm">
            <AlertTriangleIcon className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            <div>
              <div className="font-medium text-red-800 dark:text-red-300">
                文件校验未通过，无法导入：
              </div>
              <ul className="list-disc pl-5 mt-1 space-y-0.5 text-red-700 dark:text-red-300/80">
                {report.issues.slice(0, 5).map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
                {report.issues.length > 5 && <li>…等共 {report.issues.length} 项</li>}
              </ul>
            </div>
          </div>
        )}

        {/* ④ 对账清单 */}
        <div className="mb-4">
          <div className="text-sm font-medium mb-2">
            与当前书库对账
            {allMatched && (
              <span className="ml-2 text-emerald-600 text-xs font-normal">
                内容完全一致，无需导入
              </span>
            )}
          </div>
          <div className="rounded-xl border divide-y divide-border overflow-hidden">
            {TABLE_ROWS.map((t) => {
              const r = rec[t.reconcileKey] as RowReconcile
              const total = reconcileTotal(r)
              const count = report.counts[t.key]
              if (total === 0 && count === 0) return null
              return (
                <div key={t.key} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted-foreground w-16 shrink-0">{t.label}</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span className="text-emerald-600">
                      一致 <b>{r.matched}</b>
                    </span>
                    <span className="text-red-600">
                      缺失 <b>{r.missing}</b>
                    </span>
                    <span className="text-amber-600">
                      备份更新 <b>{r.targetStale}</b>
                    </span>
                    <span className="text-sky-600">
                      目标更新 <b>{r.targetNewer}</b>
                    </span>
                    {total === 0 && <span className="text-muted-foreground">备份无此行（{count}）</span>}
                  </div>
                </div>
              )
            })}
            {totalMissing === 0 && totalStale === 0 && totalNewer === 0 && totalMatched === 0 && (
              <div className="px-4 py-2 text-sm text-muted-foreground">
                备份文件中无可对账内容
              </div>
            )}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            「缺失」指备份有而目标库没有；「备份更新/目标更新」按内容时间戳与指纹判定，智能合并会自动保留较新的那一侧。
          </div>
        </div>

        {/* ⑤ 策略单选 */}
        <div className="mb-5">
          <div className="text-sm font-medium mb-2">导入方式</div>
          <div className="space-y-2">
            {strategies.map((s) => (
              <label
                key={s.value}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                  strategy === s.value
                    ? s.warn
                      ? 'border-red-400 bg-red-50/60 dark:bg-red-950/30'
                      : 'border-primary bg-primary/5'
                    : 'hover:bg-muted'
                }`}
              >
                <input
                  type="radio"
                  name="import-strategy"
                  checked={strategy === s.value}
                  onChange={() => setStrategy(s.value)}
                  className="mt-1"
                />
                <span>
                  <span className={`text-sm font-medium block ${s.warn ? 'text-red-700 dark:text-red-300' : ''}`}>
                    {s.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{s.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* 汇总脚注 */}
        {(totalMissing > 0 || totalStale > 0) && (
          <div className="text-xs text-muted-foreground mb-4 -mt-2">
            {totalMissing > 0 && `将补齐缺失 ${totalMissing} 行`}
            {totalStale > 0 && (totalMissing > 0 ? '；' : '') + `覆盖过时内容 ${totalStale} 行`}
            {totalNewer > 0 && `；目标库较新内容 ${totalNewer} 行将被保留`}
            。向量索引将按本机 AI 自动重建。
          </div>
        )}

        {/* 操作 */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border text-sm hover:bg-muted transition-colors"
          >
            {allMatched ? '取消（无需导入）' : '取消'}
          </button>
          <button
            type="button"
            disabled={!report.ok}
            onClick={() => onConfirm(strategy)}
            className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            开始导入
          </button>
        </div>
      </div>
    </>,
    document.body,
  )
}
