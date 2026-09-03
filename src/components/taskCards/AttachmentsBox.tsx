/**
 * 附件（任务卡 P2，PRD 12.4）
 *
 * 系统文件对话框添加（≤30MB）、系统默认应用打开、删除（记录+文件）。
 * 数据独立加载于 task-attachments 表。
 */
import { useEffect, useState } from 'react'
import { Eye, Loader2, Paperclip, Plus, Trash2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { taskCardApi } from '@/lib/tauri-bridge'
import type { Attachment } from '@/types'

interface Props {
  taskId: string
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function fmtTime(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (d.toDateString() === new Date().toDateString()) return `今天 ${hh}:${mm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic']
const VID = ['mp4', 'mov', 'avi', 'mkv', 'webm']
const AUD = ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg']
const DOC = ['doc', 'docx', 'txt', 'md', 'rtf', 'odt']
const SHEET = ['xls', 'xlsx', 'csv']
const ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz']

function tone(ext: string): string {
  if (IMG.includes(ext)) return 'bg-sky-500/15 text-sky-300'
  if (VID.includes(ext)) return 'bg-violet-500/15 text-violet-300'
  if (AUD.includes(ext)) return 'bg-emerald-500/15 text-emerald-300'
  if (ext === 'pdf') return 'bg-rose-500/15 text-rose-300'
  if (ARCHIVE.includes(ext)) return 'bg-amber-500/15 text-amber-300'
  if (DOC.includes(ext)) return 'bg-blue-500/15 text-blue-300'
  if (SHEET.includes(ext)) return 'bg-green-500/15 text-green-300'
  return 'bg-zinc-500/15 text-zinc-300'
}

export default function AttachmentsBox({ taskId }: Props) {
  const [items, setItems] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const reload = () => {
    setLoading(true)
    taskCardApi
      .listAttachments(taskId)
      .then((list) => setItems(list))
      .catch(() => toast.error('加载附件失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  const onAdd = () => {
    setBusy(true)
    taskCardApi
      .pickAndAddAttachment(taskId)
      .then((att) => {
        if (att) reload()
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false))
  }

  const onOpen = (id: string) => {
    taskCardApi.openAttachment(id).catch((e) => toast.error(String(e)))
  }

  const onDelete = (a: Attachment) => {
    if (!window.confirm(`删除附件「${a.fileName}」？文件将从磁盘移除，不可恢复。`)) return
    taskCardApi
      .deleteAttachment(a.id)
      .then(() => {
        toast.success('附件已删除')
        setItems((prev) => prev.filter((x) => x.id !== a.id))
      })
      .catch((e) => toast.error(String(e)))
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11.5px] font-medium text-zinc-500">
          <Paperclip className="h-3 w-3" />
          附件{items.length > 0 ? `（${items.length}）` : ''}
        </span>
        <button
          onClick={onAdd}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11.5px] text-zinc-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          添加
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-1 text-zinc-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-[11.5px] text-zinc-600">暂无附件，点击「添加」上传（单个不超过 30MB）</p>
      ) : (
        <ul className="space-y-1">
          {items.map((a) => (
            <li
              key={a.id}
              className="group flex items-center gap-2 rounded-md border border-white/5 bg-black/15 px-2 py-1.5"
            >
              <span
                className={`flex h-7 w-10 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold uppercase ${tone(a.fileType)}`}
              >
                {a.fileType ? `.${a.fileType}` : '文件'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] text-zinc-200" title={a.fileName}>
                  {a.fileName}
                </p>
                <p className="text-[10px] text-zinc-600">
                  {fmtSize(a.fileSize)} · {fmtTime(a.createdAt)}
                </p>
              </div>
              <button
                onClick={() => onOpen(a.id)}
                title="用系统应用打开"
                className="rounded p-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onDelete(a)}
                title="删除附件"
                className="rounded p-1 text-zinc-500 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
