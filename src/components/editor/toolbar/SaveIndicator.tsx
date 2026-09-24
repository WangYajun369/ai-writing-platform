/**
 * SaveIndicator — 保存状态指示器
 *
 * 订阅全局 uiAtoms：isSavingAtom（正在保存）+ lastSavedAtom（最近保存时间）。
 * 保存中显示脉冲「保存中…」，最近保存后显示「已保存」，两者皆无则不渲染。
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
      <span className="flex items-center gap-1 text-xs text-muted-foreground ml-2 shrink-0 whitespace-nowrap">
        <ZapIcon className="w-3 h-3 animate-pulse" />
        保存中…
      </span>
    )
  }
  if (lastSaved) {
    return (
      <span className="text-xs text-muted-foreground ml-2 shrink-0 whitespace-nowrap">
        已保存
      </span>
    )
  }
  return null
})
