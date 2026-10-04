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

export function useConfigInit() {
  const initAi = useAiStore((s) => s.initFromConfig)
  const initPrefs = usePreferencesStore((s) => s.initFromConfig)
  const initTts = useTtsConfigStore((s) => s.initFromConfig)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 1. 一次性迁移旧 localStorage 数据(幂等,无旧数据则空跑)
        await migrateLegacyLocalStorage()
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
