/**
 * AppClosingOverlay — 应用退出遮罩
 *
 * 当 Tauri 后端发送 agent-status-changed { status: "closing" } 时弹出，
 * 覆盖全屏阻止用户操作，等后端清理完 Agent 服务后自动消失（窗口关闭）。
 */
import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

export default function AppClosingOverlay() {
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const unlisten = listen<{ status: string; message: string }>(
      'agent-status-changed',
      (event) => {
        if (event.payload.status === 'closing') {
          setClosing(true)
        }
      }
    )
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  if (!closing) return null

  return (
    <div className="fixed inset-0 z-9999 flex flex-col items-center justify-center gap-4 bg-black/70 backdrop-blur-sm select-none">
      {/* 旋转加载圈 */}
      <div className="w-10 h-10 border-[3px] border-white/30 border-t-white rounded-full animate-spin" />

      {/* 提示文字 */}
      <div className="flex flex-col items-center gap-1 text-white/90">
        <span className="text-base font-medium tracking-wide">正在关闭服务...</span>
        <span className="text-xs text-white/50">请稍候，正在清理 Agent 后端</span>
      </div>
    </div>
  )
}
