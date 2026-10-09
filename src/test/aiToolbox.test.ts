/**
 * AI 工具箱 单元测试
 *
 * 覆盖三处历史缺陷的回归保护：
 * 1. 前后端默认分类数据双份维护 → 字段级一致性守卫（防止只改一处）
 * 2. `initFromConfig` 的 length > 0 守卫 → 用户删空分类后重启「复活」
 * 3. 分类写入逐键全量落盘 → 结构化变更立即写、文本编辑防抖写
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAiStore, defaultAiConfig } from '@/stores/aiStore'
import { DEFAULT_AI_TOOL_CATEGORIES } from '@/stores/appTypes'
import type { AiToolCategory } from '@/types'
// Rust 侧内置默认分类（单一真相源），经 Vite JSON 导入，避免测试走 fs
import rustDefaults from '../../src-tauri/src/config/default_ai_tool_categories.json'

// mock configClient：避免真实 IPC，并记录 set 调用
const setSpy = vi.fn().mockResolvedValue(undefined)
const getSpy = vi.fn().mockResolvedValue({})
const resetSpy = vi.fn().mockResolvedValue([])
vi.mock('@/lib/configClient', () => ({
  configClient: {
    ai: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), reset: vi.fn() },
    preferences: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
    tts: { get: vi.fn(), set: vi.fn(), reset: vi.fn() },
    aiToolCategories: {
      get: (...a: unknown[]) => getSpy(...a),
      set: (...a: unknown[]) => setSpy(...a),
      reset: (...a: unknown[]) => resetSpy(...a),
    },
  },
}))

/** Rust 侧内置默认分类（单一真相源） */
function loadRustDefaults(): AiToolCategory[] {
  return rustDefaults as unknown as AiToolCategory[]
}

describe('AI 工具箱默认数据', () => {
  it('前端镜像与 Rust 内置默认分类完全一致（分类数/工具数/字段）', () => {
    const rust = loadRustDefaults()
    expect(DEFAULT_AI_TOOL_CATEGORIES.length).toBe(rust.length)

    const flat = (cats: AiToolCategory[]) =>
      cats.flatMap((c) => c.tools.map((t) => `${c.id}/${t.id}`))
    expect(flat(DEFAULT_AI_TOOL_CATEGORIES).sort()).toEqual(flat(rust).sort())

    // 逐字段比对（历史上出现过引号全角/半角漂移）
    const feMap = new Map(
      DEFAULT_AI_TOOL_CATEGORIES.flatMap((c) => c.tools.map((t) => [t.id, t] as const)),
    )
    for (const cat of rust) {
      for (const tool of cat.tools) {
        const fe = feMap.get(tool.id)
        expect(fe, `工具 ${tool.id} 在前端缺失`).toBeDefined()
        expect(fe!.name).toBe(tool.name)
        expect(fe!.description).toBe(tool.description)
        expect(fe!.systemPrompt).toBe(tool.systemPrompt)
      }
    }
  })

  it('Rust 默认分类结构满足后端校验要求（每项有 id/name/tools）', () => {
    for (const cat of loadRustDefaults()) {
      expect(typeof cat.id).toBe('string')
      expect(typeof cat.name).toBe('string')
      expect(Array.isArray(cat.tools)).toBe(true)
      for (const tool of cat.tools) {
        expect(typeof tool.id).toBe('string')
        expect(typeof tool.name).toBe('string')
      }
    }
  })
})

describe('aiStore 工具箱分类', () => {
  beforeEach(() => {
    setSpy.mockClear()
    getSpy.mockClear().mockResolvedValue({})
    resetSpy.mockClear().mockResolvedValue([])
    vi.useRealTimers()
    useAiStore.setState({
      aiToolCategories: DEFAULT_AI_TOOL_CATEGORIES,
      aiConfig: defaultAiConfig,
    })
  })

  it('initFromConfig 接受空数组：用户删空分类后不会「复活」默认值', async () => {
    getSpy.mockResolvedValue([])
    await useAiStore.getState().initFromConfig()
    expect(useAiStore.getState().aiToolCategories).toEqual([])
  })

  it('initFromConfig 后端无记录时保持默认分类', async () => {
    // 非数组返回（异常/缺字段）→ 不应覆盖默认值
    getSpy.mockResolvedValue(null as unknown as AiToolCategory[])
    await useAiStore.getState().initFromConfig()
    expect(useAiStore.getState().aiToolCategories.length).toBeGreaterThan(0)
  })

  it('删除分类：立即落盘（不等防抖）', () => {
    const target = DEFAULT_AI_TOOL_CATEGORIES[0]
    useAiStore.getState().deleteAiToolCategory(target.id)
    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as AiToolCategory[]
    expect(payload.some((c) => c.id === target.id)).toBe(false)
  })

  it('编辑 System Prompt：走防抖，500ms 内合并为一次写', () => {
    vi.useFakeTimers()
    const cat = DEFAULT_AI_TOOL_CATEGORIES[0]
    const tool = cat.tools[0]
    const st = useAiStore.getState()
    // 模拟逐键输入 5 次
    for (const suffix of ['你', '你是', '你是一', '你是一位', '你是一位助手']) {
      st.updateAiToolPrompt(cat.id, tool.id, { systemPrompt: suffix })
    }
    expect(setSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as AiToolCategory[]
    const savedTool = payload
      .find((c) => c.id === cat.id)!
      .tools.find((t) => t.id === tool.id)!
    expect(savedTool.systemPrompt).toBe('你是一位助手')
    vi.useRealTimers()
  })

  it('防抖期间发生结构性变更：立即落盘且只写一次最新快照', () => {
    vi.useFakeTimers()
    const cat = DEFAULT_AI_TOOL_CATEGORIES[0]
    const tool = cat.tools[0]
    const st = useAiStore.getState()
    st.updateAiToolPrompt(cat.id, tool.id, { systemPrompt: '草稿' })
    // 防抖未触发时删除该工具 → 应立刻落盘，且不残留待写草稿
    st.deleteAiToolPrompt(cat.id, tool.id)
    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as AiToolCategory[]
    expect(payload.find((c) => c.id === cat.id)!.tools.some((t) => t.id === tool.id)).toBe(false)
    vi.advanceTimersByTime(1000)
    // 防抖回调不应再补写一份旧快照
    expect(setSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('updateAiToolPrompt 落盘后可在 initFromConfig 中被读回（端到端闭环）', async () => {
    const cat = DEFAULT_AI_TOOL_CATEGORIES[0]
    const tool = cat.tools[0]
    // 必须先切假定时器再调用，否则防抖走的是真实定时器，advanceTimersByTime 无效
    vi.useFakeTimers()
    useAiStore.getState().updateAiToolPrompt(cat.id, tool.id, { systemPrompt: '持久化校验' })
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    const written = setSpy.mock.calls[0][0] as AiToolCategory[]

    getSpy.mockResolvedValue(written)
    await useAiStore.getState().initFromConfig()
    const restored = useAiStore
      .getState()
      .aiToolCategories.find((c) => c.id === cat.id)!
      .tools.find((t) => t.id === tool.id)!
    expect(restored.systemPrompt).toBe('持久化校验')
  })
})
