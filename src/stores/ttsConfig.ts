/**
 * 朗读（豆包语音合成 seed-tts）配置 Store
 *
 * v1.9 架构优化:配置持久化层从 localStorage 迁移到后端统一 config 模块
 * (configClient.tts → IPC → app_config 表)。
 *
 * 鉴权为豆包语音控制台 API Key（UUID），后端以 `X-Api-Key` 请求头发送。
 * configured = API Key 已填写；未配置时朗读按钮置灰并引导设置。
 *
 * 启动流程:
 * 1. store 初始化用默认音色(同步)
 * 2. AppInit 调用 `initFromConfig()` 从后端拉取真实配置
 * 3. setConfig 同步更新内存 + 异步写后端
 */
import { create } from 'zustand'
import type { TtsConfig } from '@/types'
import { configClient } from '@/lib/configClient'

/**
 * 默认音色：Vivi 2.0（青年女声，seed-tts 大模型标准音色，中英文均可读）。
 * 完整音色库在豆包语音控制台「音色库」试听复制：docs.volcengine.com/docs/6561/1257544
 */
export const DEFAULT_TTS_SPEAKER = 'zh_female_vv_uranus_bigtts'

interface TtsConfigState extends TtsConfig {
  /** API Key 已填写 */
  configured: boolean
  /** 从后端 config 模块加载真实配置(AppInit 调用) */
  initFromConfig: () => Promise<void>
  /** 合并保存（部分更新） */
  setConfig: (patch: Partial<Pick<TtsConfig, 'apiKey' | 'speaker'>>) => void
}

export const useTtsConfigStore = create<TtsConfigState>((set, get) => ({
  apiKey: '',
  speaker: DEFAULT_TTS_SPEAKER,
  configured: false,

  initFromConfig: async () => {
    try {
      const remote = await configClient.tts.get()
      set({
        apiKey: remote.apiKey ?? '',
        speaker: remote.speaker?.trim() ? remote.speaker : DEFAULT_TTS_SPEAKER,
        configured: !!(remote.apiKey && remote.apiKey.trim()),
      })
    } catch {
      /* 后端读取失败,保持默认值 */
    }
  },

  setConfig: (patch) => {
    const merged: TtsConfig = {
      apiKey: patch.apiKey ?? get().apiKey,
      speaker: patch.speaker ?? get().speaker,
    }
    set({
      ...merged,
      configured: !!merged.apiKey.trim(),
    })
    // 异步写后端,失败静默
    void configClient.tts.set(merged).catch(() => {
      /* ignore */
    })
  },
}))
