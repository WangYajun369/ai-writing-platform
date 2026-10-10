/**
 * AiSidePanel 共享常量
 */
import {
  CircleIcon,
  CircleCheckIcon,
  CircleAlertIcon,
  Loader2Icon,
} from 'lucide-react'

/** Agent 连接状态配置 */
export const STATUS_CONFIG = {
  idle:     { icon: CircleIcon,       color: 'text-muted-foreground/50',             label: '未检测' },
  testing:  { icon: Loader2Icon,      color: 'text-blue-500 animate-spin',           label: '检测中…' },
  connected:{ icon: CircleCheckIcon,  color: 'text-green-500',                       label: '已连接' },
  error:    { icon: CircleAlertIcon,  color: 'text-red-500',                         label: '连接失败' },
} as const

export type StatusKey = keyof typeof STATUS_CONFIG

// 注：各技能的快捷操作文案已于阶段五（L3 自动发现）迁入 Rust 画像注册表，
// 随 `list_agent_profiles` 下发（见 ProfileMeta.quickActions）。
// 前端不再维护副本——后端新增画像时这里无需改动。
