/**
 * configClient — 应用配置统一入口(v1.9 架构优化)
 *
 * 替代原本散落在 4 个 store 的 localStorage load/save 函数:
 *
 * - `loadAiConfig` / `saveAiConfig` ← 原 `appTypes.ts`
 * - TTS 配置 load/save ← 原 `ttsConfig.ts`
 * - 偏好 load/save ← 原 `preferencesStore.ts` / `appTypes.ts`
 * - AI 工具箱分类 load/save ← 原 `appTypes.ts`
 *
 * ## 调用约定
 *
 * - **读取**:`configClient.ai.get()` → 后端 `get_config` 命令(三层加载)
 * - **写入**:`configClient.ai.set(value)` → 后端 `set_config` 命令(以 CONFIG_VERSION 持久化)
 * - **重置**:`configClient.ai.reset()` → 后端 `reset_config` 命令(返回默认值)
 *
 * ## 启动迁移
 *
 * 应用启动时调用 [`migrateLegacyLocalStorage`] 一次性迁移旧 localStorage 数据,
 * 迁移成功后清理 localStorage key。幂等:已迁移的段会跳过。
 */

import { configApi, type LegacyMigrationResult } from '@/lib/tauri-bridge'
import type { AiConfig, AiToolCategory, TtsConfig } from '@/types'

// ─── 旧 localStorage key 清单(用于一次性迁移) ───

const LEGACY_KEYS = {
  ai: 'time-write-ai-config',
  aiToolCategories: 'time-write-ai-tool-categories',
  aiToolPromptsLegacy: 'time-write-ai-tool-prompts', // 更早期格式,前端已迁移
  tts: 'time-write-tts-config',
  preferences: 'time-write-preferences',
} as const

/**
 * 检测并迁移旧 localStorage 数据到后端 app_config 表
 *
 * 调用时机:AppInit 中,在 store 初始化之前。幂等:已迁移的段会跳过。
 * 迁移成功的 localStorage key 会被清理(避免下次启动重复扫描)。
 */
export async function migrateLegacyLocalStorage(): Promise<LegacyMigrationResult> {
  const payload: Record<string, unknown> = {}

  // AI 配置(可能为 v0 顶层字段或 v1 chat/rag 嵌套,后端兼容处理)
  const aiRaw = localStorage.getItem(LEGACY_KEYS.ai)
  if (aiRaw) {
    try {
      payload.ai = JSON.parse(aiRaw)
    } catch {
      /* 跳过非法 JSON */
    }
  }

  // AI 工具箱分类(优先新 key,无则尝试旧 prompts key)
  const catsRaw = localStorage.getItem(LEGACY_KEYS.aiToolCategories)
  if (catsRaw) {
    try {
      payload.aiToolCategories = JSON.parse(catsRaw)
    } catch {
      /* 跳过 */
    }
  } else {
    const legacyPromptsRaw = localStorage.getItem(LEGACY_KEYS.aiToolPromptsLegacy)
    if (legacyPromptsRaw) {
      try {
        const oldPrompts = JSON.parse(legacyPromptsRaw)
        if (Array.isArray(oldPrompts) && oldPrompts.length > 0) {
          // 旧 prompts 数组 → 包装为单个「自定义」分类
          payload.aiToolCategories = [
            {
              id: 'migrated',
              name: '自定义',
              color: 'linear-gradient(180deg, #E0EBFF -5%, #FFF2E7 99.73%)',
              tools: oldPrompts.map(
                (p: Record<string, unknown>) => ({
                  id: (p.id as string) || crypto.randomUUID(),
                  name: (p.name as string) || '未命名',
                  description: (p.description as string) || '',
                  systemPrompt: (p.systemPrompt as string) || '',
                }),
              ),
            },
          ]
        }
      } catch {
        /* 跳过 */
      }
    }
  }

  // TTS 配置
  const ttsRaw = localStorage.getItem(LEGACY_KEYS.tts)
  if (ttsRaw) {
    try {
      payload.tts = JSON.parse(ttsRaw)
    } catch {
      /* 跳过 */
    }
  }

  // 偏好(以 createStorage 写入,需取 _value 子对象)
  const prefsRaw = localStorage.getItem(LEGACY_KEYS.preferences)
  if (prefsRaw) {
    try {
      const parsed = JSON.parse(prefsRaw)
      // createStorage 的存储格式是 { _value: {...}, _ts: ... },需取 _value
      const prefsValue = parsed?._value ?? parsed
      if (prefsValue && typeof prefsValue === 'object') {
        payload.preferences = prefsValue
      }
    } catch {
      /* 跳过 */
    }
  }

  // 无旧数据可迁移,返回空结果(避免无谓的 IPC 调用)
  if (Object.keys(payload).length === 0) {
    return {
      ai: { migrated: false, reason: 'no legacy data' },
      tts: { migrated: false, reason: 'no legacy data' },
      preferences: { migrated: false, reason: 'no legacy data' },
      aiToolCategories: { migrated: false, reason: 'no legacy data' },
    }
  }

  // 调用后端一次性迁移
  const result = await configApi.migrateLegacy(payload)

  // 迁移成功的段清理 localStorage key(避免下次启动重复扫描)
  // 注意:只清理确实迁移成功的段,失败段保留以便重试
  if (result.ai.migrated) localStorage.removeItem(LEGACY_KEYS.ai)
  if (result.tts.migrated) localStorage.removeItem(LEGACY_KEYS.tts)
  if (result.preferences.migrated) localStorage.removeItem(LEGACY_KEYS.preferences)
  if (result.aiToolCategories.migrated) {
    localStorage.removeItem(LEGACY_KEYS.aiToolCategories)
    localStorage.removeItem(LEGACY_KEYS.aiToolPromptsLegacy)
  }

  return result
}

// ─── 4 段配置的统一入口 ───

export const configClient = {
  /** AI 配置段(对话/RAG) */
  ai: {
    async get(): Promise<AiConfig> {
      return configApi.get<AiConfig>('ai')
    },
    async set(value: AiConfig): Promise<void> {
      return configApi.set('ai', value)
    },
    async reset(): Promise<AiConfig> {
      return configApi.reset<AiConfig>('ai')
    },
  },

  /** TTS 配置段(豆包语音合成) */
  tts: {
    async get(): Promise<TtsConfig> {
      return configApi.get<TtsConfig>('tts')
    },
    async set(value: TtsConfig): Promise<void> {
      return configApi.set('tts', value)
    },
    async reset(): Promise<TtsConfig> {
      return configApi.reset<TtsConfig>('tts')
    },
  },

  /** 偏好段(主题/字体/网格等) */
  preferences: {
    async get<T extends Record<string, unknown>>(): Promise<T> {
      return configApi.get<T>('preferences')
    },
    async set<T extends Record<string, unknown>>(value: T): Promise<void> {
      return configApi.set('preferences', value)
    },
    async reset<T extends Record<string, unknown>>(): Promise<T> {
      return configApi.reset<T>('preferences')
    },
  },

  /** AI 工具箱分类段(用户自定义提示词) */
  aiToolCategories: {
    async get(): Promise<AiToolCategory[]> {
      return configApi.get<AiToolCategory[]>('ai_tool_categories')
    },
    async set(value: AiToolCategory[]): Promise<void> {
      return configApi.set('ai_tool_categories', value)
    },
    async reset(): Promise<AiToolCategory[]> {
      return configApi.reset<AiToolCategory[]>('ai_tool_categories')
    },
  },
}
