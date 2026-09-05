/**
 * 统一错误解析与建议动作（Spec §10）
 *
 * 后端 AppError 序列化为 `{ code, message }`（message 为 Display 文本，
 * 可能以 `E_XXX：` 前缀开头，也可能带「业务逻辑错误: 」等中文变体包装）；
 * 历史版本与插件错误则可能为纯字符串。本模块归一化解析，供各处 catch 统一呈现。
 */
import { toast } from '@/lib/toast'
import type { ToastType } from '@/lib/toast'

export interface ParsedError {
  /** 稳定错误码（E_ 前缀；无法识别时为 E_UNKNOWN / 变体兜底码） */
  code: string
  /** 人类可读描述（已剥离 code 前缀与中文变体包装） */
  message: string
  /** 完整原始消息（调试用） */
  raw: string
}

/** GitHub Releases 最新版地址（版本过高建议动作的跳转目标） */
export const RELEASE_URL = 'https://github.com/WangYajun369/ai-writing-platform/releases/latest'

/** 消息中 `E_CODE：` / `E_CODE:` 前缀 */
const CODE_PREFIX = /^E_[A-Z0-9_]+[：:]\s*/

/** 中文变体包装（error.rs Display 前缀） */
const VARIANT_WRAP = /^(?:业务逻辑错误|数据校验错误|IO 错误|加密\/解密错误|未找到|序列化错误|数据库操作错误|数据库连接池错误|HTTP 请求错误|General|Business):\s*/

function extractCode(text: string): string | null {
  const m = /^E_[A-Z0-9_]+/.exec(text)
  return m ? m[0] : null
}

/** 归一化解析任意 catch 到的错误 */
export function parseError(err: unknown): ParsedError {
  if (err && typeof err === 'object' && 'message' in err) {
    const obj = err as { code?: unknown; message?: unknown }
    const raw = typeof obj.message === 'string' ? obj.message : ''
    const code =
      typeof obj.code === 'string' && obj.code.startsWith('E_')
        ? obj.code
        : (extractCode(raw) ?? 'E_UNKNOWN')
    return {
      code,
      message: raw.replace(VARIANT_WRAP, '').replace(CODE_PREFIX, ''),
      raw,
    }
  }
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err ?? '')
  return {
    code: extractCode(raw) ?? 'E_UNKNOWN',
    message: raw.replace(VARIANT_WRAP, '').replace(CODE_PREFIX, ''),
    raw,
  }
}

/** 展示用消息文本（剥离 code 与变体包装） */
export function errText(err: unknown, fallback = '操作失败，请稍后重试'): string {
  const { message, raw } = parseError(err)
  return message || raw || fallback
}

export interface ErrorAdvice {
  /** 建议动作文案（追加在错误消息后） */
  advice: string
  /** 可选跳转/操作按钮 */
  action?: { label: string; run: () => void }
}

/** 按 code 返回建议动作（Spec §10 前端按 code 显示建议） */
export function adviceFor(code: string): ErrorAdvice | null {
  switch (code) {
    case 'E_BACKUP_VERSION':
      return {
        advice: '备份文件版本高于当前 App 支持，请升级智写时光后再导入。',
        action: { label: '前往更新', run: () => void openReleasePage() },
      }
    case 'E_BACKUP_KEY':
      return { advice: '文件解密失败：文件已损坏，或备份密钥与当前不匹配，不会写入任何数据。' }
    case 'E_BACKUP_FILE':
    case 'E_BACKUP_SCHEMA':
      return { advice: '备份文件已损坏或格式不兼容，已拒绝导入，目标库未受影响。' }
    case 'E_BACKUP_TYPE':
      return { advice: '该文件不是有效的备份文件（类型不符或包含多本书）。' }
    case 'E_BACKUP_TOO_LARGE':
      return { advice: '文件过大，建议使用单作品导出后分别导入。' }
    case 'E_BACKUP_ROLLBACK':
      return { advice: '回退点不存在或已过期（仅保留 24 小时），无法撤销该次导入。' }
    case 'E_TXT_TOO_LARGE':
      return { advice: 'TXT 文件过大，请拆分后分批导入。' }
    case 'E_TXT_NO_CHAPTERS':
      return { advice: '未识别出任何章节内容，请确认文件非空且包含章节标题。' }
    case 'E_EXPORT_FORMAT':
      return { advice: '不支持的导出格式，请重新选择 TXT / Markdown / HTML。' }
    case 'E_IO_BUSY':
      return { advice: '已有导入/导出操作正在进行，请完成后再试。' }
    default:
      return null
  }
}

/** 打开 GitHub Releases 页（供「前往更新」等动作使用） */
export async function openReleasePage() {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(RELEASE_URL)
  } catch {
    window.open(RELEASE_URL, '_blank')
  }
}

/**
 * 统一错误 toast：显示剥离后的错误消息，命中映射时追加建议文本；
 * 含跳转类动作时附加动作按钮（error 类型，8s 展示）。
 */
export function showError(err: unknown, fallback = '操作失败，请稍后重试') {
  const { code, message } = parseError(err)
  const advice = adviceFor(code)
  const text = message || errText(err, fallback)
  const body = advice ? `${text}\n${advice.advice}` : text

  if (advice?.action) {
    toast.action('error', body, {
      label: advice.action.label,
      onClick: () => advice.action!.run(),
    })
  } else {
    toast.error(body)
  }
}

/** 按类型展示结果通知（成功/警告统一入口） */
export function showNotice(type: ToastType, msg: string) {
  toast[type](msg)
}
