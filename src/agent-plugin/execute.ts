/**
 * 插件画像的执行入口（ADR-006）
 *
 * 把「跑插件 JS 生成编排计划」与「调引擎执行」串起来：
 *
 * ```text
 * skill 是插件画像？
 *   ├─ 否 → plan = null（引擎按内置方式跑）
 *   └─ 是 → 拉插件源码 → new Function 执行 → 拿 PlanStep[] → 校验 → 交给引擎
 * ```
 *
 * ## 为什么失败一律降级而不是报错
 *
 * 插件是第三方代码，它出任何岔子（语法错、越权、死循环超时）
 * 都不该让用户这一次对话直接失败。故 `resolvePluginPlan` 捕获全部异常，
 * 降级为「本次不接管编排」——引擎照常按画像默认方式跑，用户无感。
 */

import { agentApi, pluginApi, type AgentSkillArgs } from '@/lib/tauri-bridge'
import { buildPlan } from './runtime'
import type { PlanStep } from './types'

/**
 * 为插件画像生成编排计划；非插件画像或插件出问题时返回 `null`
 */
export async function resolvePluginPlan(args: {
  skill: string
  bookId: string
  message: string
  aiConfig?: AgentSkillArgs['aiConfig']
}): Promise<PlanStep[] | null> {
  try {
    const plugins = await pluginApi.list()
    const hit = plugins.find(
      (p) =>
        p.enabled &&
        p.status === 'ok' &&
        p.manifest.profiles.some((prof) => prof.id === args.skill),
    )
    // 不是插件画像（内置能力 / 领域）→ 无需编排计划
    if (!hit) return null

    const source = await pluginApi.source(hit.manifest.id)
    return await buildPlan({
      pluginId: hit.manifest.id,
      bookId: args.bookId,
      aiConfig: args.aiConfig ?? null,
      source,
      grants: hit.manifest.grants,
      ctx: { bookId: args.bookId, message: args.message },
    })
  } catch (err) {
    console.warn('[agent-plugin] 生成编排计划失败，本次不接管编排：', err)
    return null
  }
}

/**
 * 执行 Skill：插件画像会自动带上其 JS 生成的编排计划
 *
 * 与直接调 `agentApi.executeSkill` 的差别仅在于多解析一次 plan；
 * 未装任何插件时行为完全一致（一次 `pluginApi.list` 的开销）。
 */
export async function executeSkillWithPluginPlan(args: AgentSkillArgs): Promise<string> {
  const plan = await resolvePluginPlan({
    skill: args.skill,
    bookId: args.bookId,
    message: args.message,
    aiConfig: args.aiConfig,
  })
  return agentApi.executeSkill({ ...args, plan })
}
