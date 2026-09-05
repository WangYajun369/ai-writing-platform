/**
 * ToastContainer — 全局通知容器
 *
 * 渲染在所有页面的最上层，展示 useToast() 弹出的通知。
 * 需在 App.tsx 根组件中挂载。
 */
import { useAtom } from 'jotai'
import {
  CheckCircle2Icon,
  XCircleIcon,
  AlertTriangleIcon,
  InfoIcon,
  XIcon,
} from 'lucide-react'
import { toastsAtom } from '@/lib/toast'
import type { ToastItem } from '@/lib/toast'
import { cn } from '@/lib/utils'

export default function ToastContainer() {
  const [toasts, setToasts] = useAtom(toastsAtom)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-9999 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onClose={() =>
            setToasts((prev) => prev.filter((t) => t.id !== toast.id))
          }
        />
      ))}
    </div>
  )
}

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const config = TOAST_CONFIG[toast.type]

  const runAction = () => {
    toast.action?.onClick()
    onClose()
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg border pointer-events-auto animate-slide-in-right',
        'bg-card border-border text-foreground',
      )}
    >
      <config.icon className={cn('w-4 h-4 shrink-0 mt-0.5', config.iconColor)} />
      <div className="flex-1 min-w-0">
        <span className="text-sm whitespace-pre-line break-words">{toast.message}</span>
        {toast.action && (
          <button
            onClick={runAction}
            className="mt-1.5 block text-xs font-medium text-primary hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        className="p-0.5 rounded hover:bg-muted shrink-0 text-muted-foreground"
      >
        <XIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

const TOAST_CONFIG = {
  success: { icon: CheckCircle2Icon, iconColor: 'text-green-500' },
  error: { icon: XCircleIcon, iconColor: 'text-red-500' },
  warning: { icon: AlertTriangleIcon, iconColor: 'text-yellow-500' },
  info: { icon: InfoIcon, iconColor: 'text-blue-500' },
} as const
