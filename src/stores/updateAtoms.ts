/**
 * 更新检查共享原子域
 *
 * 启动静默检查与设置页「版本更新」区块共用同一份结果，
 * 避免两处各自发起请求、状态不一致。
 */
import { atom } from 'jotai'

/** 发现的可用更新（null 表示无更新或尚未检查） */
export interface AvailableUpdate {
  /** 远端版本号（如 1.8.2 或 v1.8.2） */
  version: string
  /** 当前版本 */
  currentVersion: string
  /** 更新说明（Release notes） */
  body: string
  /** 下载页地址（GitHub 兜底路径使用；Tauri updater 路径为空） */
  url: string
  /** 检查来源：应用内更新器 or GitHub API 兜底 */
  source: 'updater' | 'github'
}

/** 可用更新信息 */
export const availableUpdateAtom = atom<AvailableUpdate | null>(null)

/** 启动静默检查是否已完成（用于避免重复检查与状态栏占位闪烁） */
export const updateCheckedAtom = atom<boolean>(false)
