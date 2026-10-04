/**
 * 版本号工具 —— semver 比较与「跳过此版本」持久化
 *
 * 更新检查的判定逻辑集中在此处（纯函数 + localStorage 薄封装），
 * 便于单元测试，避免散落在组件内无法回归。
 * 版本号比较仅处理 X.Y.Z 三段数字（与本项目 bump 脚本的版本格式一致），
 * 忽略前导 v 与 -pre / +build 后缀。
 */

/** 「跳过此版本」持久化键 */
export const SKIP_VERSION_KEY = 'timewrite:update:skipped-version'

/** 解析版本号为数字三元组；非法输入返回 [0,0,0] */
export function parseVersion(version: string | null | undefined): [number, number, number] {
  const clean = String(version ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0]
  const parts = clean.split('.')
  const num = (s: string | undefined) => {
    const n = Number.parseInt(s ?? '', 10)
    return Number.isFinite(n) ? n : 0
  }
  return [num(parts[0]), num(parts[1]), num(parts[2])]
}

/** 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1
    if (va[i] < vb[i]) return -1
  }
  return 0
}

/** 是否为不可用/占位版本（0.x.y 视作无效：Web 预览的 '0.0.0-dev'、解析失败等） */
function isPlaceholderVersion(version: string | null | undefined): boolean {
  const [major, minor, patch] = parseVersion(version)
  return major === 0 && minor === 0 && patch === 0
}

/**
 * candidate 是否比 current 更新。
 *
 * 任一版本为占位/无效值（如 Web 预览下的 '0.0.0-dev'）时一律返回 false：
 * - current 无效 → 无法判断用户实际版本，宁可不提示，也不误报「有新版本」
 * - candidate 无效 → 远端数据不可信，不提示
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (isPlaceholderVersion(current) || isPlaceholderVersion(candidate)) return false
  return compareVersions(candidate, current) > 0
}

/** 读取已跳过的版本号（无则 null） */
export function getSkippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_VERSION_KEY)
  } catch {
    return null
  }
}

/** 记录「跳过此版本」 */
export function setSkippedVersion(version: string): void {
  try {
    localStorage.setItem(SKIP_VERSION_KEY, version)
  } catch {
    /* 隐私模式等场景下写入失败，静默降级为「不跳过」 */
  }
}

/** 清除跳过记录（用户主动检查更新时调用） */
export function clearSkippedVersion(): void {
  try {
    localStorage.removeItem(SKIP_VERSION_KEY)
  } catch {
    /* 同上 */
  }
}

/**
 * 是否应当向用户提示该远端版本：
 * - 远端必须比当前版本新
 * - 若用户已跳过「该版本或更旧版本」则不提示；出现更新的版本时重新提示
 */
export function shouldNotifyUpdate(
  remote: string,
  current: string,
  skipped: string | null = getSkippedVersion(),
): boolean {
  if (!isNewerVersion(remote, current)) return false
  if (skipped && compareVersions(remote, skipped) <= 0) return false
  return true
}
