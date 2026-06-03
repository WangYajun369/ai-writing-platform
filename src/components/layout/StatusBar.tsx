import { useAtom } from 'jotai'
import { wordCountAtom, isSavingAtom, lastSavedAtom } from '@/stores/uiAtoms.ts'
import { useCurrentBook, useCurrentChapter } from '@/stores/appStore.ts'
import { formatWordCount } from '@/lib/utils.ts'
import { format } from 'date-fns'

export default function StatusBar() {
  const [wordCount] = useAtom(wordCountAtom)
  const [isSaving] = useAtom(isSavingAtom)
  const [lastSaved] = useAtom(lastSavedAtom)
  const currentBook = useCurrentBook()
  const currentChapter = useCurrentChapter()

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
      {currentBook && (
        <span>全书 {formatWordCount(currentBook.wordCount)}</span>
      )}

      <div className="flex-1" />

      {/* 保存状态 */}
      {isSaving && <span className="text-primary animate-pulse">保存中…</span>}
      {!isSaving && lastSaved && (
        <span>已保存 {format(lastSaved, 'HH:mm:ss')}</span>
      )}
    </footer>
  )
}
