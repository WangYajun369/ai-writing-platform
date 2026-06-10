/**
 * AI 工具箱设置区块 —— 按分类管理所有 AI 工具的 System Prompt
 *
 * 特性：
 * - 分类卡片布局，每个分类有独立主题色
 * - 分类折叠/展开
 * - 工具展开显示名称 + 描述 + System Prompt 编辑器
 * - 支持新增/编辑/删除分类和工具
 * - 所有变更自动持久化
 */
import { useState } from 'react'
import {
  PlusIcon,
  Trash2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  WrenchIcon,
  FolderPlusIcon,
  PencilIcon,
  XIcon,
} from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import type { AiToolPrompt } from '@/types'

/** 内置可选分类颜色方案 */
const COLOR_OPTIONS = [
  { label: '蓝橙渐变', value: 'linear-gradient(180deg, #E0EBFF -5%, #FFF2E7 99.73%)' },
  { label: '粉白渐变', value: 'linear-gradient(180deg, #FFE6F4 -1.2%, #F4FDFF 93.1%)' },
  { label: '青蓝渐变', value: 'linear-gradient(180deg, #E1F8FF 0%, #CEE7EE 69.22%)' },
  { label: '灰白渐变', value: 'linear-gradient(180deg, #E0DFDB 0%, #E0DFDB 100%)' },
  { label: '蓝绿渐变', value: 'linear-gradient(174deg, #CAEAF2 4.65%, #D5ECF4 95.23%)' },
  { label: '暖橙渐变', value: 'linear-gradient(174deg, #FFE4CF 4.65%, #FEECE6 95.23%)' },
  { label: '青绿渐变', value: 'linear-gradient(180deg, #B0FFD8 29.9%, #C8FAE1 100%)' },
  { label: '蓝紫渐变', value: 'linear-gradient(176deg, #FFE6F4 -1.2%, #F4FDFF 93.1%)' },
]

/**
 * -------- 新增工具表单 --------
 */
function AddToolForm({
  onAdd,
  onCancel,
}: {
  onAdd: (tool: AiToolPrompt) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  const handleAdd = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd({ id: crypto.randomUUID(), name: trimmed, description: desc.trim(), systemPrompt: '' })
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-muted/50 border">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleAdd()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="工具名称，如：章节总结"
        autoFocus
        className="px-3 py-1.5 text-sm rounded-lg bg-background border outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') onCancel() }}
        placeholder="工具描述，如：分析章节情节走向与人物弧光…"
        className="px-3 py-1.5 text-xs rounded-lg bg-background border outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1 rounded-lg text-xs hover:bg-muted"
        >
          取消
        </button>
        <button
          onClick={handleAdd}
          disabled={!name.trim()}
          className="px-3 py-1 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-50"
        >
          添加
        </button>
      </div>
    </div>
  )
}

/**
 * -------- 新建分类表单 --------
 */
function AddCategoryForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, color: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLOR_OPTIONS[0].value)
  const [showColors, setShowColors] = useState(false)

  const handleAdd = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onAdd(trimmed, color)
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border-2 border-dashed border-primary/30">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder="分类名称，如：对话工具、世界观…"
          autoFocus
          className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-background border outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="relative">
          <button
            onClick={() => setShowColors(!showColors)}
            className="w-7 h-7 rounded-full border shadow-sm"
            style={{ background: color }}
            title="选择颜色"
          />
          {showColors && (
            <div className="absolute right-0 top-full mt-1 p-1.5 rounded-lg border bg-popover shadow-lg z-10 grid grid-cols-4 gap-1">
              {COLOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => { setColor(opt.value); setShowColors(false) }}
                  className="w-6 h-6 rounded-full border shadow-sm hover:scale-110 transition-transform"
                  style={{ background: opt.value }}
                  title={opt.label}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={onCancel}
          className="px-3 py-1 rounded-lg text-xs hover:bg-muted"
        >
          取消
        </button>
        <button
          onClick={handleAdd}
          disabled={!name.trim()}
          className="px-3 py-1 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-50"
        >
          创建分类
        </button>
      </div>
    </div>
  )
}

/**
 * -------- AI 工具箱主组件 --------
 */
export function AiToolboxSection() {
  const {
    aiToolCategories,
    addAiToolCategory,
    updateAiToolCategory,
    deleteAiToolCategory,
    addAiToolPrompt,
    updateAiToolPrompt,
    deleteAiToolPrompt,
  } = useAppStore()

  // 展开的分类 ID 集合
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  // 展开的工具 ID 集合（含 categoryId:promptId）
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  // 正在添加工具的分类 ID
  const [addingToolFor, setAddingToolFor] = useState<string | null>(null)
  // 是否正在新建分类
  const [isAddingCategory, setIsAddingCategory] = useState(false)
  // 正在编辑分类名称
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null)
  const [editingCategoryName, setEditingCategoryName] = useState('')

  const toggleCategory = (id: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTool = (categoryId: string, promptId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      const key = `${categoryId}:${promptId}`
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleAddTool = (categoryId: string, tool: AiToolPrompt) => {
    addAiToolPrompt(categoryId, tool)
    setAddingToolFor(null)
    setExpandedTools((prev) => new Set(prev).add(`${categoryId}:${tool.id}`))
  }

  const handleDeleteTool = (categoryId: string, promptId: string, name: string) => {
    if (!window.confirm(`确定要删除「${name}」吗？此操作不可撤销。`)) return
    deleteAiToolPrompt(categoryId, promptId)
    setExpandedTools((prev) => {
      const next = new Set(prev)
      next.delete(`${categoryId}:${promptId}`)
      return next
    })
  }

  const handleAddCategory = (name: string, color: string) => {
    addAiToolCategory({ id: crypto.randomUUID(), name, color, tools: [] })
    setIsAddingCategory(false)
  }

  const handleDeleteCategory = (categoryId: string, name: string) => {
    if (!window.confirm(`确定要删除分类「${name}」及其所有工具吗？此操作不可撤销。`)) return
    deleteAiToolCategory(categoryId)
  }

  const startEditCategory = (categoryId: string, name: string) => {
    setEditingCategoryId(categoryId)
    setEditingCategoryName(name)
  }

  const saveEditCategory = () => {
    if (editingCategoryId && editingCategoryName.trim()) {
      updateAiToolCategory(editingCategoryId, { name: editingCategoryName.trim() })
    }
    setEditingCategoryId(null)
    setEditingCategoryName('')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <WrenchIcon className="w-4 h-4" />
            AI 工具箱
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            按分类管理 AI 工具的 System Prompt，留空则使用默认提示词。
          </p>
        </div>
        <button
          onClick={() => setIsAddingCategory(true)}
          disabled={isAddingCategory}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <FolderPlusIcon className="w-3.5 h-3.5" />
          新建分类
        </button>
      </div>

      {/* 新建分类 */}
      {isAddingCategory && (
        <AddCategoryForm onAdd={handleAddCategory} onCancel={() => setIsAddingCategory(false)} />
      )}

      {/* 分类列表 */}
      {aiToolCategories.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          暂无分类，点击右上角「新建分类」添加。
        </p>
      ) : (
        <div className="space-y-3">
          {aiToolCategories.map((category) => {
            const catExpanded = expandedCategories.has(category.id)
            return (
              <div key={category.id} className="rounded-xl border overflow-hidden">
                {/* 分类头部 */}
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                  style={{ background: category.color || '#f5f5f5' }}
                  onClick={() => toggleCategory(category.id)}
                >
                  <span className="text-muted-foreground/70">
                    {catExpanded ? (
                      <ChevronDownIcon className="w-4 h-4" />
                    ) : (
                      <ChevronRightIcon className="w-4 h-4" />
                    )}
                  </span>

                  {/* 分类名称编辑 */}
                  {editingCategoryId === category.id ? (
                    <input
                      value={editingCategoryName}
                      onChange={(e) => setEditingCategoryName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEditCategory()
                        if (e.key === 'Escape') { setEditingCategoryId(null); setEditingCategoryName('') }
                      }}
                      onBlur={saveEditCategory}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      className="px-2 py-0.5 text-sm font-semibold rounded border bg-background/80 outline-none focus:ring-1 focus:ring-primary/30 max-w-[200px]"
                    />
                  ) : (
                    <span className="text-sm font-semibold flex-1">{category.name}</span>
                  )}

                  <span className="text-[10px] text-muted-foreground/60">
                    {category.tools.length} 个工具
                  </span>

                  {/* 操作按钮 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      startEditCategory(category.id, category.name)
                    }}
                    className="p-1 rounded hover:bg-background/50 text-muted-foreground/70 hover:text-foreground transition-colors"
                    title="重命名分类"
                  >
                    <PencilIcon className="w-3 h-3" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteCategory(category.id, category.name)
                    }}
                    className="p-1 rounded hover:bg-destructive/15 text-muted-foreground/70 hover:text-destructive transition-colors"
                    title="删除分类"
                  >
                    <Trash2Icon className="w-3 h-3" />
                  </button>
                </div>

                {/* 分类展开内容 */}
                {catExpanded && (
                  <div className="border-t">
                    {category.tools.length === 0 ? (
                      <div className="px-4 py-6 text-xs text-muted-foreground text-center">
                        该分类暂无工具
                      </div>
                    ) : (
                      <div className="divide-y">
                        {category.tools.map((tool) => {
                          const toolExpanded = expandedTools.has(`${category.id}:${tool.id}`)
                          return (
                            <div key={tool.id}>
                              {/* 工具头部 */}
                              <button
                                onClick={() => toggleTool(category.id, tool.id)}
                                className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors"
                              >
                                <span className="text-muted-foreground mt-0.5">
                                  {toolExpanded ? (
                                    <ChevronDownIcon className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronRightIcon className="w-3.5 h-3.5" />
                                  )}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium">{tool.name}</span>
                                    {!tool.systemPrompt && (
                                      <span className="text-[10px] text-muted-foreground/50">默认</span>
                                    )}
                                  </div>
                                  {tool.description && (
                                    <p className="text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-1">
                                      {tool.description}
                                    </p>
                                  )}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeleteTool(category.id, tool.id, tool.name)
                                  }}
                                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors shrink-0"
                                  title="删除工具"
                                >
                                  <XIcon className="w-3 h-3" />
                                </button>
                              </button>

                              {/* 工具编辑区 */}
                              {toolExpanded && (
                                <div className="px-4 pb-3 pt-1 pl-12 space-y-2">
                                  {/* 名称编辑 */}
                                  <input
                                    value={tool.name}
                                    onChange={(e) =>
                                      updateAiToolPrompt(category.id, tool.id, { name: e.target.value })
                                    }
                                    className="w-full px-2 py-1 text-xs font-medium rounded border bg-background outline-none focus:ring-1 focus:ring-primary/30"
                                    placeholder="工具名称"
                                  />
                                  {/* 描述编辑 */}
                                  <input
                                    value={tool.description}
                                    onChange={(e) =>
                                      updateAiToolPrompt(category.id, tool.id, { description: e.target.value })
                                    }
                                    className="w-full px-2 py-1 text-xs rounded border bg-background outline-none focus:ring-1 focus:ring-primary/30"
                                    placeholder="工具描述"
                                  />
                                  {/* System Prompt 编辑 */}
                                  <textarea
                                    value={tool.systemPrompt}
                                    onChange={(e) =>
                                      updateAiToolPrompt(category.id, tool.id, { systemPrompt: e.target.value })
                                    }
                                    placeholder={`输入 ${tool.name} 的自定义 System Prompt，留空则使用默认提示词…`}
                                    rows={4}
                                    className="w-full px-2 py-1.5 text-xs rounded border bg-background placeholder:text-muted-foreground/40 resize-none focus:outline-none focus:ring-1 focus:ring-primary/30"
                                  />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* 新增工具按钮 / 表单 */}
                    <div className="px-3 pb-3 pt-1.5">
                      {addingToolFor === category.id ? (
                        <AddToolForm
                          onAdd={(tool) => handleAddTool(category.id, tool)}
                          onCancel={() => setAddingToolFor(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setAddingToolFor(category.id)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <PlusIcon className="w-3 h-3" />
                          添加工具
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
