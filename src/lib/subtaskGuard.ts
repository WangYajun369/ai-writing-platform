/**
 * 子任务「完成前置」校验工具（任务卡 P2）
 *
 * 任务存在子任务时，必须全部勾选完成才能将任务置为「已完成」。
 * 后端 task_set_status / task_drag / task_update 已做兜底拦截；
 * 此处用于前端在「勾选完成」弹出总结框之前先探测，避免填完总结才发现被拒。
 */
import { taskCardApi } from '@/lib/tauri-bridge'

/**
 * 查询某任务未完成的子任务数量。
 * @returns 未完成子任务数；查询失败（后端不可用等）时返回 -1，表示不阻塞后续流程
 * （真正写状态时后端仍会兜底校验并返回错误）。
 */
export async function countUnfinishedSubtasks(taskId: string): Promise<number> {
  try {
    const items = await taskCardApi.listSubtasks(taskId)
    return items.filter((s) => !s.done).length
  } catch {
    return -1
  }
}
