/**
 * 模型检测图标
 */
import { memo } from 'react'
import { Loader2Icon, CircleCheckIcon, CircleAlertIcon, CircleIcon } from 'lucide-react'

interface ModelCheckIconProps {
  status: 'idle' | 'checking' | 'ok' | 'error'
}

export const ModelCheckIcon = memo(function ModelCheckIcon({ status }: ModelCheckIconProps) {
  switch (status) {
    case 'checking':
      return <Loader2Icon className="w-3 h-3 animate-spin text-blue-500" />
    case 'ok':
      return <CircleCheckIcon className="w-3 h-3 text-green-500" />
    case 'error':
      return <CircleAlertIcon className="w-3 h-3 text-red-500" />
    default:
      return <CircleIcon className="w-3 h-3 text-muted-foreground/40" />
  }
})
