import type { ReactNode } from 'react'

/** 编辑器布局容器，负责滚动容器 */
export default function EditorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {children}
    </div>
  )
}
