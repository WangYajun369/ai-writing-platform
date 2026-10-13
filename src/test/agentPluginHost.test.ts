/**
 * Agent 插件宿主注入面 / 运行时 单元测试（ADR-006 任务 3）
 *
 * 这些断言存在的意义：**注入面是本插件系统的唯一防线**。
 * 一旦 `host` 上挂载了未被 `grants` 声明的能力（尤其是能触达数据的方法），
 * 权限模型就形同虚设。故「未声明 ⇒ 字段不存在」必须由测试钉死。
 */

import { describe, it, expect } from 'vitest'
import { buildHost } from '@/agent-plugin/host'
import { buildPlan } from '@/agent-plugin/runtime'
import type { PluginGrant } from '@/lib/tauri-bridge'

const HOST_CTX = { pluginId: 'demo-plugin', bookId: 'book-1' }
const PLAN_CTX = { bookId: 'book-1', message: '请把这章拆成要点' }

function run(source: string, grants: PluginGrant[]) {
  return buildPlan({ ...HOST_CTX, source, grants, ctx: PLAN_CTX })
}

describe('buildHost 能力裁剪', () => {
  it('未声明任何 grants 时，除 log 外一律不挂载', () => {
    const host = buildHost([], HOST_CTX)
    expect(host.llm).toBeUndefined()
    expect(host.book).toBeUndefined()
    expect(host.card).toBeUndefined()
    expect(host.storage).toBeUndefined()
    // log 恒定注入：无副作用、不构成数据出口
    expect(host.log.info).toBeTypeOf('function')
  })

  it('声明全部 grants 时注入面完整', () => {
    const host = buildHost(
      ['llm', 'book.read', 'card.search', 'card.write', 'storage'],
      HOST_CTX,
    )
    expect(host.llm?.complete).toBeTypeOf('function')
    expect(host.book?.listChapters).toBeTypeOf('function')
    expect(host.book?.readChapter).toBeTypeOf('function')
    expect(host.card?.search).toBeTypeOf('function')
    expect(host.card?.create).toBeTypeOf('function')
    expect(host.storage?.get).toBeTypeOf('function')
  })

  it('card 的读写两项权限各自独立', () => {
    // 只读插件不该顺带拿到写权限
    const ro = buildHost(['card.search'], HOST_CTX)
    expect(ro.card?.search).toBeTypeOf('function')
    expect(ro.card?.create).toBeUndefined()

    const wo = buildHost(['card.write'], HOST_CTX)
    expect(wo.card?.create).toBeTypeOf('function')
    expect(wo.card?.search).toBeUndefined()
  })

  it('storage 按 pluginId 隔离，插件间互不可见', async () => {
    const a = buildHost(['storage'], { pluginId: 'plug-a', bookId: 'book-1' }).storage!
    const b = buildHost(['storage'], { pluginId: 'plug-b', bookId: 'book-1' }).storage!

    await a.set('k', { v: 1 })
    expect(await a.get('k')).toEqual({ v: 1 })
    expect(await b.get('k')).toBeUndefined()

    await a.remove('k')
    expect(await a.get('k')).toBeUndefined()
  })

  it('storage 前缀与内置模块的 tw:plugin: 不冲突', async () => {
    const s = buildHost(['storage'], HOST_CTX).storage!
    await s.set('shared', 1)
    // 内置模块用的是 tw:plugin:，这里写入的 key 不应落在那个前缀下
    expect(localStorage.getItem('tw:plugin:demo-plugin:shared')).toBeNull()
    await s.remove('shared')
  })
})

describe('buildPlan 计划校验', () => {
  it('插件可返回合法计划，缺省轮数补默认值', async () => {
    const source = `
      return {
        async plan(ctx) {
          return [{ name: '拆章节', instruction: '先看清结构', tools: ['list_book_chapters'] }]
        },
      }
    `
    const plan = await run(source, ['book.read'])
    expect(plan).toHaveLength(1)
    expect(plan![0].name).toBe('拆章节')
    expect(plan![0].tools).toEqual(['list_book_chapters'])
    expect(plan![0].maxRounds).toBe(4)
  })

  it('插件没有 plan 时返回 null（纯声明式插件）', async () => {
    expect(await run('return {}', ['book.read'])).toBeNull()
    expect(await run('return {}', [])).toBeNull()
  })

  it('plan 返回 null 表示本次不接管编排', async () => {
    expect(await run('return { plan: () => null }', ['book.read'])).toBeNull()
  })

  it('引用未被 grants 覆盖的工具时拒绝', async () => {
    const source = `
      return { plan: () => [{ name: 'x', instruction: 'y', tools: ['create_note_card'] }] }
    `
    // 只声明了 book.read，却要用 card.write 的 create_note_card
    await expect(run(source, ['book.read'])).rejects.toThrow(/越权|未知/)
  })

  it('引用根本不存在的工具时拒绝', async () => {
    const source = `
      return { plan: () => [{ name: 'x', instruction: 'y', tools: ['drop_database'] }] }
    `
    await expect(
      run(source, ['llm', 'book.read', 'card.search', 'card.write', 'storage']),
    ).rejects.toThrow(/越权|未知/)
  })

  it('未声明任何 grants 时，计划里不能带任何工具', async () => {
    const source = `
      return { plan: () => [{ name: 'x', instruction: 'y', tools: ['list_book_chapters'] }] }
    `
    await expect(run(source, [])).rejects.toThrow(/越权|未知/)
  })

  it('步骤数超过上限时拒绝', async () => {
    const source = `
      return {
        plan: () => Array.from({ length: 9 }, (_, i) => ({
          name: 's' + i, instruction: 'x', tools: [],
        })),
      }
    `
    await expect(run(source, ['book.read'])).rejects.toThrow(/过多/)
  })

  it('轮数被夹断到 1..20', async () => {
    const source = (rounds: number) =>
      `return { plan: () => [{ name: 'x', instruction: 'y', tools: [], maxRounds: ${rounds} }] }`
    expect((await run(source(9999), []))![0].maxRounds).toBe(20)
    expect((await run(source(0), []))![0].maxRounds).toBe(1)
  })

  it('缺少 name 或 instruction 的步骤被拒绝', async () => {
    await expect(
      run(`return { plan: () => [{ instruction: 'y', tools: [] }] }`, []),
    ).rejects.toThrow(/缺少 name/)
    await expect(
      run(`return { plan: () => [{ name: 'x', tools: [] }] }`, []),
    ).rejects.toThrow(/缺少 instruction/)
  })

  it('源码语法错误时抛出可读错误', async () => {
    await expect(run('return {{{', [])).rejects.toThrow(/无法编译/)
  })

  it('插件初始化抛错时被包装成可读错误', async () => {
    await expect(run('throw new Error("boom")', [])).rejects.toThrow(/初始化失败/)
  })
})
