/**
 * useAppVersion — 启动时获取并保存应用版本号
 *
 * 由应用根初始化（AppInit）挂载调用：通过 Tauri getVersion 读取版本号，
 * 写入 aiStore.appVersion，供书库页底部状态栏、设置页等展示。
 * 非 Tauri 环境（如 Web 预览）或读取失败时回退为 '0.0.0-dev'；
 * 组件卸载后异步结果不再写入（cancelled 守卫）。
 */
import { useEffect } from 'react'
import { useAiStore } from '@/stores/aiStore'

/**
 * 启动时从 Tauri 获取应用版本号
 */
export function useAppVersion() {
  const setAppVersion = useAiStore((s) => s.setAppVersion)

  useEffect(() => {
    let cancelled = false
    import('@tauri-apps/api/app').then(({ getVersion }) => {
      getVersion().then((v) => {
        if (!cancelled) setAppVersion(v)
      }).catch(() => {
        if (!cancelled) setAppVersion('0.0.0-dev')
      })
    }).catch(() => {
      if (!cancelled) setAppVersion('0.0.0-dev')
    })
    return () => { cancelled = true }
  }, [setAppVersion])
}
