/**
 * useCompleteFlow — 任务「勾选完成」统一入口（任务卡各视图共用）
 *
 * - 未完成任务 → 弹出 CompleteSummaryModal 填写富文本总结，保存后置为已完成
 * - 已完成任务 → 直接重新打开（不弹总结）
 *
 * 用法：
 *   const { toggleDone, completeModal } = useCompleteFlow()
 *   <TaskCardView onToggleDone={() => toggleDone(task)} ... />
 *   {completeModal}   // 渲染在视图根部
 */
import { useCallback, useState } from 'react'
import { useTaskCardsStore } from '@/stores/taskCardsStore'
import { toast } from '@/lib/toast'
import { countUnfinishedSubtasks } from '@/lib/subtaskGuard'
import type { TaskCard } from '@/types'
import CompleteSummaryModal from './CompleteSummaryModal'

export function useCompleteFlow() {
  const setStatus = useTaskCardsStore((s) => s.setStatus)
  const [completing, setCompleting] = useState<TaskCard | null>(null)

  const toggleDone = useCallback(
    async (task: TaskCard) => {
      if (task.status === 'done') {
        // 已完成 → 重新打开（不弹总结）
        void setStatus(task.id, 'todo').catch(() => {})
        return
      }
      // 未完成 → 先校验子任务是否全部完成；有未完成项则不允许完成
      const pending = await countUnfinishedSubtasks(task.id)
      if (pending > 0) {
        toast.error(`还有 ${pending} 项子任务未完成，请先完成全部子任务后再勾选完成`)
        return
      }
      // 校验通过（或无子任务）→ 弹总结对话框（对话框内确认后置为已完成）
      setCompleting(task)
    },
    [setStatus],
  )

  const completeModal = completing ? (
    <CompleteSummaryModal key={completing.id} task={completing} onClose={() => setCompleting(null)} />
  ) : null

  return { toggleDone, completeModal }
}
