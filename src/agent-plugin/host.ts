/**
 * Agent 插件宿主注入面（ADR-006 决策 2 / 4）
 *
 * 本文件是**唯一**构造 `PluginHost` 对象的地方。两条不可动摇的约束：
 *
 * 1. **未声明即不挂载** —— `grants` 里没有的能力，字段根本不会出现在对象上
 *    （访问为 `undefined`）。不是「在对象上但调用时报错」，
 *    否则插件探测能力时会误判自己有权限。
 * 2. **LLM 通道只走应用自身配置** —— `provider` / `endpoint` / `apiKey` 全部取自
 *    `HostContext.aiConfig`，插件**无法**传入 endpoint 或 key。
 *    这条是 ADR-006 决策 2 的兜底要求：一旦插件能自带 endpoint + key，
 *    就等于拿到了一条绕过应用配置的数据出口。
 */

import { aiApi, chapterApi, worldCardApi, type PluginGrant } from '@/lib/tauri-bridge'
import type { WorldCardType } from '@/types'
import type {
  HostContext,
  PluginCardInput,
  PluginCardRef,
  PluginChapterRef,
  PluginHost,
} from './types'

/**
 * Agent 插件的 storage 前缀
 *
 * 刻意区别于内置模块用的 `tw:plugin:`——那套是另一个系统，
 * 共用前缀会让两套插件的存储互相覆盖。
 */
const STORAGE_PREFIX = 'tw:agent-plugin:'

/** 允许插件写入的卡片类型（与 Rust 侧 `CARD_TYPES` 一致） */
const CARD_TYPES: WorldCardType[] = [
  'character',
  'location',
  'timeline',
  'faction',
  'item',
  'misc',
]

/** 按 `grants` 裁剪出宿主注入对象 */
export function buildHost(grants: PluginGrant[], ctx: HostContext): PluginHost {
  const has = (g: PluginGrant) => grants.includes(g)

  // log 恒定注入：不读不写数据、无副作用、不构成数据出口
  const host: PluginHost = {
    log: {
      info: (message) => console.info(`[agent-plugin:${ctx.pluginId}] ${message}`),
      warn: (message) => console.warn(`[agent-plugin:${ctx.pluginId}] ${message}`),
    },
  }

  if (has('llm')) {
    host.llm = {
      async complete(prompt: string): Promise<string> {
        const cfg = ctx.aiConfig
        if (!cfg) {
          throw new Error('未配置 AI 服务，llm.complete 不可用')
        }
        // ⚠️ provider / endpoint / apiKey 全部来自应用配置，插件无法覆盖
        return aiApi.streamChat({
          provider: cfg.provider,
          endpoint: cfg.endpoint,
          model: cfg.model,
          temperature: cfg.temperature ?? 0.7,
          maxTokens: cfg.maxTokens ?? undefined,
          apiKey: cfg.apiKey ?? undefined,
          thinkingEnabled: cfg.thinkingEnabled ?? undefined,
          messages: [{ role: 'user', content: prompt }],
        })
      },
    }
  }

  if (has('book.read')) {
    host.book = {
      async listChapters(): Promise<PluginChapterRef[]> {
        const list = await chapterApi.listByBook(ctx.bookId)
        // 只暴露引用字段，不给插件完整 Chapter（含软删除状态等内部信息）
        return list.map((c) => ({
          id: c.id,
          title: c.title,
          wordCount: c.wordCount,
        }))
      },
      async readChapter(chapterId: string): Promise<string> {
        return chapterApi.getContent(chapterId)
      },
    }
  }

  if (has('card.search') || has('card.write')) {
    const card: NonNullable<PluginHost['card']> = {}
    if (has('card.search')) {
      card.search = async (query: string): Promise<PluginCardRef[]> => {
        const hits = await worldCardApi.search(ctx.bookId, query)
        return hits.map((c) => ({
          id: c.id,
          title: c.title,
          cardType: c.type,
          content: c.content,
        }))
      }
    }
    if (has('card.write')) {
      card.create = async (input: PluginCardInput): Promise<{ id: string }> => {
        // 非法 cardType 直接拒绝而非回退：前端设定面板按 type 取图标时无兜底，
        // 写入未知类型会让整个面板白屏（既有缺陷，不可让插件触发它）
        const type = (input.cardType ?? 'misc') as WorldCardType
        if (!CARD_TYPES.includes(type)) {
          throw new Error(
            `cardType 非法：${input.cardType}，允许值为 ${CARD_TYPES.join(' / ')}`,
          )
        }
        const created = await worldCardApi.create({
          bookId: ctx.bookId,
          type,
          title: input.title,
          content: input.content,
          contentHtml: input.content,
          tags: input.tags ?? [],
        })
        return { id: created.id }
      }
    }
    host.card = card
  }

  if (has('storage')) {
    const prefix = `${STORAGE_PREFIX}${ctx.pluginId}:`
    host.storage = {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        const raw = localStorage.getItem(prefix + key)
        return raw === null ? undefined : (JSON.parse(raw) as T)
      },
      async set<T = unknown>(key: string, value: T): Promise<void> {
        localStorage.setItem(prefix + key, JSON.stringify(value))
      },
      async remove(key: string): Promise<void> {
        localStorage.removeItem(prefix + key)
      },
    }
  }

  return host
}
