/**
 * 保存状态指示器
 *
 * 显示当前是「保存中…」动画还是「已保存」状态。
 */
import { memo } from 'react'
import { useAtom } from 'jotai'
import { ZapIcon } from 'lucide-react'
import { isSavingAtom, lastSavedAtom } from '@/stores/uiAtoms.ts'

export const SaveIndicator = memo(function SaveIndicator() {
  const [isSaving] = useAtom(isSavingAtom)
  const [lastSaved] = useAtom(lastSavedAtom)

  if (isSaving) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2">
        <ZapIcon className="w-3 h-3 animate-pulse" />
        保存中…
      </span>
    )
  }
  if (lastSaved) {
    return (
      <span className="text-xs text-muted-foreground ml-2">
        已保存
      </span>
    )
  }
  return null
})
