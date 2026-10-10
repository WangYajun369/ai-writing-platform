/**
 * Agent 画像注册表（前端缓存）—— L3 自动发现
 *
 * 画像的展示元数据（名称 / 说明 / 图标 / 配色 / 快捷操作）**由后端下发**，
 * 前端不再硬编码。后端新增画像后，前端自动出现对应入口，无需改动一行代码。
 *
 * 设计要点：
 * - 模块级缓存 + 单次飞行（inflight）去抖：多个组件同时挂载只发一次 IPC
 * - 拉取期间提供 `null` 语义，调用方渲染骨架而非回退到硬编码表
 *   （回退表会让「新增画像前端零改动」失效——旧表永远缺新画像）
 * - `subscribe` 供 React 组件在加载完成后重渲染
 */

import { useEffect, useSyncExternalStore } from 'react'
import { agentApi } from '@/lib/tauri-bridge'
import type { ProfileMeta, ProfileKind } from '@/types'
import {
  PenToolIcon,
  SearchIcon,
  BookOpenIcon,
  SparklesIcon,
  GraduationCapIcon,
  ScissorsIcon,
  NotebookPenIcon,
  BotIcon,
  type LucideIcon,
} from 'lucide-react'

// ── 图标名 → 组件映射 ───────────────────────────────────────────────────────
// 后端下发 lucide 的 kebab-case 图标名，前端只做名→组件映射。
// 未在表中登记的名字回退 BotIcon，避免因后端新增图标名导致渲染崩溃。

const ICON_MAP: Record<string, LucideIcon> = {
  'pen-tool': PenToolIcon,
  search: SearchIcon,
  'book-open': BookOpenIcon,
  sparkles: SparklesIcon,
  'graduation-cap': GraduationCapIcon,
  scissors: ScissorsIcon,
  'notebook-pen': NotebookPenIcon,
}

/** 按图标名取组件（未知名回退机器人图标） */
export function profileIcon(name: string | undefined): LucideIcon {
  return (name && ICON_MAP[name]) || BotIcon
}

// ── 缓存 ────────────────────────────────────────────────────────────────────

let cache: ProfileMeta[] | null = null
let inflight: Promise<ProfileMeta[]> | null = null
const listeners = new Set<(profiles: ProfileMeta[]) => void>()

/**
 * 加载画像列表（幂等，带缓存与飞行去抖）
 *
 * 失败时**不抛错**：返回空数组，由调用方自行降级
 * （Agent 面板降级为无技能入口，而不是整块白屏）。
 */
export function loadAgentProfiles(): Promise<ProfileMeta[]> {
  if (cache) return Promise.resolve(cache)
  if (inflight) return inflight

  inflight = agentApi
    .listProfiles()
    .then((profiles) => {
      cache = profiles
      listeners.forEach((fn) => fn(profiles))
      return profiles
    })
    .catch((err) => {
      console.error('[agent-profiles] 拉取画像失败', err)
      inflight = null // 允许下次重试
      return [] as ProfileMeta[]
    })

  return inflight
}

/** 同步读取缓存（未就绪返回 `null`，调用方应渲染骨架） */
export function peekAgentProfiles(): ProfileMeta[] | null {
  return cache
}

/** 订阅加载完成事件，返回取消订阅函数 */
export function subscribeAgentProfiles(fn: (profiles: ProfileMeta[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── 查询 ────────────────────────────────────────────────────────────────────

/** 按类别过滤 */
export function profilesOfKind(profiles: ProfileMeta[], kind: ProfileKind): ProfileMeta[] {
  return profiles.filter((p) => p.kind === kind)
}

/** 按 id 查画像（不存在返回 undefined） */
export function findProfile(profiles: ProfileMeta[], id: string | undefined): ProfileMeta | undefined {
  return id ? profiles.find((p) => p.id === id) : undefined
}

// ── React Hook ──────────────────────────────────────────────────────────────

/**
 * 订阅画像列表（跨组件共享同一份缓存）
 *
 * @returns 画像列表；`null` 表示**尚未加载完成**，调用方应渲染骨架而不是回退硬编码表
 */
export function useAgentProfiles(): ProfileMeta[] | null {
  // 触发一次加载（幂等，缓存命中时不发 IPC）
  useEffect(() => {
    void loadAgentProfiles()
  }, [])
  return useSyncExternalStore(subscribeAgentProfiles, peekAgentProfiles)
}
