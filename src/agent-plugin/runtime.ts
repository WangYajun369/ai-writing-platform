/**
 * Agent 插件运行时（ADR-006 决策 4）
 *
 * ## 插件跑在哪、产出什么
 *
 * Agent 的执行引擎在 **Rust 侧**（`execute_agent_skill`），它无法回调前端 JS。
 * 因此插件 JS 的定位不是「替代引擎去跑工具循环」，而是**生成编排计划**：
 *
 * ```text
 * 插件 JS（前端，new Function 执行）
 *   → 返回 PlanStep[]（每步的指令、可用工具、轮数）
 *   → 随 execute_agent_skill 一起交给 Rust 引擎
 *   → 引擎按计划跑 Pipeline（复用既有的流式、工具、取消能力）
 * ```
 *
 * 这个切法让 `grants` 与 CSP 的代价都换到了实处：插件 JS 确实在执行，
 * 但重活仍由 Rust 引擎承担，不必在前端另建一套工具循环。
 *
 * ## 执行方式
 *
 * `new Function('host', source)`：插件源码就是一个**函数体**，`host` 已注入，
 * 末尾 `return` 出插件模块。这也是 CSP 必须放宽 `'unsafe-eval'` 的唯一原因。
 */

import type { PluginGrant } from '@/lib/tauri-bridge'
import { buildHost } from './host'
import type { HostContext, PlanStep, PluginContext, PluginModule } from './types'

/**
 * 每个 grant 解锁的工具名（Rust 侧 `grant_for_tool` 的**镜像**）
 *
 * ⚠️ 跨语言双份实现：Rust 侧是「工具 → grant」，这里是「grant → 工具」。
 * 两边必须指向同一套事实，改动任一侧都要同步另一侧
 * （`plugin/model.rs` 的测试会守住工具全覆盖，这里由 `plan_tools_are_gatekept` 守）。
 */
const TOOLS_BY_GRANT: Record<PluginGrant, readonly string[]> = {
  llm: [],
  'book.read': [
    'read_chapter',
    'read_chapter_summary',
    'read_chapter_chunk',
    'list_book_chapters',
    'get_book_context',
    'split_chapter',
  ],
  'card.search': ['search_world_cards'],
  'card.write': ['create_note_card'],
  storage: [],
}

/** 计划最多步数：防止插件生成一个跑不完的超长流水线 */
const MAX_PLAN_STEPS = 8
/** 单步默认轮数（插件未声明时） */
const DEFAULT_STEP_ROUNDS = 4
/** 单步轮数上限 */
const MAX_STEP_ROUNDS = 20
/** plan() 的执行超时（毫秒）：插件可能是死循环，不能让它挂住整个会话 */
const PLAN_TIMEOUT_MS = 5_000

/** grants 覆盖到的工具全集（不在集合里的一律视为越权或未知） */
function allowedTools(grants: PluginGrant[]): Set<string> {
  const set = new Set<string>()
  for (const g of grants) {
    for (const t of TOOLS_BY_GRANT[g] ?? []) set.add(t)
  }
  return set
}

export interface BuildPlanOptions extends HostContext {
  /** 插件入口源码 */
  source: string
  grants: PluginGrant[]
  ctx: PluginContext
}

/**
 * 执行插件并取其编排计划
 *
 * 返回 `null` 表示插件本次不接管编排（由引擎按默认方式跑），
 * **不**视为错误——插件完全可以只在特定条件下接管。
 *
 * 抛错表示插件有问题（语法错误、计划越权、超时），调用方应降级为「不接管」
 * 并记录日志，而不是让整个会话失败。
 */
export async function buildPlan(opts: BuildPlanOptions): Promise<PlanStep[] | null> {
  let factory: (host: unknown) => PluginModule
  try {
    factory = new Function('host', opts.source) as (host: unknown) => PluginModule
  } catch (err) {
    throw new Error(`插件源码无法编译：${(err as Error).message}`)
  }

  const host = buildHost(opts.grants, opts)
  let mod: PluginModule
  try {
    mod = factory(host)
  } catch (err) {
    throw new Error(`插件初始化失败：${(err as Error).message}`)
  }

  if (typeof mod?.plan !== 'function') {
    // 插件没提供 plan —— 合法，它只是个纯声明式插件
    return null
  }

  const raw = await withTimeout(
    Promise.resolve(mod.plan!(opts.ctx)),
    PLAN_TIMEOUT_MS,
    '插件 plan() 执行超时',
  )

  return normalizePlan(raw, allowedTools(opts.grants))
}

/** 给 promise 套超时，超时即 reject（避免插件死循环挂住会话） */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 校验并规范化插件产出的计划 */
function normalizePlan(raw: unknown, allowed: Set<string>): PlanStep[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) {
    throw new Error('plan() 必须返回数组或 null')
  }
  if (raw.length === 0) return null
  if (raw.length > MAX_PLAN_STEPS) {
    throw new Error(`计划步骤过多（${raw.length} > ${MAX_PLAN_STEPS}）`)
  }

  return raw.map((item, i) => {
    if (typeof item?.name !== 'string' || !item.name.trim()) {
      throw new Error(`第 ${i + 1} 步缺少 name`)
    }
    if (typeof item?.instruction !== 'string' || !item.instruction.trim()) {
      throw new Error(`第 ${i + 1} 步缺少 instruction`)
    }
    const tools = Array.isArray(item.tools) ? item.tools : []
    for (const t of tools) {
      if (typeof t !== 'string' || !allowed.has(t)) {
        throw new Error(
          `第 ${i + 1} 步引用了越权或未知的工具「${String(t)}」——插件只能使用其 grants 覆盖的工具`,
        )
      }
    }
    const rounds = typeof item.maxRounds === 'number' ? item.maxRounds : DEFAULT_STEP_ROUNDS
    return {
      name: item.name,
      instruction: item.instruction,
      tools,
      maxRounds: Math.min(Math.max(1, Math.round(rounds)), MAX_STEP_ROUNDS),
    }
  })
}
