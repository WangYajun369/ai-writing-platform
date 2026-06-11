/**
 * StatusBar — 编辑器底部状态栏
 *
 * 展示当前章节信息、全书字数、保存状态与最后保存时间。
 */
import { useAtom } from 'jotai'
import { wordCountAtom, isSavingAtom, lastSavedAtom } from '@/stores/uiAtoms.ts'
import { useCurrentChapter, useCurrentBook } from '@/stores/appStore.ts'
import { formatWordCount } from '@/lib/utils.ts'
import { format } from 'date-fns'

export default function StatusBar() {
  const [wordCount] = useAtom(wordCountAtom)
  const [isSaving] = useAtom(isSavingAtom)
  const [lastSaved] = useAtom(lastSavedAtom)
  const currentChapter = useCurrentChapter()
  const currentBook = useCurrentBook()

  // 全书字数优先从 Zustand book store 读取（删除/恢复章节时立即更新），
  // 打字过程中的实时估算回退到 Jotai atom
  const totalWordCount = currentBook?.wordCount ?? wordCount.total

  return (
    <footer className="border-t bg-card px-4 py-1.5 flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
      {/* 章节信息 */}
      {currentChapter && (
        <>
          <span>{currentChapter.title}</span>
          <span>本章 {formatWordCount(wordCount.chapter)}</span>
        </>
      )}

      {/* 全书字数 */}
      <span>全书 {formatWordCount(totalWordCount)}</span>

      <div className="flex-1" />

      {/* 保存状态 */}
      {isSaving && <span className="text-primary animate-pulse">保存中…</span>}
      {!isSaving && lastSaved && (
        <span>已保存 {format(lastSaved, 'HH:mm:ss')}</span>
      )}
    </footer>
  )
}
