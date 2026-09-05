/**
 * 朗读按钮：豆包语音合成（seed-tts）朗读 英文单词 / 词组 / 句子
 *
 * - 未配置豆包语音 API Key 时按钮置灰，title 引导去朗读设置填写
 * - 全窗口共享单音频实例：点新的内容打断上一条；再点同一内容 = 重播
 */
import { useState } from 'react'
import { Volume2Icon, LoaderIcon } from 'lucide-react'
import { ttsApi } from '@/lib/tauri-bridge'
import { playAudioFile } from '@/lib/tts-player'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useTtsConfigStore } from '@/stores/ttsConfig'

interface Props {
  /** 要朗读的文本（单词 / 词组 / 句子） */
  text: string
  className?: string
  /** 图标尺寸 */
  size?: number
  /** 自定义悬停提示（未配置朗读时覆盖） */
  title?: string
}

export default function SpeakButton({ text, className, size = 15, title }: Props) {
  const apiKey = useTtsConfigStore((s) => s.apiKey)
  const speaker = useTtsConfigStore((s) => s.speaker)
  const configured = useTtsConfigStore((s) => s.configured)
  const [synthing, setSynthing] = useState(false)

  const content = text?.trim() ?? ''
  const enabled = configured && content.length > 0 && !synthing

  async function handleSpeak() {
    if (!configured || synthing || !content) return
    setSynthing(true)
    try {
      const result = await ttsApi.speak(content, apiKey, speaker)
      playAudioFile(result.audioPath)
    } catch (err) {
      toast.error(errText(err, '朗读失败，请检查朗读设置'))
    } finally {
      setSynthing(false)
    }
  }

  const tooltip = configured
    ? title ?? (content ? '朗读（再点打断重播）' : '')
    : '未配置朗读（豆包语音 API Key），请点击右上角「朗读设置」'

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        void handleSpeak()
      }}
      disabled={!enabled}
      title={tooltip}
      aria-label="朗读"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md text-zinc-400/90 transition',
        'hover:bg-sky-500/15 hover:text-sky-300 active:scale-95',
        'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-400/90',
        className,
      )}
    >
      {synthing ? (
        <LoaderIcon size={size} className="animate-spin" />
      ) : (
        <Volume2Icon size={size} />
      )}
    </button>
  )
}
