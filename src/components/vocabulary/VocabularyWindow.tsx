/**
 * 英语字典 · 生词本 — 独立窗口
 *
 * 顶部：标题 + 离线词典状态（导入入口）+ 今日摘要 + 关闭
 * Tab：生词本 / 今日复习（带到期角标）/ 统计
 * 数据：useVocabStore 全量管理；监听 vocab-due-updated 事件自动刷新
 *      （该事件由后端在任何影响到期数的写操作后广播，主窗口徽标同步刷新）
 */
import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import {
  BookOpenIcon,
  PlayCircleIcon,
  BarChart3Icon,
  LanguagesIcon,
  BookMarkedIcon,
  DatabaseIcon,
  LoaderIcon,
  SparklesIcon,
  Volume2Icon,
} from 'lucide-react'
import { dictApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useVocabStore } from '@/stores/vocabStore'
import { setVocabWindowOpen } from '@/plugins/dictionary/windowState'
import type { DictStatus } from '@/types'
import WordBookTab from './tab/WordBookTab'
import ReviewTab from './tab/ReviewTab'
import StatsTab from './tab/StatsTab'
import SpeakSettingsDialog from './dialog/SpeakSettingsDialog'
import ToastContainer from '@/components/common/ToastContainer'

type TabKey = 'book' | 'review' | 'stats'

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'review', label: '今日复习', icon: <PlayCircleIcon className="h-4 w-4" /> },
  { key: 'book', label: '生词本', icon: <BookOpenIcon className="h-4 w-4" /> },
  { key: 'stats', label: '统计', icon: <BarChart3Icon className="h-4 w-4" /> },
]

export default function VocabularyWindow() {
  const [tab, setTab] = useState<TabKey>('book')
  const [dict, setDict] = useState<DictStatus | null>(null)
  const [importing, setImporting] = useState(false)
  const [ttsOpen, setTtsOpen] = useState(false)
  const stats = useVocabStore((s) => s.stats)
  const refreshAll = useVocabStore((s) => s.refreshAll)

  // 进入窗口：置激活态 + 首次全量加载
  useEffect(() => {
    setVocabWindowOpen(true)
    void refreshAll()
    return () => setVocabWindowOpen(false)
  }, [refreshAll])

  // 词典状态
  useEffect(() => {
    void dictApi.status().then(setDict).catch(() => setDict(null))
  }, [])

  // 后端广播到期变化 → 刷新（窗口内操作与主窗口操作都会触发）
  useEffect(() => {
    const un = listen('vocab-due-updated', () => {
      void refreshAll()
    })
    return () => {
      void un.then((fn) => fn())
    }
  }, [refreshAll])

  // 有待复习时默认进入复习页
  useEffect(() => {
    if (stats && stats.dueToday > 0 && tab === 'book') setTab('review')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats])

  /** 导入离线词典（ECDICT sqlite） */
  async function handleImportDict() {
    try {
      const selected = await open({
        title: '选择离线词典文件（ECDICT sqlite）',
        multiple: false,
        directory: false,
        filters: [
          { name: '词典数据库', extensions: ['sqlite', 'sqlite3', 'db'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      })
      if (!selected) return
      setImporting(true)
      const status = await dictApi.import(selected as string)
      setDict(status)
      if (status.installed) {
        toast.success(`离线词典已就绪（${status.wordCount.toLocaleString()} 词条）`)
      } else {
        toast.error('词典导入失败：文件格式不受支持')
      }
    } catch (err) {
      toast.error(typeof err === 'string' ? err : '词典导入失败')
    } finally {
      setImporting(false)
    }
  }

  const dueCount = stats?.dueToday ?? 0

  return (
    <div className="h-full flex flex-col bg-[linear-gradient(160deg,#0b1220_0%,#0f172a_55%,#131c31_100%)] text-zinc-100">
      {/* ── 顶栏 ── */}
      <header className="flex items-center gap-3 px-5 h-14 shrink-0 border-b border-white/8 bg-white/3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-sky-500/90 to-indigo-600/90 shadow-lg shadow-sky-900/40">
            <LanguagesIcon className="h-4.5 w-4.5 text-white" size={18} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-wide">英语字典</div>
            <div className="text-[10.5px] text-zinc-400">生词本 · 艾宾浩斯复习</div>
          </div>
        </div>

        <div className="flex-1" />

        {/* 词典状态 */}
        <button
          onClick={handleImportDict}
          title={
            dict?.installed
              ? `离线词库已就绪：${dict.wordCount.toLocaleString()} 词条`
              : '未安装离线词典，点击导入 ECDICT 词库（无网络也可查词）'
          }
          className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11.5px] transition hover:bg-white/10"
        >
          {importing ? (
            <LoaderIcon className="h-3.5 w-3.5 animate-spin text-sky-400" />
          ) : dict?.installed ? (
            <DatabaseIcon className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <DatabaseIcon className="h-3.5 w-3.5 text-amber-400" />
          )}
          <span className={cn('max-w-52 truncate', dict?.installed ? 'text-zinc-300' : 'text-amber-200/90')}>
            {importing
              ? '导入中…'
              : dict?.installed
                ? `离线词库 · ${(dict.wordCount / 10000).toFixed(1)} 万词`
                : '离线词库未安装 · 点击导入'}
          </span>
        </button>

        {/* 朗读设置（豆包语音合成） */}
        <button
          onClick={() => setTtsOpen(true)}
          title="朗读设置：配置豆包语音 API Key 后，单词、词组与例句即可点击喇叭朗读"
          className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11.5px] text-zinc-300 transition hover:bg-white/10"
        >
          <Volume2Icon className="h-3.5 w-3.5 text-sky-400" />
          朗读设置
        </button>

        {/* 今日摘要 */}
        <div className="hidden sm:flex items-center gap-1.5">
          <span
            className={cn(
              'flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium',
              dueCount > 0 ? 'bg-red-500/15 text-red-300 border border-red-500/25' : 'bg-white/5 text-zinc-400 border border-white/10',
            )}
            title="今日待复习单词数"
          >
            <PlayCircleIcon className="h-3.5 w-3.5" />
            {dueCount > 0 ? `待复习 ${dueCount}` : '今日复习已清空'}
          </span>
          <span className="flex items-center gap-1 rounded-lg bg-white/5 border border-white/10 px-2.5 py-1.5 text-[11.5px] text-zinc-300" title="今日已复习次数">
            <SparklesIcon className="h-3.5 w-3.5 text-sky-400" />
            已复习 {stats?.reviewedToday ?? 0}
          </span>
        </div>

      </header>

      {/* ── Tab 栏 ── */}
      <div className="flex items-center gap-1 px-4 pt-3 shrink-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-[13px] transition',
              tab === t.key
                ? 'bg-white/7 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                : 'text-zinc-400 hover:bg-white/4 hover:text-zinc-200',
            )}
          >
            {t.icon}
            {t.label}
            {t.key === 'review' && dueCount > 0 && (
              <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                {dueCount > 99 ? '99+' : dueCount}
              </span>
            )}
          </button>
        ))}
        <div className="ml-3 hidden items-center gap-1 text-[11px] text-zinc-500 md:flex" title="复习进度">
          <BookMarkedIcon className="h-3 w-3" />
          共 {stats?.total ?? 0} 词 · 掌握 {(stats?.mastered ?? 0).toLocaleString()}
        </div>
      </div>

      {/* ── 内容区 ── */}
      <div className="flex-1 min-h-0 px-4 pb-4">
        <div className="h-full overflow-hidden rounded-b-xl rounded-tr-xl border border-white/8 bg-black/20">
          {tab === 'book' && <WordBookTab />}
          {tab === 'review' && <ReviewTab onGotoBook={() => setTab('book')} />}
          {tab === 'stats' && <StatsTab />}
        </div>
      </div>

      <ToastContainer />
      {/* 朗读设置弹窗（豆包语音合成 API Key 凭证） */}
      <SpeakSettingsDialog open={ttsOpen} onClose={() => setTtsOpen(false)} />
    </div>
  )
}
