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
