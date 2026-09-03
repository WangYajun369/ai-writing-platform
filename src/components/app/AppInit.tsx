/**
 * AppInit — 应用初始化组件
 *
 * 组合 version / console-interceptor / theme-font init hooks，
 * 根据独立窗口检测结果路由到对应的面板或主 AppRouter。
 */
import {
  detectWorldWindow,
  detectHistoryWindow,
  detectSummaryWindow,
  detectAiToolboxWindow,
  detectDebugWindow,
  detectVocabWindow,
  detectTasksWindow,
  detectDiaryBookWindow,
} from './windowDetection'
import { useAppVersion } from '@/hooks/useAppVersion'
import { useConsoleInterceptor } from '@/hooks/useConsoleInterceptor'
import { useThemeFontInit } from '@/hooks/useThemeFontInit'
import AppRouter from '@/router'
import WorldbuildingPanel from '@/components/worldbuilding/WorldbuildingPanel'
import SnapshotPanel from '@/components/editor/SnapshotPanel'
import { ChapterSummaryPanel } from '@/components/editor/ChapterSummaryHeader'
import AiToolboxPanel from '@/components/ai/AiToolboxPanel'
import DebugPanel from '@/components/common/DebugPanel'
import VocabularyWindow from '@/components/vocabulary/VocabularyWindow'
import TaskCardsWindow from '@/components/taskCards/TaskCardsWindow'
import DiaryBookPage from '@/components/diary/DiaryBookPage'
import ToastContainer from '@/components/common/ToastContainer'
import AppClosingOverlay from './AppClosingOverlay'
import PluginHost from './PluginHost'

/** 独立窗口容器包装 */
function WindowShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-background"
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

export default function AppInit() {
  // 启动 hooks
  useAppVersion()
  useThemeFontInit()

  // 窗口检测（仅在挂载时求值）
  const worldWin = detectWorldWindow()
  const historyWin = detectHistoryWindow()
  const summaryWin = detectSummaryWindow()
  const aiToolboxWin = detectAiToolboxWindow()
  const debugWin = detectDebugWindow()
  const vocabWin = detectVocabWindow()
  const tasksWin = detectTasksWindow()
  const diaryBookWin = detectDiaryBookWindow()

  // 非调试窗口启用 console 拦截
  useConsoleInterceptor(debugWin.isDebug)

  // 独立窗口路由
  if (historyWin.isHistory && historyWin.chapterId && historyWin.bookId) {
    return (
      <WindowShell>
        <SnapshotPanel
          chapterId={historyWin.chapterId}
          bookId={historyWin.bookId}
          chapterTitle={historyWin.chapterTitle ?? undefined}
        />
      </WindowShell>
    )
  }

  if (summaryWin.isSummary && summaryWin.chapterId && summaryWin.bookId) {
    return (
      <WindowShell>
        <ChapterSummaryPanel
          chapterId={summaryWin.chapterId}
          bookId={summaryWin.bookId}
          chapterTitle={summaryWin.chapterTitle ?? undefined}
        />
      </WindowShell>
    )
  }

  if (aiToolboxWin.isAiToolbox) {
    return (
      <WindowShell>
        <AiToolboxPanel initialToolId="outline-generation" />
      </WindowShell>
    )
  }

  if (vocabWin.isVocab) {
    return (
      <WindowShell>
        <VocabularyWindow />
      </WindowShell>
    )
  }

  if (tasksWin.isTasks) {
    return (
      <WindowShell>
        <TaskCardsWindow />
      </WindowShell>
    )
  }

  if (diaryBookWin.isDiaryBook) {
    return (
      <WindowShell>
        <DiaryBookPage />
      </WindowShell>
    )
  }

  if (debugWin.isDebug) {
    return (
      <WindowShell>
        <DebugPanel />
      </WindowShell>
    )
  }

  if (worldWin.isWorld && worldWin.bookId) {
    return (
      <WindowShell>
        <WorldbuildingPanel bookId={worldWin.bookId} initialTab={worldWin.initialTab} />
      </WindowShell>
    )
  }

  // 主窗口
  return (
    <div
      className="h-screen flex flex-col overflow-hidden bg-background"
      onContextMenu={(e) => e.preventDefault()}
    >
      <PluginHost />
      <AppRouter />
      <ToastContainer />
      <AppClosingOverlay />
    </div>
  )
}
