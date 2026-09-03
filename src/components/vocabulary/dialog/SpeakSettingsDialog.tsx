/**
 * 朗读设置弹窗：豆包语音合成（seed-tts）API Key 与音色
 *
 * - API Key 在豆包语音控制台「API Key 管理」创建（UUID 格式，请求头 X-Api-Key）
 * - 需先开通「豆包语音合成大模型」（资源 seed-tts-2.0）
 * - 未配置时复习卡、收录框与词条精讲中的朗读按钮会置灰
 * - 「试听」使用当前填写内容直接合成播放（不保存也可试听），校验凭证是否可用
 */
import { useEffect, useState } from 'react'
import { XIcon, Volume2Icon, LoaderIcon, CheckCircle2Icon, SaveIcon, InfoIcon } from 'lucide-react'
import { ttsApi } from '@/lib/tauri-bridge'
import { playAudioFile } from '@/lib/tts-player'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useTtsConfigStore, DEFAULT_TTS_SPEAKER } from '@/stores/ttsConfig'

interface Props {
  open: boolean
  onClose: () => void
}

const inputCls =
  'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12.5px] text-zinc-100 placeholder:text-zinc-600 outline-none transition focus:border-sky-500/60 focus:bg-white/8'

export default function SpeakSettingsDialog({ open, onClose }: Props) {
  // 注意：zustand 订阅必须取原始值（每字段一个 selector）；
  // 若写成 (s) => ({...}) 返回新对象，useSyncExternalStore 判定快照持续变化 → 无限重渲染崩溃
  const savedApiKey = useTtsConfigStore((s) => s.apiKey)
  const savedSpeaker = useTtsConfigStore((s) => s.speaker)
  const setConfig = useTtsConfigStore((s) => s.setConfig)
  const [apiKey, setApiKey] = useState(savedApiKey)
  const [speaker, setSpeaker] = useState(savedSpeaker)
  const [testing, setTesting] = useState(false)

  // 每次打开时同步 store 最新值（多窗口/多入口改动后保持一致）
  useEffect(() => {
    if (open) {
      setApiKey(savedApiKey)
      setSpeaker(savedSpeaker)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const ready = !!apiKey.trim()

  function handleSave() {
    setConfig({
      apiKey: apiKey.trim(),
      speaker: speaker.trim() || DEFAULT_TTS_SPEAKER,
    })
    toast.success('朗读设置已保存，可点击卡片上的喇叭试听')
    onClose()
  }

  async function handleTest() {
    if (!ready) {
      toast.error('请先填写豆包语音 API Key')
      return
    }
    setTesting(true)
    try {
      const result = await ttsApi.speak('Hello, nice to meet you.', apiKey.trim(), speaker.trim())
      playAudioFile(result.audioPath)
      toast.success('试听成功：朗读服务可用')
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '试听失败，请核对 API Key 与音色 ID')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex w-[470px] max-w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl shadow-black/50">
        {/* 头部 */}
        <div className="flex items-center gap-2.5 border-b border-white/8 px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500 to-indigo-600">
            <Volume2Icon className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">朗读设置</div>
            <div className="text-[10.5px] text-zinc-500">豆包语音合成 · 单词 / 词组 / 句子读音</div>
          </div>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-5 py-4">
          {/* 开通指引 */}
          <div className="flex gap-2 rounded-lg border border-sky-500/20 bg-sky-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-sky-200/90">
            <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
            <div>
              前往火山引擎控制台开通「豆包语音合成大模型」，然后到
              <span className="mx-0.5 rounded bg-white/10 px-1 py-px font-mono text-[10px]">
                console.volcengine.com/speech/new/setting/apikeys
              </span>
              创建 API Key（UUID 格式）粘贴到下方。
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-400">豆包语音 API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="如 2c8c8e44-ed09-4736-8a84-xxxxxxxxxxxx"
              className={inputCls}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-400">音色 ID（可选）</label>
            <input
              value={speaker}
              onChange={(e) => setSpeaker(e.target.value)}
              placeholder={DEFAULT_TTS_SPEAKER}
              className={inputCls}
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              默认 Vivi 2.0（中英文可读）；更多音色在控制台「音色库」试听复制（docs.volcengine.com/docs/6561/1257544）
            </p>
          </div>

          <p className="text-[10.5px] leading-relaxed text-zinc-600">
            朗读的音频会缓存到本地（同词只合成一次）。试听与朗读消耗豆包语音免费/按量额度。
          </p>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center gap-2 border-t border-white/8 bg-black/20 px-5 py-3">
          <button
            onClick={handleTest}
            disabled={testing || !ready}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-sky-500/40 px-3 py-1.5 text-[12px] text-sky-300 transition hover:bg-sky-500/10',
              (testing || !ready) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            {testing ? <LoaderIcon className="h-3.5 w-3.5 animate-spin" /> : <Volume2Icon className="h-3.5 w-3.5" />}
            试听（不保存）
          </button>
          {ready && (
            <span className="flex items-center gap-1 text-[10.5px] text-emerald-400">
              <CheckCircle2Icon className="h-3 w-3" /> 已填写
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 rounded-lg bg-linear-to-r from-sky-600 to-indigo-600 px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg shadow-sky-950/40 transition hover:opacity-90"
          >
            <SaveIcon className="h-3.5 w-3.5" /> 保存
          </button>
        </div>
      </div>
    </div>
  )
}
