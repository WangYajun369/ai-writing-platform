/**
 * 单词关联图谱弹层（全屏）
 *
 * 后端 `vocab_relations_graph` 输出节点（全库词 + 可选潜在关联叶子）与无向去重边，
 * 前端用 d3-force 力导向布局渲染：节点按掌握状态着色、边按关联类型着色。
 * 交互：滚轮缩放 / 拖拽平移 / 节点拖拽，单击节点出信息卡，双击打开单词详情。
 */
import { useEffect, useRef, useState } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import { XIcon, NetworkIcon, LoaderIcon, RefreshCwIcon, PlusIcon, Link2Icon, ZoomInIcon, ZoomOutIcon, Maximize2Icon } from 'lucide-react'
import { dictApi, vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type {
  VocabGraph,
  VocabGraphEdge,
  VocabGraphNode,
  VocabMeaning,
  VocabRelationType,
  VocabStatus,
  VocabWord,
} from '@/types'
import {
  fitViewToNodes,
  graphNodeRadius,
  meaningsSummary,
  parseDictTranslation,
  STATUS_TEXT,
  zoomViewAt,
} from '../vocab-utils'

type SimNode = SimulationNodeDatum & VocabGraphNode
type SimLink = SimulationLinkDatum<SimNode> & { relationType: string }

interface Props {
  open: boolean
  onClose: () => void
  /** 双击已收录节点：打开单词详情 */
  onOpenWord: (wordId: string) => void
}

type Filter = VocabStatus | 'all'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'learning', label: '学习中' },
  { key: 'mastered', label: '已掌握' },
  { key: 'suspended', label: '暂停' },
]

/** 节点着色：学习中 sky / 已掌握 emerald / 暂停 zinc / 潜在关联灰虚线 */
const NODE_FILL: Record<string, string> = {
  learning: '#38bdf8',
  mastered: '#34d399',
  suspended: '#a1a1aa',
  potential: 'rgba(113,113,122,0.12)',
}
/** 边着色：近义 sky / 反义 red / 派生 violet / 变形 emerald / 手动 amber */
const EDGE_COLOR: Record<string, string> = {
  synonym: '#38bdf8',
  antonym: '#f87171',
  derived: '#a78bfa',
  inflection: '#34d399',
  manual: '#fbbf24',
}
const EDGE_TYPE_TEXT: Record<string, string> = {
  synonym: '近义',
  antonym: '反义',
  derived: '派生',
  inflection: '变形',
  manual: '手动',
}

export default function WordGraphDialog({ open, onClose, onOpenWord }: Props) {
  const [graph, setGraph] = useState<VocabGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [includePotential, setIncludePotential] = useState(false)
  const [nodes, setNodes] = useState<SimNode[]>([])
  const [links, setLinks] = useState<SimLink[]>([])
  const [selected, setSelected] = useState<VocabGraphNode | null>(null)
  const [selectedWord, setSelectedWord] = useState<VocabWord | null>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [nonce, setNonce] = useState(0)
  // 信息卡内的表单状态
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftType, setDraftType] = useState<VocabRelationType>('synonym')

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null)
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  // 单击信息卡的延迟定时器：延迟内发生双击则取消，避免双击时闪出信息卡
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 数据加载（打开 / 筛选 / 潜在关联开关变化时重取）
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSelected(null)
    vocabApi
      .relationsGraph(includePotential, filter)
      .then(setGraph)
      .catch((err) => {
        toast.error(errText(err, '加载关联图谱失败'))
        setGraph(null)
      })
      .finally(() => setLoading(false))
  }, [open, filter, includePotential, nonce])

  // 力导向布局：数据到达后重建模拟，tick 驱动重渲染（每 2 次 tick 渲染一次节流，
  // 收敛时兜底最终渲染并做一次自适应 fit）
  useEffect(() => {
    if (!graph) return
    const el = wrapRef.current
    const w = el?.clientWidth ?? 960
    const h = el?.clientHeight ?? 600
    const simNodes: SimNode[] = graph.nodes.map((n) => ({ ...n }))
    const simLinks: SimLink[] = graph.edges.map((e: VocabGraphEdge) => ({
      source: e.source,
      target: e.target,
      relationType: e.relationType,
    }))
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(72)
          .strength(0.5),
      )
      .force('charge', forceManyBody().strength(-160))
      .force('center', forceCenter(w / 2, h / 2))
      .force(
        'collide',
        forceCollide<SimNode>((d) => graphNodeRadius(d) + 16),
      )
      .alphaDecay(0.035)
    let tickCount = 0
    let fitted = false
    sim.on('tick', () => {
      tickCount += 1
      if (tickCount % 2 === 0) setNodes([...simNodes])
    })
    sim.on('end', () => {
      setNodes([...simNodes])
      // 每次数据加载/重建模拟后仅 fit 一次；用户手动缩放后不覆盖
      if (!fitted) {
        fitted = true
        const box = wrapRef.current
        if (box) setView(fitViewToNodes(simNodes, box.clientWidth, box.clientHeight))
      }
    })
    simRef.current = sim
    setNodes(simNodes)
    setLinks(simLinks)
    setView({ k: 1, x: 0, y: 0 })
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [graph])

  // 滚轮缩放（向光标位置；原生监听以便 preventDefault）
  // deps 必须包含 graph?.nodes.length：SVG 条件渲染在数据到达后才挂载，
  // 仅 [open] 会让 effect 在 svgRef.current 还是 null 时就执行，监听器永远绑不上。
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !open) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView((v) => zoomViewAt(v, mx, my, e.deltaY < 0))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [open, graph?.nodes.length])

  // 容器尺寸变化时重新居中（模拟未收敛则只更新中心力，由继续的 tick 生效）
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !open) return
    const ro = new ResizeObserver(() => {
      const sim = simRef.current
      if (!sim) return
      sim.force('center', forceCenter(el.clientWidth / 2, el.clientHeight / 2))
      if (sim.alpha() < 0.05) sim.alpha(0.3).restart()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // 卸载时清理单击延迟定时器
  useEffect(
    () => () => {
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    },
    [],
  )

  // 键盘快捷键：+/- 缩放、F 全景适应、Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // 跳过输入框聚焦时的快捷键（输入框内 +/-/F 不应触发缩放）
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (e.key === '+' || e.key === '=' || e.key === 'PageUp') {
        e.preventDefault()
        zoomAtCenter(true)
      } else if (e.key === '-' || e.key === '_' || e.key === 'PageDown') {
        e.preventDefault()
        zoomAtCenter(false)
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        fitAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, graph?.nodes.length, view.k])

  // 信息卡：点击已收录节点时拉取完整词条（音标 / 释义摘要）
  useEffect(() => {
    if (!selected || selected.status === 'potential') {
      setSelectedWord(null)
      return
    }
    vocabApi
      .get(selected.id)
      .then(setSelectedWord)
      .catch(() => setSelectedWord(null))
  }, [selected])

  // 选中节点切换时清空表单草稿
  useEffect(() => {
    setDraft('')
    setDraftType('synonym')
  }, [selected])

  /** 收录 potential 节点的词进生词本（先查 ECDICT 带音标/释义），
   *  收录后 vocabApi.add 后端会自动 sync_auto_relations 双向补齐关联，
   *  此处仅触发图谱刷新即可看到新节点 + 新边。 */
  async function collectPotentialWord(w: string) {
    if (busy) return
    setBusy(true)
    try {
      let phonetic: string | undefined
      let meanings: VocabMeaning[] | undefined
      try {
        const res = await dictApi.lookup(w)
        if (res.hit) {
          if (res.hit.phonetic) phonetic = res.hit.phonetic
          const parsed = parseDictTranslation(res.hit)
          if (parsed.length) meanings = parsed
        }
      } catch {
        /* 离线词库不可用时静默降级 */
      }
      await vocabApi.add({ word: w, phonetic, meanings, source: 'related' })
      toast.success(
        meanings?.length
          ? `已收录「${w}」（已带出离线词典释义），图谱将自动补全关联`
          : `已收录「${w}」，图谱将自动补全关联`,
      )
      setSelected(null)
      setNonce((n) => n + 1)
    } catch (err) {
      toast.error(errText(err, '收录失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 给已收录节点手动加关联词（成功后刷新图谱，新关系自动布局） */
  async function addManualRelation() {
    if (!selected || selected.status === 'potential' || busy) return
    const related = draft.trim()
    if (!related) return
    setBusy(true)
    try {
      await vocabApi.relationsAdd(selected.id, related, draftType)
      setDraft('')
      toast.success(`已为「${selected.word}」添加${EDGE_TYPE_TEXT[draftType] ?? draftType}关联「${related}」`)
      setSelected(null)
      setNonce((n) => n + 1)
    } catch (err) {
      toast.error(errText(err, '添加关联失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 全景适应：重新把全部节点 fit 进视口（工具栏按钮回调） */
  function fitAll() {
    const box = wrapRef.current
    if (!box || nodes.length === 0) return
    setView(fitViewToNodes(nodes, box.clientWidth, box.clientHeight))
  }

  /** 以视口中心为锚点的缩放（+/- 按钮回调） */
  function zoomAtCenter(zoomIn: boolean) {
    const box = wrapRef.current
    if (!box) return
    setView((v) => zoomViewAt(v, box.clientWidth / 2, box.clientHeight / 2, zoomIn))
  }

  if (!open) return null

  const toGraph = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - view.x) / view.k,
      y: (e.clientY - rect.top - view.y) / view.k,
    }
  }

  const nodeById = (id: string) => simRef.current?.nodes().find((n) => n.id === id)

  function onNodePointerDown(e: React.PointerEvent, node: SimNode) {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    dragRef.current = { id: node.id, moved: false }
    node.fx = node.x
    node.fy = node.y
    simRef.current?.alphaTarget(0.15).restart()
  }

  function onSvgPointerDown(e: React.PointerEvent) {
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
  }

  function onSvgPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (drag) {
      const node = nodeById(drag.id)
      if (node) {
        const pt = toGraph(e)
        node.fx = pt.x
        node.fy = pt.y
        drag.moved = true
      }
      return
    }
    const pan = panRef.current
    if (pan) {
      setView((v) => ({ ...v, x: pan.vx + e.clientX - pan.sx, y: pan.vy + e.clientY - pan.sy }))
    }
  }

  function onSvgPointerUp() {
    const drag = dragRef.current
    if (drag) {
      const node = nodeById(drag.id)
      if (node) {
        node.fx = null
        node.fy = null
      }
      dragRef.current = null
      simRef.current?.alphaTarget(0)
    }
    panRef.current = null
  }

  function onNodeClick(node: SimNode) {
    // 拖拽落点后不触发信息卡
    if (dragRef.current?.moved) return
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null
      setSelected(node)
    }, 250)
  }

  function onNodeDoubleClick(node: SimNode) {
    // 双击：取消挂起的单击信息卡
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    if (node.status === 'potential') return
    onOpenWord(node.id)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d1526] shadow-2xl shadow-black/50">
        {/* 标题栏 + 控制 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/8 px-5 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-sky-600">
            <NetworkIcon className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-[14px] font-semibold">单词关联图谱</div>
            <div className="text-[10.5px] text-zinc-500">
              滚轮缩放 · 拖拽平移 · 全景适应（F）· +/- 缩放 · 单击详情 · 双击打开词条
            </div>
          </div>

          <div className="ml-3 flex items-center gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-[12px] transition',
                  filter === f.key
                    ? 'border border-sky-500/30 bg-sky-500/20 text-sky-200'
                    : 'border border-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIncludePotential((v) => !v)}
            title="把关联到但尚未收录的词也显示为叶子节点"
            className={cn(
              'ml-1 rounded-lg px-2.5 py-1 text-[12px] transition',
              includePotential
                ? 'border border-indigo-500/30 bg-indigo-500/20 text-indigo-200'
                : 'border border-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-200',
            )}
          >
            含潜在关联
          </button>

          <div className="flex-1" />

          {/* 缩放工具栏（有图谱数据才启用） */}
          {graph && (
            <div className="mr-2 flex items-center gap-0.5 rounded-lg border border-white/6 bg-white/3 p-0.5">
              <button
                onClick={() => zoomAtCenter(false)}
                title="缩小（-）"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
              >
                <ZoomOutIcon className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-[36px] px-1 text-center text-[10.5px] tabular-nums text-zinc-400">
                {Math.round(view.k * 100)}%
              </span>
              <button
                onClick={() => zoomAtCenter(true)}
                title="放大（+）"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
              >
                <ZoomInIcon className="h-3.5 w-3.5" />
              </button>
              <div className="mx-0.5 h-4 w-px bg-white/10" />
              <button
                onClick={fitAll}
                title="全景适应（F）"
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
              >
                <Maximize2Icon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {graph && (
            <span className="text-[11px] text-zinc-500">
              {graph.nodes.length} 节点 · {graph.edges.length} 边
              {graph.isolatedCount > 0 && (
                <span className="ml-1">· 另有 {graph.isolatedCount} 个词暂无关联（全库）</span>
              )}
              {graph.truncated && <span className="ml-1 text-amber-400/90">（已按关联度截断至 300 节点）</span>}
            </span>
          )}
          <button
            onClick={() => setNonce((n) => n + 1)}
            title="重新加载并布局"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
          >
            <RefreshCwIcon className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 画布 */}
        <div ref={wrapRef} className="relative min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-zinc-500">
              <LoaderIcon className="h-4 w-4 animate-spin" /> 正在构建关联图谱…
            </div>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-500">
              <NetworkIcon className="h-8 w-8 text-zinc-600" />
              <p className="text-[12.5px]">暂无关联数据。收录带 AI 释义的单词后会自动生成近/反义关联。</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
              onPointerDown={onSvgPointerDown}
              onPointerMove={onSvgPointerMove}
              onPointerUp={onSvgPointerUp}
              onPointerLeave={onSvgPointerUp}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                {links.map((l, i) => {
                  const s = l.source as SimNode
                  const t = l.target as SimNode
                  if (s.x == null || t.x == null || s.y == null || t.y == null) return null
                  return (
                    <line
                      key={i}
                      x1={s.x}
                      y1={s.y}
                      x2={t.x}
                      y2={t.y}
                      stroke={EDGE_COLOR[l.relationType] ?? '#71717a'}
                      strokeOpacity={0.45}
                      strokeWidth={1.2}
                    >
                      <title>{EDGE_TYPE_TEXT[l.relationType] ?? l.relationType}</title>
                    </line>
                  )
                })}
                {nodes.map((n) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                    onPointerDown={(e) => onNodePointerDown(e, n)}
                    onClick={() => onNodeClick(n)}
                    onDoubleClick={() => onNodeDoubleClick(n)}
                    className="cursor-pointer"
                  >
                    <circle
                      r={graphNodeRadius(n)}
                      fill={NODE_FILL[n.status] ?? '#a1a1aa'}
                      stroke={n.status === 'potential' ? '#71717a' : selected?.id === n.id ? '#fff' : 'rgba(255,255,255,0.25)'}
                      strokeDasharray={n.status === 'potential' ? '3 2' : undefined}
                      strokeWidth={selected?.id === n.id ? 2 : 1}
                    />
                    {/* 低缩放时仅显示高度数节点标签，避免文字堆叠 */}
                    {(view.k >= 0.7 || n.degree >= 2) && (
                      <text
                        y={graphNodeRadius(n) + 11}
                        textAnchor="middle"
                        fontSize={10}
                        fill={n.status === 'potential' ? '#71717a' : '#a1a1aa'}
                        className="pointer-events-none select-none"
                      >
                        {n.word}
                      </text>
                    )}
                  </g>
                ))}
              </g>
            </svg>
          )}

          {/* 图例 */}
          {graph && graph.nodes.length > 0 && (
            <div className="pointer-events-none absolute bottom-3 left-4 space-y-1 rounded-xl border border-white/8 bg-black/40 px-3 py-2 text-[10.5px] text-zinc-400 backdrop-blur">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: NODE_FILL.learning }} />学习中</span>
                <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: NODE_FILL.mastered }} />已掌握</span>
                <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: NODE_FILL.suspended }} />暂停</span>
                <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full border border-dashed border-zinc-500" />潜在关联</span>
              </div>
              <div className="flex items-center gap-3">
                {Object.entries(EDGE_TYPE_TEXT).map(([k, label]) => (
                  <span key={k} className="flex items-center gap-1">
                    <i className="inline-block h-0.5 w-3 rounded" style={{ background: EDGE_COLOR[k] }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 节点信息卡 */}
          {selected && (
            <div className="absolute right-4 top-3 w-64 rounded-xl border border-white/10 bg-[#111c33]/95 p-4 shadow-xl shadow-black/40 backdrop-blur">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-[15px] font-semibold text-zinc-100">{selected.word}</span>
                <button
                  onClick={() => setSelected(null)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {selected.status === 'potential' ? (
                <>
                  <p className="text-[11.5px] leading-relaxed text-zinc-500">
                    该词尚未收录进生词本，收录后会自动补齐双向关联。
                  </p>
                  <button
                    onClick={() => collectPotentialWord(selected.word)}
                    disabled={busy}
                    className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    {busy ? '收录中…' : `收录「${selected.word}」进生词本`}
                  </button>
                </>
              ) : (
                <>
                  {selectedWord?.phonetic && <div className="mb-1 text-[11.5px] text-zinc-500">{selectedWord.phonetic}</div>}
                  <p className="mb-2 line-clamp-3 text-[12px] leading-relaxed text-zinc-400">
                    {selectedWord ? meaningsSummary(selectedWord, 3) : '加载释义中…'}
                  </p>
                  <div className="flex items-center gap-2 text-[10.5px] text-zinc-500">
                    <span
                      className={cn(
                        'rounded-md border px-1.5 py-0.5',
                        selected.status === 'mastered' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
                        selected.status === 'suspended' && 'border-zinc-500/30 bg-zinc-500/10 text-zinc-400',
                        selected.status === 'learning' && 'border-sky-500/25 bg-sky-500/10 text-sky-300',
                      )}
                    >
                      {STATUS_TEXT[selected.status]}
                    </span>
                    <span>{selected.degree} 个关联</span>
                  </div>
                  <button
                    onClick={() => onOpenWord(selected.id)}
                    className="mt-3 w-full rounded-lg border border-sky-500/40 px-2.5 py-1.5 text-[12px] text-sky-300 transition hover:bg-sky-500/10"
                  >
                    打开词条详情
                  </button>

                  {/* 精简手动关联表单（图谱内直接加，不用跳详情） */}
                  <div className="mt-3 space-y-1.5 rounded-lg border border-white/6 bg-white/3 px-2 py-2">
                    <div className="flex items-center gap-1 text-[10.5px] text-zinc-500">
                      <Link2Icon className="h-3 w-3" /> 手动加关联
                    </div>
                    <div className="flex items-center gap-1">
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void addManualRelation()
                        }}
                        placeholder="输入关联词"
                        className="h-7 flex-1 rounded-md border border-white/10 bg-white/5 px-2 text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-500/40"
                      />
                      <select
                        value={draftType}
                        onChange={(e) => setDraftType(e.target.value as VocabRelationType)}
                        className="h-7 rounded-md border border-white/10 bg-white/5 px-1 text-[10.5px] text-zinc-300 outline-none focus:border-sky-500/40"
                      >
                        {(['synonym', 'antonym', 'derived', 'inflection', 'manual'] as VocabRelationType[]).map((t) => (
                          <option key={t} value={t} className="bg-zinc-900">
                            {EDGE_TYPE_TEXT[t] ?? t}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => void addManualRelation()}
                        disabled={busy || !draft.trim()}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-40"
                      >
                        <PlusIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
