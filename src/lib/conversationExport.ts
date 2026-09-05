/**
 * AI 对话导出工具（Phase 4 问题 25）
 *
 * 支持将当前书籍的 AI 对话记录导出为 Markdown / JSON 文件：
 * - Markdown：人读友好，含思考过程、token 用量摘要
 * - JSON：机器可读，保留字段结构（含滑动窗口摘要、请求载荷之外的完整消息）
 *
 * 落盘方式：plugin-dialog 的 save 对话框 + plugin-fs 的 writeTextFile
 * （Tauri v2 中 dialog 选择的路径会自动加入 fs 运行权限）。
 */
import { errText } from '@/lib/errors'
import { save, message } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import type { AiMessage, ConversationSummary } from '@/types'

export type AiExportFormat = 'markdown' | 'json'

interface ExportOptions {
  bookId: string
  bookTitle: string
  messages: AiMessage[]
  summary?: ConversationSummary | null | undefined
  format: AiExportFormat
}

/** 汇总 token 用量（仅统计已完成回复） */
function totalUsage(messages: AiMessage[]): {
  inputTokens: number
  outputTokens: number
} {
  let inputTokens = 0
  let outputTokens = 0
  for (const m of messages) {
    if (m.role === 'assistant' && m.usage) {
      inputTokens += m.usage.inputTokens ?? 0
      outputTokens += m.usage.outputTokens ?? 0
    }
  }
  return { inputTokens, outputTokens }
}

/** 单条消息 → Markdown 段 */
function messageToMarkdown(msg: AiMessage, index: number): string {
  const roleLabel = msg.role === 'user' ? '👤 用户' : '🤖 助手'
  const lines: string[] = []
  lines.push(`### ${roleLabel} #${index}`)
  if (msg.role === 'assistant') {
    const meta: string[] = []
    if (msg.thinking && msg.phase !== 'retrying') meta.push('含深度思考')
    if (msg.usage) {
      meta.push(
        `Token ${msg.usage.inputTokens ?? 0}↑ / ${msg.usage.outputTokens ?? 0}↓`,
      )
    }
    if (meta.length) lines.push(`> ${meta.join(' · ')}`)
  }
  lines.push('')
  if (msg.role === 'assistant' && msg.thinking && msg.thinking.trim()) {
    lines.push('<details>')
    lines.push(`<summary>💭 深度思考（${msg.thinking.length} 字）</summary>`)
    lines.push('')
    lines.push(msg.thinking.trim())
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }
  const content = (msg.content ?? '').trim() || '（空回复）'
  lines.push(content)
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

/** 生成 Markdown 对话记录 */
export function conversationToMarkdown(
  bookTitle: string,
  messages: AiMessage[],
  summary: ConversationSummary | null,
): string {
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const { inputTokens, outputTokens } = totalUsage(messages)
  const lines: string[] = []
  lines.push(`# AI 对话记录 —《${bookTitle}》`)
  lines.push('')
  lines.push(`- 导出时间：${exportedAt}`)
  lines.push(`- 消息条数：${messages.length}`)
  lines.push(`- Token 用量：${inputTokens} ↑ / ${outputTokens} ↓`)
  if (summary?.summary) {
    lines.push(`- 历史摘要：${summary.summary.length} 字（早于 #${messages.length} 的更早内容）`)
  }
  lines.push('')
  if (summary?.summary) {
    lines.push('## 📎 早前对话摘要')
    lines.push('')
    lines.push(summary.summary.trim())
    lines.push('')
    lines.push('---')
    lines.push('')
  }
  const visible = messages.filter((m) => {
    if (m.loading && !m.content) return false
    if (m.phase === 'retrying') return false
    return true
  })
  if (visible.length === 0) {
    lines.push('_（暂无已完成的对话内容）_')
    lines.push('')
  } else {
    visible.forEach((msg, i) => {
      lines.push(messageToMarkdown(msg, i + 1))
    })
  }
  return lines.join('\n')
}

/** 生成 JSON 导出 */
export function conversationToJson(
  bookId: string,
  bookTitle: string,
  messages: AiMessage[],
  summary: ConversationSummary | null,
): string {
  const payload = {
    type: 'mirage-ink-ai-conversation',
    version: 1,
    exportedAt: new Date().toISOString(),
    book: { id: bookId, title: bookTitle },
    summary: summary ?? null,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      phase: m.phase,
      loading: m.loading ?? false,
      isSummarizing: m.isSummarizing ?? false,
      usage: m.usage ?? null,
      action: m.action ?? null,
    })),
  }
  return JSON.stringify(payload, null, 2)
}

/** 文件名非法字符清洗（跨平台安全） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\n\r\t]+/g, '_').trim() || 'AI对话'
}

/**
 * 打开系统保存对话框并写出对话文件。
 *
 * @returns 'saved' | 'canceled'（用户取消 / 导出失败均不抛异常，失败弹 message 提示）
 */
export async function exportAiConversation(
  options: ExportOptions,
): Promise<'saved' | 'canceled'> {
  const { bookTitle, messages, summary, format, bookId } = options
  const isJson = format === 'json'
  const ext = isJson ? 'json' : 'md'
  const fileBase = sanitizeFileName(`${bookTitle}-AI对话`)
  const timestamp = new Date().toISOString().slice(0, 10)

  try {
    const target = await save({
      title: `导出 AI 对话为 ${isJson ? 'JSON' : 'Markdown'}`,
      defaultPath: `${fileBase}-${timestamp}.${ext}`,
      filters: isJson
        ? [{ name: 'JSON 文件', extensions: ['json'] }]
        : [{ name: 'Markdown 文件', extensions: ['md'] }],
    })
    if (!target) return 'canceled'

    const content = isJson
      ? conversationToJson(bookId, bookTitle, messages, summary ?? null)
      : conversationToMarkdown(bookTitle, messages, summary ?? null)
    await writeTextFile(target, content)
    return 'saved'
  } catch (err) {
    console.error('[conversationExport] 导出失败:', err)
    await message(`导出失败：${errText(err, '未知错误')}`, {
      title: '导出 AI 对话',
      kind: 'error',
    }).catch(() => undefined)
    return 'canceled'
  }
}
