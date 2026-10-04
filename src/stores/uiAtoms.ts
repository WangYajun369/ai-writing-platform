/**
 * 全局 UI 原子状态（Jotai）
 *
 * 集中定义跨组件、跨窗口共享的轻量 UI 状态（原子）：
 * - 编辑器域：实例引用、聚焦、滚动/光标位置、保存态、字数、diff 模式、刷新计数；
 * - 布局域：侧边栏 / AI 面板 / 版本历史面板 / 专注模式 / 搜索面板开关；
 * - 模态栈与悬浮关键词；
 * - 各独立子窗口「是否打开」标记（由窗口事件同步，供主窗口入口按钮高亮）。
 * 用法：const [open, setOpen] = useAtom(aiPanelOpenAtom)。
 */
import { atom } from 'jotai'
import type { Editor } from '@tiptap/react'
import type { DiffViewMode } from '../types'

// ──────────────────────────────────────────────────────────────────
// 编辑器会话状态收敛（v1.9 架构优化）
// ──────────────────────────────────────────────────────────────────
// 原本编辑器会话的 8 个高耦合 atom 各自独立，跨组件传递时容易丢失一致性；
// 收敛为 editorStateAtom 单一真源 + 8 个派生 atom（读写都委托），
// 既有调用点零迁移：useAtom(editorFocusAtom) 行为不变。
// 新代码推荐用 editorStateAtom 整体访问/更新，避免多次 set 触发多次重渲染。
// ──────────────────────────────────────────────────────────────────

/** 编辑器会话状态（单一真源）。 */
export type EditorSessionState = {
  /** 编辑器是否聚焦 */
  focus: boolean
  /** TipTap 编辑器实例（供工具栏等外部组件使用） */
  instance: Editor | null
  /** Diff 对比视图模式 */
  diffViewMode: DiffViewMode
  /** 正在保存 */
  isSaving: boolean
  /** 最后保存时间 */
  lastSaved: Date | null
  /** 字数统计 */
  wordCount: { chapter: number; total: number }
  /** 编辑器滚动位置（用于恢复上次编辑位置） */
  scrollPosition: number
  /** 编辑器光标/选区位置 { from: number, to: number } */
  cursorPosition: { from: number; to: number } | null
}

/** 编辑器会话状态单一真源。
 *
 * 默认值与原 8 个独立 atom 的默认值完全一致。
 * 推荐通过 `useAtom(editorStateAtom)` 整体读写，避免多次 set 触发多次重渲染。
 * 既有 8 个派生 atom（editorFocusAtom 等）零迁移保留，调用点行为不变。 */
export const editorStateAtom = atom<EditorSessionState>({
  focus: false,
  instance: null,
  diffViewMode: 'side-by-side',
  isSaving: false,
  lastSaved: null,
  wordCount: { chapter: 0, total: 0 },
  scrollPosition: 0,
  cursorPosition: null,
})

/** 编辑器是否聚焦（派生 atom，委托到 editorStateAtom）。
 * 旧调用点零迁移：useAtom(editorFocusAtom) 行为不变。 */
export const editorFocusAtom = atom<boolean, [boolean], void>(
  (get) => get(editorStateAtom).focus,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), focus: value }),
)

/** TipTap 编辑器实例（派生 atom，委托到 editorStateAtom） */
export const editorInstanceAtom = atom<Editor | null, [Editor | null], void>(
  (get) => get(editorStateAtom).instance,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), instance: value }),
)

/** Diff 对比视图模式（派生 atom，委托到 editorStateAtom） */
export const diffViewModeAtom = atom<DiffViewMode, [DiffViewMode], void>(
  (get) => get(editorStateAtom).diffViewMode,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), diffViewMode: value }),
)

// ──────────────────────────────────────────────────────────────────
// 布局开关状态收敛（v1.9 架构优化）
// ──────────────────────────────────────────────────────────────────
// 原本 6 个布局/UI 开关 atom 各自独立（sidebarOpen / aiPanelOpen /
// historyPanelOpen / zenMode / searchOpen / hoverKeyword），收敛为
// layoutStateAtom 单一真源 + 6 个派生 atom（读写都委托）。
// 既有调用点零迁移：useAtom(sidebarOpenAtom) 行为不变。
// 新代码推荐用 layoutStateAtom 整体读写，便于实现「专注模式自动收起侧栏」
// 等跨字段约束。
// ──────────────────────────────────────────────────────────────────

/** 布局/UI 开关状态（单一真源）。 */
export type LayoutState = {
  /** 侧边栏是否展开 */
  sidebar: boolean
  /** AI 对话面板是否展开 */
  aiPanel: boolean
  /** 版本历史面板是否展开 */
  historyPanel: boolean
  /** 专注模式（zen mode） */
  zen: boolean
  /** 搜索面板是否展开 */
  search: boolean
  /** 当前悬浮速览关键词（null 表示无悬浮） */
  hoverKeyword: string | null
}

/** 布局开关状态单一真源。
 *
 * 默认值与原 6 个独立 atom 的默认值完全一致。
 * 推荐通过 `useAtom(layoutStateAtom)` 整体读写，便于实现跨字段约束
 * （如「开启 zen 模式时自动收起侧栏」）。
 * 既有 6 个派生 atom 零迁移保留，调用点行为不变。 */
export const layoutStateAtom = atom<LayoutState>({
  sidebar: true,
  aiPanel: false,
  historyPanel: false,
  zen: false,
  search: false,
  hoverKeyword: null,
})

/** 侧边栏是否展开（派生 atom，委托到 layoutStateAtom）。
 * 旧调用点零迁移：useAtom(sidebarOpenAtom) 行为不变。 */
export const sidebarOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(layoutStateAtom).sidebar,
  (get, set, value) =>
    set(layoutStateAtom, { ...get(layoutStateAtom), sidebar: value }),
)

/** AI 对话面板是否展开（派生 atom，委托到 layoutStateAtom） */
export const aiPanelOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(layoutStateAtom).aiPanel,
  (get, set, value) =>
    set(layoutStateAtom, { ...get(layoutStateAtom), aiPanel: value }),
)

/** 版本历史面板是否展开（派生 atom，委托到 layoutStateAtom） */
export const historyPanelOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(layoutStateAtom).historyPanel,
  (get, set, value) =>
    set(layoutStateAtom, { ...get(layoutStateAtom), historyPanel: value }),
)

/** 专注模式（派生 atom，委托到 layoutStateAtom） */
export const zenModeAtom = atom<boolean, [boolean], void>(
  (get) => get(layoutStateAtom).zen,
  (get, set, value) => set(layoutStateAtom, { ...get(layoutStateAtom), zen: value }),
)

/** 当前悬浮速览关键词（派生 atom，委托到 layoutStateAtom） */
export const hoverKeywordAtom = atom<string | null, [string | null], void>(
  (get) => get(layoutStateAtom).hoverKeyword,
  (get, set, value) =>
    set(layoutStateAtom, { ...get(layoutStateAtom), hoverKeyword: value }),
)

/** 模态框栈（用于嵌套弹窗管理）。
 *  独立保留：模态栈是 push/pop 语义，与开关状态模型不同，不并入 layoutStateAtom。 */
export const modalStackAtom = atom<string[]>([])

/** 正在保存（派生 atom，委托到 editorStateAtom） */
export const isSavingAtom = atom<boolean, [boolean], void>(
  (get) => get(editorStateAtom).isSaving,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), isSaving: value }),
)

/** 最后保存时间（派生 atom，委托到 editorStateAtom） */
export const lastSavedAtom = atom<Date | null, [Date | null], void>(
  (get) => get(editorStateAtom).lastSaved,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), lastSaved: value }),
)

/** 字数统计（派生 atom，委托到 editorStateAtom） */
export const wordCountAtom = atom<
  { chapter: number; total: number },
  [{ chapter: number; total: number }],
  void
>(
  (get) => get(editorStateAtom).wordCount,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), wordCount: value }),
)

/** 搜索面板（派生 atom，委托到 layoutStateAtom） */
export const searchOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(layoutStateAtom).search,
  (get, set, value) =>
    set(layoutStateAtom, { ...get(layoutStateAtom), search: value }),
)

// ──────────────────────────────────────────────────────────────────
// 内容刷新信号（v1.9 跨组件契约类型化）
// ──────────────────────────────────────────────────────────────────
// 原本 contentRefreshAtom 是裸计数器 atom<number>，写入方用
// setContentRefresh((v) => v + 1) 递增，读取方（RichTextEditor）把它作为
// useEffect 依赖触发章节内容重载。
//
// 这是 Jotai 内组件间通信的合法用法，但裸计数器有两个问题：
//   1. 契约隐式：写入方与读取方只靠「递增数字」约定，无类型约束；
//   2. 信号无来源：读取方无法区分是 snapshot 恢复、editor 切换还是外部触发，
//      无法按来源过滤或日志诊断。
//
// 改造为类型化信号 atom<ContentRefreshSignal>：
//   - 信号带 source 字段，写入方声明来源（'snapshot' | 'editor' | 'manual'）；
//   - nonce 单调递增，保证 React useEffect 依赖触发重渲染；
//   - 新增 triggerContentRefreshAtom 派生 atom 作为写入方专用入口，
//     既有 setContentRefresh(v => v+1) 调用点改为 trigger('snapshot')；
//   - 读取方 useAtom(contentRefreshAtom) 仍工作，useEffect 依赖改用
//     contentRefresh.nonce 表达「只关心变化」的意图。
// ──────────────────────────────────────────────────────────────────

/** 内容刷新的触发来源。 */
export type ContentRefreshSource =
  | 'snapshot' // 快照恢复（SnapshotPanel / history-snapshot-restored 事件）
  | 'editor' // 编辑器内部触发（如手动刷新按钮）
  | 'manual' // 其他外部触发（兜底）

/** 内容刷新信号。 */
export type ContentRefreshSignal = {
  /** 触发来源：读取方可按来源过滤或日志诊断 */
  source: ContentRefreshSource
  /** 单调递增的 nonce：用于 useEffect 依赖触发 React 重渲染 */
  nonce: number
}

/** 内容刷新信号 atom（读取方用）。
 *
 * 默认 `{ source: 'manual', nonce: 0 }`。
 * 读取方推荐：`const [signal] = useAtom(contentRefreshAtom)`，
 * 然后 useEffect 依赖数组用 `signal.nonce` 触发重渲染。 */
export const contentRefreshAtom = atom<ContentRefreshSignal>({
  source: 'manual',
  nonce: 0,
})

/** 触发内容刷新的派生 atom（写入方专用）。
 *
 * 用法：
 * ```ts
 * const [, trigger] = useAtom(triggerContentRefreshAtom)
 * trigger('snapshot')
 * ```
 *
 * 内部递增 contentRefreshAtom 的 nonce，并记录 source。
 * 取代旧式 `setContentRefresh((v) => v + 1)`，契约类型化。 */
export const triggerContentRefreshAtom = atom<null, [ContentRefreshSource], void>(
  () => null,
  (get, set, source) =>
    set(contentRefreshAtom, {
      source,
      nonce: get(contentRefreshAtom).nonce + 1,
    }),
)

/** 编辑器滚动位置（派生 atom，委托到 editorStateAtom） */
export const editorScrollPositionAtom = atom<number, [number], void>(
  (get) => get(editorStateAtom).scrollPosition,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), scrollPosition: value }),
)

/** 编辑器光标/选区位置 { from: number, to: number }（派生 atom，委托到 editorStateAtom） */
export const editorCursorPositionAtom = atom<
  { from: number; to: number } | null,
  [{ from: number; to: number } | null],
  void
>(
  (get) => get(editorStateAtom).cursorPosition,
  (get, set, value) =>
    set(editorStateAtom, { ...get(editorStateAtom), cursorPosition: value }),
)

// ──────────────────────────────────────────────────────────────────
// 独立窗口标记收敛（v1.9 架构优化）
// ──────────────────────────────────────────────────────────────────
// 原本 5 个独立窗口各为一个 atom（aiToolbox / history / world / summary / debug），
// 各自的 atom 都通过 useAtom 直连 Jotai store，存在两个问题：
//   1. 粒度散乱：新增一个独立窗口就要新增一个 atom，使用方也要分别 import；
//   2. 状态树分裂：跨窗口的「同时只允许打开一个 debug 类窗口」等约束需要在
//      多个 atom 间手写协调，无单一真源。
// 收敛策略（渐进式，零破坏）：
//   - 新增 windowOpenStateAtom 作为单一真源，承载全部独立窗口开关；
//   - 5 个旧 atom 改为派生 writable atom（读写都委托到 windowOpenStateAtom），
//     既有调用点（useAtom / useAtomValue / useSetAtom / store.get / store.set）
//     行为完全一致，无需迁移；
//   - 新代码推荐用 windowOpenStateAtom + WindowLabel 类型，新增窗口只需在
//     WindowLabel 联合类型追加成员，不再需要新建 atom。
// ──────────────────────────────────────────────────────────────────

/** 独立窗口标签（与 src/lib/windowDetection.ts 的窗口 URL query 对应）。
 *  新增独立窗口时在此联合类型追加成员即可，无需新建 atom。 */
export type WindowLabel = 'aiToolbox' | 'history' | 'world' | 'summary' | 'debug'

/** 全部独立窗口开关的单一真源。
 *
 * 默认全部 false；某窗口被打开时由对应的派生 atom 或本 atom 直接写入 true，
 * 关闭时写回 false。跨窗口的协调逻辑（如「同时只允许一个调试窗口」）应读本 atom。 */
export const windowOpenStateAtom = atom<Record<WindowLabel, boolean>>({
  aiToolbox: false,
  history: false,
  world: false,
  summary: false,
  debug: false,
})

/** AI 工具箱独立窗口是否打开（派生 atom，委托到 windowOpenStateAtom）。
 * 旧调用点零迁移：useAtom / useAtomValue / useSetAtom 行为不变。 */
export const aiToolboxWindowOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(windowOpenStateAtom).aiToolbox,
  (get, set, value) =>
    set(windowOpenStateAtom, { ...get(windowOpenStateAtom), aiToolbox: value }),
)

/** 版本历史独立窗口是否打开（派生 atom，委托到 windowOpenStateAtom） */
export const historyWindowOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(windowOpenStateAtom).history,
  (get, set, value) =>
    set(windowOpenStateAtom, { ...get(windowOpenStateAtom), history: value }),
)

/** 世界观资料库独立窗口是否打开（派生 atom，委托到 windowOpenStateAtom） */
export const worldWindowOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(windowOpenStateAtom).world,
  (get, set, value) =>
    set(windowOpenStateAtom, { ...get(windowOpenStateAtom), world: value }),
)

/** 章节总结独立窗口是否打开（派生 atom，委托到 windowOpenStateAtom） */
export const summaryWindowOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(windowOpenStateAtom).summary,
  (get, set, value) =>
    set(windowOpenStateAtom, { ...get(windowOpenStateAtom), summary: value }),
)

/** 调试控制台独立窗口是否打开（派生 atom，委托到 windowOpenStateAtom） */
export const debugWindowOpenAtom = atom<boolean, [boolean], void>(
  (get) => get(windowOpenStateAtom).debug,
  (get, set, value) =>
    set(windowOpenStateAtom, { ...get(windowOpenStateAtom), debug: value }),
)

