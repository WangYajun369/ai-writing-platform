import { useState, useEffect, useRef } from 'react'
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { worldCardApi } from '@/lib/tauri-bridge'
import type { WorldCard, WorldCardType } from '@/types'
import { WORLD_CARD_TYPE_CONFIG, cn } from '@/lib/utils'
import WorldCardEditor from './WorldCardEditor'

interface WorldbuildingPanelProps {
  bookId: string
}

export default function WorldbuildingPanel({ bookId }: WorldbuildingPanelProps) {
  const [cards, setCards] = useState<WorldCard[]>([])
  const [filterType, setFilterType] = useState<WorldCardType | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [editingCard, setEditingCard] = useState<WorldCard | null>(null)
  const [showNewCard, setShowNewCard] = useState(false)

  // 虚拟化滚动容器 ref
  const parentRef = useRef<HTMLDivElement>(null)

  const filtered = cards
    .filter((c) => filterType === 'all' || c.type === filterType)
    .filter((c) => c.title.includes(searchQuery) || c.content.includes(searchQuery))

  // 虚拟化实例
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 110,
    overscan: 5,
  })

  useEffect(() => {
    loadCards()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // 过滤结果变化时重置滚动位置并重新测量
  useEffect(() => {
    virtualizer.scrollToOffset(0)
    virtualizer.measure()
  }, [filterType, searchQuery, virtualizer])

  async function loadCards() {
    try {
      const data = await worldCardApi.listByBook(bookId)
      setCards(data)
    } catch (err) {
      console.error('加载世界观卡片失败', err)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="px-3 py-2 border-b">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">世界观资料库</span>
          <button
            onClick={() => setShowNewCard(true)}
            className="p-1 rounded hover:bg-muted text-muted-foreground"
          >
            <PlusIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 搜索 */}
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索设定…"
            className="w-full pl-7 pr-3 py-1.5 text-xs bg-muted rounded-lg outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2">
              <XIcon className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* 类型过滤标签 */}
      <div className="flex gap-1 px-3 py-2 overflow-x-auto scrollbar-none flex-shrink-0">
        <FilterTag active={filterType === 'all'} onClick={() => setFilterType('all')}>全部</FilterTag>
        {(Object.keys(WORLD_CARD_TYPE_CONFIG) as WorldCardType[]).map((type) => (
          <FilterTag key={type} active={filterType === type} onClick={() => setFilterType(type)}>
            {WORLD_CARD_TYPE_CONFIG[type].icon} {WORLD_CARD_TYPE_CONFIG[type].label}
          </FilterTag>
        ))}
      </div>

      {/* 虚拟化卡片列表 */}
      <div ref={parentRef} className="flex-1 overflow-y-auto px-3 pb-3">
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            {searchQuery ? '无匹配结果' : '还没有设定，点击 + 新建'}
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const card = filtered[vItem.index]
              return (
                <div
                  key={card.id}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${vItem.size}px`,
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <div
                    onClick={() => setEditingCard(card)}
                    className="p-3 rounded-lg border bg-card hover:border-primary/40 cursor-pointer transition-colors"
                    style={{ marginBottom: '8px' }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm">{WORLD_CARD_TYPE_CONFIG[card.type].icon}</span>
                      <span className="text-sm font-medium truncate">{card.title}</span>
                    </div>
                    {card.content && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{card.content}</p>
                    )}
                    {card.tags.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {card.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="text-xs bg-muted px-1.5 py-0.5 rounded-full">{tag}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 新建/编辑弹窗 */}
      {(showNewCard || editingCard) && (
        <WorldCardEditor
          bookId={bookId}
          card={editingCard}
          onClose={() => { setShowNewCard(false); setEditingCard(null) }}
          onSaved={loadCards}
        />
      )}
    </div>
  )
}

function FilterTag({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'
      )}
    >
      {children}
    </button>
  )
}
