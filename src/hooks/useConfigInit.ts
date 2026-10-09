/**
 * useConfigInit — 应用配置初始化 hook(v1.9 架构优化)
 *
 * 启动流程:
 * 1. 一次性迁移旧 localStorage 数据到后端 app_config 表(幂等)
 * 2. 触发 4 个 store 的 `initFromConfig()` 从后端加载真实配置
 *
 * 由 AppInit 在主窗口挂载调用。子窗口不需要重复调用(配置已写入后端,
 * 各窗口的 store 由 zustand 跨窗口共享内存,但子窗口需独立初始化)
 *
 * 失败静默:任一步失败不阻塞 UI,store 保留默认值。
 */
import { useEffect } from 'react'
import { migrateLegacyLocalStorage } from '@/lib/configClient'
import { useAiStore } from '@/stores/aiStore'
import { usePreferencesStore } from '@/stores/preferencesStore'
import { useTtsConfigStore } from '@/stores/ttsConfig'

/**
 * 模块级一次性标记：legacy localStorage 迁移只需在**首个**窗口执行一次。
 *
 * 修复前 AppInit 在每个窗口（主窗口 + AI 工具箱 / 字典 / 任务卡 等 7 个子窗口）
 * 都会调用本 hook，导致每次开子窗口都重复跑一遍迁移 IPC 并再次清理 localStorage，
 * 存在并发竞态。后端幂等不代表前端无代价 —— 这里用模块级 flag 收敛为一次。
 */
let legacyMigrationDone = false

/** 测试用途：重置迁移标记 */
export function __resetLegacyMigrationFlag(): void {
  legacyMigrationDone = false
}

export function useConfigInit() {
  const initAi = useAiStore((s) => s.initFromConfig)
  const initPrefs = usePreferencesStore((s) => s.initFromConfig)
  const initTts = useTtsConfigStore((s) => s.initFromConfig)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 1. 一次性迁移旧 localStorage 数据(幂等,无旧数据则空跑);仅首个窗口执行
        if (!legacyMigrationDone) {
          legacyMigrationDone = true
          await migrateLegacyLocalStorage()
        }
      } catch {
        /* 迁移失败不阻塞启动 */
      }
      if (cancelled) return
      try {
        // 2. 并行触发 4 段配置加载(各 store 内部失败静默)
        await Promise.allSettled([initAi(), initPrefs(), initTts()])
      } catch {
        /* 全部失败也保留默认值 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [initAi, initPrefs, initTts])
}
