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
import { XIcon, NetworkIcon, LoaderIcon, RefreshCwIcon } from 'lucide-react'
import { vocabApi } from '@/lib/tauri-bridge'
import { toast } from '@/lib/toast'
import { errText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { VocabGraph, VocabGraphEdge, VocabGraphNode, VocabStatus, VocabWord } from '@/types'
import {
  fitViewToNodes,
  graphNodeRadius,
  meaningsSummary,
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
  }, [open])

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
              滚轮缩放 · 拖拽平移 · 单击看详情 · 双击打开词条
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
                <p className="text-[11.5px] leading-relaxed text-zinc-500">
                  该词尚未收录进生词本，收录后会自动补齐双向关联。
                </p>
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
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
