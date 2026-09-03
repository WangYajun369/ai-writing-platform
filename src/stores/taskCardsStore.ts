/**
 * 任务卡 · 个人项目管理 全局 Store（任务卡独立窗口内使用）
 *
 * 职责：
 * - 项目列表（含实时统计）、标签、按项目分组任务缓存、今日概览
 * - 封装全部增删改操作；每次变更后自动刷新受影响的缓存与今日概览，
 *   并通过前端事件 tasks-data-updated 通知主窗口（头部角标即时刷新）
 */
import { create } from 'zustand'
import { emit } from '@tauri-apps/api/event'
import { taskCardApi } from '@/lib/tauri-bridge'
import type {
  CreateProjectArgs,
  CreateTaskArgs,
  ProjectView,
  TaskCard,
  TaskProject,
  TaskStatus,
  TaskTag,
  TodayOverview,
  UpdateProjectArgs,
  UpdateTaskArgs,
} from '@/types'

/** 变更后广播：主窗口 home-header 角标即时刷新 */
function notifyChanged() {
  void emit('tasks-data-updated')
}

interface TaskCardsState {
  projects: ProjectView[]
  tags: TaskTag[]
  /** 按项目分组的任务缓存 */
  tasksByProject: Record<string, TaskCard[]>
  overview: TodayOverview | null
  loading: boolean
  loaded: boolean

  fetchProjects: () => Promise<void>
  fetchTags: () => Promise<void>
  fetchProjectTasks: (projectId: string) => Promise<void>
  fetchOverview: () => Promise<void>
  /** 全量刷新（进入窗口 / 重大变更后调用） */
  refreshAll: () => Promise<void>

  // ── 项目操作 ──
  createProject: (args: CreateProjectArgs) => Promise<TaskProject>
  updateProject: (id: string, args: UpdateProjectArgs) => Promise<TaskProject>
  deleteProject: (id: string) => Promise<void>
  restoreProject: (id: string) => Promise<void>
  hardDeleteProject: (id: string) => Promise<void>

  /** 任务变更后：刷新指定项目（或全部）任务缓存 + 项目统计 + 今日概览 + 广播 */
  refreshTaskArea: (projectId?: string) => Promise<void>

  // ── 任务操作 ──
  createTask: (args: CreateTaskArgs) => Promise<TaskCard>
  updateTask: (id: string, args: UpdateTaskArgs) => Promise<TaskCard>
  setStatus: (id: string, status: TaskStatus) => Promise<void>
  dragTask: (id: string, toStatus: TaskStatus, orderedIds: string[]) => Promise<void>
  copyTask: (id: string) => Promise<void>
  moveTaskToProject: (id: string, toProjectId: string) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  restoreTask: (id: string) => Promise<void>
  hardDeleteTask: (id: string) => Promise<void>
}

export const useTaskCardsStore = create<TaskCardsState>((set, get) => ({
  projects: [],
  tags: [],
  tasksByProject: {},
  overview: null,
  loading: false,
  loaded: false,

  fetchProjects: async () => {
    const projects = await taskCardApi.listProjects()
    set({ projects })
  },

  fetchTags: async () => {
    const tags = await taskCardApi.listTags()
    set({ tags })
  },

  fetchProjectTasks: async (projectId) => {
    const tasks = await taskCardApi.listTasks(projectId)
    set((s) => ({ tasksByProject: { ...s.tasksByProject, [projectId]: tasks } }))
  },

  fetchOverview: async () => {
    const overview = await taskCardApi.todayOverview()
    set({ overview })
  },

  refreshAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const [projects, tags, overview] = await Promise.all([
        taskCardApi.listProjects(),
        taskCardApi.listTags(),
        taskCardApi.todayOverview(),
      ])
      const tasksByProject: Record<string, TaskCard[]> = {}
      await Promise.all(
        projects.map(async (p) => {
          try {
            tasksByProject[p.id] = await taskCardApi.listTasks(p.id)
          } catch {
            tasksByProject[p.id] = []
          }
        }),
      )
      set({ projects, tags, overview, tasksByProject, loaded: true })
    } catch (err) {
      console.error('刷新任务卡数据失败', err)
    } finally {
      set({ loading: false })
    }
  },

  // ── 项目 ──
  createProject: async (args) => {
    const project = await taskCardApi.createProject(args)
    await get().fetchProjects()
    notifyChanged()
    return project
  },

  updateProject: async (id, args) => {
    const project = await taskCardApi.updateProject(id, args)
    await get().fetchProjects()
    notifyChanged()
    return project
  },

  deleteProject: async (id) => {
    await taskCardApi.deleteProject(id)
    const tasksByProject = { ...get().tasksByProject }
    delete tasksByProject[id]
    set({ tasksByProject })
    await get().fetchProjects()
    await get().fetchOverview()
    notifyChanged()
  },

  restoreProject: async (id) => {
    await taskCardApi.restoreProject(id)
    await get().fetchProjects()
    await get().fetchOverview()
    notifyChanged()
  },

  hardDeleteProject: async (id) => {
    await taskCardApi.hardDeleteProject(id)
    await get().fetchProjects()
    notifyChanged()
  },

  // ── 任务 ──
  /** 变更新缓存 + 概览 */
  refreshTaskArea: async (projectId?: string) => {
    const ids = projectId ? [projectId] : Object.keys(get().tasksByProject)
    await Promise.all(ids.map((id) => get().fetchProjectTasks(id).catch(() => {})))
    await get().fetchProjects()
    await get().fetchOverview()
    notifyChanged()
  },

  createTask: async (args) => {
    const task = await taskCardApi.createTask(args)
    await get().refreshTaskArea(task.projectId)
    return task
  },

  updateTask: async (id, args) => {
    const task = await taskCardApi.updateTask(id, args)
    await get().refreshTaskArea(task.projectId)
    return task
  },

  setStatus: async (id, status) => {
    const task = await taskCardApi.setTaskStatus(id, status)
    await get().refreshTaskArea(task.projectId)
  },

  dragTask: async (id, toStatus, orderedIds) => {
    const cur = get().tasksByProject
    const srcProject = Object.keys(cur).find((pid) => cur[pid].some((t) => t.id === id))
    await taskCardApi.dragTask(id, toStatus, orderedIds)
    if (srcProject) await get().refreshTaskArea(srcProject)
  },

  copyTask: async (id) => {
    const task = await taskCardApi.copyTask(id)
    await get().refreshTaskArea(task.projectId)
  },

  moveTaskToProject: async (id, toProjectId) => {
    await taskCardApi.moveTaskToProject(id, toProjectId)
    // 源项目与目标项目都可能受影响，全量刷新
    await get().refreshTaskArea()
  },

  deleteTask: async (id) => {
    const cur = get().tasksByProject
    const srcProject = Object.keys(cur).find((pid) => cur[pid].some((t) => t.id === id))
    await taskCardApi.deleteTask(id)
    if (srcProject) await get().refreshTaskArea(srcProject)
  },

  restoreTask: async (id) => {
    await taskCardApi.restoreTask(id)
    await get().fetchProjects()
    await get().fetchOverview()
    notifyChanged()
  },

  hardDeleteTask: async (id) => {
    await taskCardApi.hardDeleteTask(id)
    await get().fetchOverview()
    notifyChanged()
  },
}))
