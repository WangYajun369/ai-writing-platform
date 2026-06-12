/**
 * ToolboxSidebar — AI 工具箱左侧工具列表侧边栏
 */
import { WrenchIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import type { AiToolCategory, AiToolPrompt } from '@/types'
import { cn } from '@/lib/utils'

interface ToolboxSidebarProps {
  categories: AiToolCategory[]
  selectedToolId: string | null
  collapsedCategories: Set<string>
  onToggleCategory: (id: string) => void
  onSelectTool: (tool: AiToolPrompt) => void
  generating: boolean
}

export function ToolboxSidebar({
  categories,
  selectedToolId,
  collapsedCategories,
  onToggleCategory,
  onSelectTool,
  generating,
}: ToolboxSidebarProps) {
  return (
    <div className="w-48 shrink-0 border-r border-border flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <WrenchIcon className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-semibold text-muted-foreground">AI 工具箱</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {categories.map((cat) => {
          const isCollapsed = collapsedCategories.has(cat.id)
          return (
            <div key={cat.id} className="mb-0.5">
              <button
                onClick={() => onToggleCategory(cat.id)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRightIcon className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronDownIcon className="w-3 h-3 shrink-0" />
                )}
                <span className="truncate">{cat.name}</span>
                <span className="text-[10px] opacity-50 ml-auto">{cat.tools.length}</span>
              </button>
              {!isCollapsed && (
                <div className="space-y-0.5 px-1">
                  {cat.tools.map((tool) => (
                    <button
                      key={tool.id}
                      onClick={() => onSelectTool(tool)}
                      disabled={generating}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors',
                        selectedToolId === tool.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-foreground/80 hover:bg-muted/60',
                        generating && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      <div className="truncate">{tool.name}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {categories.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground/50 text-center">
            暂无工具，请前往设置管理
          </p>
        )}
      </div>
    </div>
  )
}
