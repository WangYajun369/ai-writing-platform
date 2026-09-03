/**
 * 插件命令图标映射（lucide-react icon 名称 → 组件）
 *
 * 供 home-header 入口、command-palette 面板等插件 UI 复用，
 * 未匹配的命令图标回退 Puzzle。
 */
import {
  BookMarkedIcon,
  CalendarIcon,
  ClipboardListIcon,
  FlameIcon,
  LanguagesIcon,
  LightbulbIcon,
  ListFilterIcon,
  ListTodoIcon,
  PuzzleIcon,
  SunIcon,
  type LucideIcon,
} from 'lucide-react'

export const COMMAND_ICON_MAP: Record<string, LucideIcon> = {
  BookMarked: BookMarkedIcon,
  Languages: LanguagesIcon,
  Calendar: CalendarIcon,
  ClipboardList: ClipboardListIcon,
  Flame: FlameIcon,
  Lightbulb: LightbulbIcon,
  ListFilter: ListFilterIcon,
  ListTodo: ListTodoIcon,
  Sun: SunIcon,
}

/** 图标名回退组件 */
export const FALLBACK_COMMAND_ICON: LucideIcon = PuzzleIcon
