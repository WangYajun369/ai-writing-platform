/**
 * EditorLayout — 编辑器页根布局容器
 *
 * 供编辑主页面使用：撑满窗口高度、纵向 flex 排列、溢出裁切；
 * 具体的内容（章节工具栏 / 编辑区 / 状态栏）由父组件作为 children 传入。
 */
import type { ReactNode } from 'react'

/** 编辑器布局容器，负责滚动容器 */
export default function EditorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {children}
    </div>
  )
}
