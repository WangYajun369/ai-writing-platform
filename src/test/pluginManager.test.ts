/**
 * PluginManager 单元测试
 *
 * 锁定 v1.9 稳定性强化的四件事:
 * 1. Manifest schema 校验 — 畸形插件拒绝注册
 * 2. 错误隔离 — 单插件 init / getCommands 异常不阻塞其他插件
 * 3. 生命周期幂等 — 重复 enable / disable 不重复调用 init / destroy
 * 4. storage namespace 隔离 — 插件间数据互不可见
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PluginManagerImpl } from '@/plugins/PluginManager'
import { validateManifest } from '@/plugins/schema'
import type { Plugin, PluginCommand, PluginContext, PluginManifest } from '@/plugins/types'

// mock toast 与 errText,避免测试污染真实 UI
vi.mock('@/lib/toast', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    action: vi.fn(),
  },
}))
vi.mock('@/lib/errors', () => ({
  errText: (err: unknown, fallback = '未知错误') =>
    err instanceof Error ? err.message : String(err ?? fallback),
}))

function makeContext(): PluginContext {
  return {
    app: {
      getActiveBookId: () => undefined,
      getActiveChapterId: () => undefined,
      notify: () => {},
    },
    editor: {
      getSelectedText: () => '',
      replaceSelection: () => {},
      insertText: () => {},
      getContent: () => '',
    },
    storage: {
      async get() {
        return undefined
      },
      async set() {},
      async remove() {},
      async keys() {
        return []
      },
    },
  }
}

function makePlugin(overrides: Partial<Plugin & PluginManifest>): Plugin {
  const manifest: PluginManifest = {
    id: 'test-plugin',
    name: '测试插件',
    version: '1.0.0',
    description: '测试用途',
    extensionPoints: ['command-palette'],
    ...overrides,
  }
  return {
    manifest,
    init: vi.fn(),
    getCommands: vi.fn(() => []),
    destroy: vi.fn(),
    ...overrides,
  } as unknown as Plugin
}

describe('validateManifest', () => {
  it('合法 manifest 通过校验', () => {
    const r = validateManifest({
      id: 'my-plugin',
      name: '我的插件',
      version: '1.0.0',
      description: '一个插件',
      extensionPoints: ['command-palette', 'home-header'],
    })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('id 含大写字母拒绝', () => {
    const r = validateManifest({
      id: 'MyPlugin',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: ['command-palette'],
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/id/)
  })

  it('id 含空格拒绝', () => {
    const r = validateManifest({
      id: 'my plugin',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: ['command-palette'],
    })
    expect(r.ok).toBe(false)
  })

  it('version 非 semver 拒绝', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: 'v1.0',
      description: 'x',
      extensionPoints: ['command-palette'],
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/version/)
  })

  it('extensionPoints 含未知值拒绝', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: ['unknown-point' as never],
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/extensionPoints/)
  })

  it('extensionPoints 空数组拒绝', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: [],
    })
    expect(r.ok).toBe(false)
  })

  it('minAppVersion 非 semver 拒绝', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: ['command-palette'],
      minAppVersion: 'abc',
    })
    expect(r.ok).toBe(false)
  })

  it('homepage 非 URL 拒绝', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: '1.0.0',
      description: 'x',
      extensionPoints: ['command-palette'],
      homepage: 'not-a-url',
    })
    expect(r.ok).toBe(false)
  })

  it('合法 prerelease semver 通过', () => {
    const r = validateManifest({
      id: 'p1',
      name: 'x',
      version: '1.0.0-beta.1+build.2',
      description: 'x',
      extensionPoints: ['command-palette'],
    })
    expect(r.ok).toBe(true)
  })
})

describe('PluginManager.register', () => {
  let pm: PluginManagerImpl
  beforeEach(() => {
    pm = new PluginManagerImpl()
  })

  it('合法 manifest 注册成功', () => {
    const p = makePlugin({})
    pm.register(p)
    expect(pm.getPluginStatus('test-plugin')).toBe('installed')
  })

  it('畸形 manifest 拒绝注册,不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = makePlugin({ id: 'Bad Id' })
    pm.register(p)
    expect(pm.getPluginStatus('Bad Id')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('重复注册同 id 跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = makePlugin({})
    pm.register(p)
    pm.register(p)
    expect(warn).toHaveBeenCalled()
    expect(pm.getInstalledPlugins().length).toBe(1)
    warn.mockRestore()
  })

  it('manifest.id 缺失拒绝注册', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = makePlugin({})
    delete (p.manifest as Partial<PluginManifest>).id
    pm.register(p)
    expect(pm.getInstalledPlugins().length).toBe(0)
    warn.mockRestore()
  })
})

describe('PluginManager 错误隔离', () => {
  let pm: PluginManagerImpl
  beforeEach(() => {
    pm = new PluginManagerImpl()
    localStorage.clear()
  })

  it('单插件 init 抛错:标记 error,不 rethrow,不阻塞其他插件', async () => {
    const err = new Error('init boom')
    const badPlugin = makePlugin({ id: 'bad', init: vi.fn(() => { throw err }) })
    const goodPlugin = makePlugin({ id: 'good' })
    pm.register(badPlugin)
    pm.register(goodPlugin)

    await pm.enable('bad', makeContext())
    await pm.enable('good', makeContext())

    expect(pm.getPluginStatus('bad')).toBe('error')
    expect(pm.getPluginStatus('good')).toBe('active')
    const info = pm.getInstalledPlugins().find((p) => p.manifest.id === 'bad')
    expect(info?.error).toBe('init boom')
  })

  it('单插件 getCommands 抛错:跳过该插件,其他插件命令正常枚举', () => {
    const error = console.error
    console.error = vi.fn(() => {})
    const badPlugin = makePlugin({
      id: 'bad',
      getCommands: vi.fn(() => { throw new Error('boom') }),
    })
    const goodPlugin = makePlugin({
      id: 'good',
      getCommands: vi.fn((): PluginCommand[] => [
        {
          id: 'good.cmd',
          label: 'Good',
          extensionPoint: 'command-palette',
          handler: vi.fn(),
        },
      ]),
    })
    pm.register(badPlugin)
    pm.register(goodPlugin)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pm as any).statuses.set('bad', 'active')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pm as any).statuses.set('good', 'active')

    const cmds = pm.getCommandsByExtensionPoint('command-palette')
    expect(cmds.length).toBe(1)
    expect(cmds[0].id).toBe('good.cmd')
    console.error = error
  })

  it('handler 异常由调用方处理(不静默吞)', async () => {
    const badPlugin = makePlugin({
      id: 'bad',
      getCommands: vi.fn((): PluginCommand[] => [
        {
          id: 'bad.cmd',
          label: 'Bad',
          extensionPoint: 'command-palette',
          handler: vi.fn(() => { throw new Error('handler boom') }),
        },
      ]),
    })
    pm.register(badPlugin)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(pm as any).statuses.set('bad', 'active')

    await expect(
      pm.executeCommand('bad.cmd', {
        notify: () => {},
      }),
    ).rejects.toThrow('handler boom')
  })
})

describe('PluginManager 生命周期幂等', () => {
  let pm: PluginManagerImpl
  beforeEach(() => {
    pm = new PluginManagerImpl()
    localStorage.clear()
  })

  it('重复 enable 不重复 init', async () => {
    const init = vi.fn()
    const p = makePlugin({ id: 'p1', init })
    pm.register(p)
    await pm.enable('p1', makeContext())
    await pm.enable('p1', makeContext())
    expect(init).toHaveBeenCalledTimes(1)
    expect(pm.getPluginStatus('p1')).toBe('active')
  })

  it('重复 disable 不重复 destroy', async () => {
    const destroy = vi.fn()
    const p = makePlugin({ id: 'p1', destroy })
    pm.register(p)
    await pm.enable('p1', makeContext())
    pm.disable('p1')
    pm.disable('p1')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(pm.getPluginStatus('p1')).toBe('disabled')
  })

  it('enable error 状态后再次 enable 可重试(非幂等,允许 retry)', async () => {
    let fail = true
    const init = vi.fn(() => {
      if (fail) throw new Error('first fail')
    })
    const p = makePlugin({ id: 'p1', init })
    pm.register(p)
    await pm.enable('p1', makeContext())
    expect(pm.getPluginStatus('p1')).toBe('error')
    fail = false
    await pm.enable('p1', makeContext())
    expect(pm.getPluginStatus('p1')).toBe('active')
    expect(init).toHaveBeenCalledTimes(2)
  })
})

describe('PluginManager storage namespace 隔离', () => {
  let pm: PluginManagerImpl
  beforeEach(() => {
    pm = new PluginManagerImpl()
    localStorage.clear()
  })

  it('两个插件用同 key 互不可见', async () => {
    let vocabStorage: PluginContext['storage'] | undefined
    let taskStorage: PluginContext['storage'] | undefined
    const vocabPlugin = makePlugin({
      id: 'vocab',
      init: (ctx: PluginContext) => {
        vocabStorage = ctx.storage
      },
    })
    const taskPlugin = makePlugin({
      id: 'task',
      init: (ctx: PluginContext) => {
        taskStorage = ctx.storage
      },
    })
    pm.register(vocabPlugin)
    pm.register(taskPlugin)
    await pm.enable('vocab', makeContext())
    await pm.enable('task', makeContext())

    expect(vocabStorage).toBeDefined()
    expect(taskStorage).toBeDefined()

    await vocabStorage!.set('foo', 'vocab-value')
    await taskStorage!.set('foo', 'task-value')

    const v = await vocabStorage!.get<string>('foo')
    const t = await taskStorage!.get<string>('foo')
    expect(v).toBe('vocab-value')
    expect(t).toBe('task-value')

    // 验证 localStorage key 确实带 namespace 前缀
    expect(localStorage.getItem('tw:plugin:vocab:foo')).toBe('"vocab-value"')
    expect(localStorage.getItem('tw:plugin:task:foo')).toBe('"task-value"')
  })

  it('keys() 只返回当前插件 namespace 下的 key', async () => {
    let storage: PluginContext['storage'] | undefined
    const p = makePlugin({
      id: 'p1',
      init: (ctx: PluginContext) => {
        storage = ctx.storage
      },
    })
    pm.register(p)
    await pm.enable('p1', makeContext())

    await storage!.set('a', 1)
    await storage!.set('b', 2)
    // 模拟另一个插件的 namespace 数据
    localStorage.setItem('tw:plugin:other:x', 'other')
    const keys = await storage!.keys()
    expect(keys.sort()).toEqual(['a', 'b'])
  })

  it('remove() 只删除当前 namespace', async () => {
    let storage: PluginContext['storage'] | undefined
    const p = makePlugin({
      id: 'p1',
      init: (ctx: PluginContext) => {
        storage = ctx.storage
      },
    })
    pm.register(p)
    await pm.enable('p1', makeContext())

    await storage!.set('foo', 'mine')
    localStorage.setItem('tw:plugin:other:foo', 'theirs')
    await storage!.remove('foo')
    expect(localStorage.getItem('tw:plugin:p1:foo')).toBeNull()
    expect(localStorage.getItem('tw:plugin:other:foo')).toBe('theirs')
  })
})

describe('PluginManager.subscribe', () => {
  let pm: PluginManagerImpl
  beforeEach(() => {
    pm = new PluginManagerImpl()
  })

  it('状态变化通知订阅者', () => {
    const listener = vi.fn()
    const unsub = pm.subscribe(listener)
    pm.register(makePlugin({}))
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
    pm.register(makePlugin({ id: 'p2' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('listener 抛错不影响其他 listener', () => {
    const error = console.error
    console.error = vi.fn(() => {})
    const l1 = vi.fn(() => { throw new Error('l1 boom') })
    const l2 = vi.fn()
    pm.subscribe(l1)
    pm.subscribe(l2)
    pm.register(makePlugin({}))
    expect(l1).toHaveBeenCalled()
    expect(l2).toHaveBeenCalled()
    console.error = error
  })
})
