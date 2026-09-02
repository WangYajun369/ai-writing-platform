/**
 * AppClosingOverlay — 应用退出遮罩
 *
 * 主窗口关闭时后端会发送 agent-status-changed { status: "closing" } 事件，
 * 本组件监听后弹出全屏遮罩阻止用户操作，直至窗口真正关闭。
 * （事件名沿自早期 Agent 架构，现仅用于表达「退出中」）
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
        <span className="text-base font-medium tracking-wide">正在保存并退出...</span>
        <span className="text-xs text-white/50">请稍候</span>
      </div>
    </div>
  )
}
