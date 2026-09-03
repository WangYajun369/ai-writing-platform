/**
 * 朗读（豆包语音合成 seed-tts）配置 Store
 *
 * 配置仅存前端 localStorage（与 AI 配置同模式），调用朗读命令时逐项传参。
 * 鉴权为豆包语音控制台 API Key（UUID），后端以 `X-Api-Key` 请求头发送。
 * configured = API Key 已填写；未配置时朗读按钮置灰并引导设置。
 */
import { create } from 'zustand'
import type { TtsConfig } from '@/types'

const TTS_CONFIG_KEY = 'time-write-tts-config'

/**
 * 默认音色：Vivi 2.0（青年女声，seed-tts 大模型标准音色，中英文均可读）。
 * 完整音色库在豆包语音控制台「音色库」试听复制：docs.volcengine.com/docs/6561/1257544
 */
export const DEFAULT_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts'

function loadTtsConfig(): TtsConfig {
  try {
    const raw = localStorage.getItem(TTS_CONFIG_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TtsConfig>
      return {
        // 旧版曾用 appId/accessKey 双字段（AppID 签名体系已下线），读不到即视为空
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        speaker:
          typeof parsed.speaker === 'string' && parsed.speaker.trim()
            ? parsed.speaker
            : DEFAULT_TTS_SPEAKER,
      }
    }
  } catch {
    /* ignore */
  }
  return { apiKey: '', speaker: DEFAULT_TTS_SPEAKER }
}

function saveTtsConfig(config: TtsConfig) {
  try {
    localStorage.setItem(TTS_CONFIG_KEY, JSON.stringify(config))
  } catch {
    /* ignore */
  }
}

interface TtsConfigState extends TtsConfig {
  /** API Key 已填写 */
  configured: boolean
  /** 合并保存（部分更新） */
  setConfig: (patch: Partial<Pick<TtsConfig, 'apiKey' | 'speaker'>>) => void
}

export const useTtsConfigStore = create<TtsConfigState>((set) => {
  const saved = loadTtsConfig()
  return {
    ...saved,
    configured: !!saved.apiKey.trim(),
    setConfig: (patch) =>
      set((s) => {
        const merged: TtsConfig = {
          apiKey: patch.apiKey ?? s.apiKey,
          speaker: patch.speaker ?? s.speaker,
        }
        saveTtsConfig(merged)
        return {
          ...merged,
          configured: !!merged.apiKey.trim(),
        }
      }),
  }
})
