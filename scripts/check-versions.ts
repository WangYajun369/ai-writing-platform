#!/usr/bin/env node
/**
 * 检测 package.json 中所有依赖的当前版本与 npm registry 最新版本
 * 用法: npx tsx scripts/check-versions.ts
 * 可选参数:
 *   --deps    仅检查 dependencies
 *   --dev     仅检查 devDependencies
 *   --major   只显示有 major 版本更新的依赖
 *   --minor   只显示有 major 或 minor 版本更新的依赖
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')

// ========== 类型定义 ==========
interface PkgJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface VersionInfo {
  name: string
  type: 'dep' | 'dev'
  wanted: string        // package.json 中声明的范围
  current: string       // lock 文件中的实际安装版本（若可读取）
  latest: string
  status: 'up-to-date' | 'patch' | 'minor' | 'major' | 'error'
  error?: string
}

// ========== 命令行参数解析 ==========
const args = process.argv.slice(2)
const onlyDeps = args.includes('--deps')
const onlyDev = args.includes('--dev')
const majorOnly = args.includes('--major')
const minorOnly = args.includes('--minor')

// ========== 颜色工具（ANSI）==========
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

// ========== 版本比较工具 ==========
/** 将版本号解析为 [major, minor, patch, pre] */
function parseSemver(version: string): [number, number, number, string] {
  // 去除前导 v 和 ^ ~ 等前缀
  const cleaned = version.replace(/^[\^~>=<]+/, '').trim()
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/)
  if (!match) return [0, 0, 0, cleaned]
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
    match[4] || '',
  ]
}

function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseSemver(a)
  const [bMaj, bMin, bPat] = parseSemver(b)
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  return 0
}

function getStatus(current: string, latest: string): VersionInfo['status'] {
  const [cMaj, cMin, cPat] = parseSemver(current)
  const [lMaj, lMin, lPat] = parseSemver(latest)
  if (lMaj > cMaj) return 'major'
  if (lMin > cMin) return 'minor'
  if (lPat > cPat) return 'patch'
  return 'up-to-date'
}

// ========== 读取 pnpm-lock.yaml（获取实际安装版本）==========
function readLockVersions(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const content = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf-8')
    // pnpm-lock.yaml 中包的格式: /package-name/specifier_version:
    // 实际安装版本记录在 snapshots 或 packages 中
    // 简化方案：解析 specifiers 和 dependencies 的关系
    const regex = /^  \/(@?[^@]+)@[\d.]+(?:\([\d.]+\))?:/gm
    const snapshotRegex = /^  \/(@?[^/]+)\/([\d.]+(?:_\w+)?):/gm

    // 尝试从 packages 字段提取
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      // 紧跟着可能有多行，找 resolution 的版本
    }

    // 更简单的方式：解析 specifiers 部分
    const specRegex = /^\s+['"]?(@?[\w@/.-]+)['"]?:\s+['"]?([\d.]+)['"]?:?$/gm
    while ((match = specRegex.exec(content)) !== null) {
      map.set(match[1], match[2])
    }
  } catch {
    // lock 文件不存在或无法解析
  }
  return map
}

// ========== 从 npm registry 获取最新版本 ==========
async function fetchLatestVersion(pkgName: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { version: string }
    return data.version
  } finally {
    clearTimeout(timeout)
  }
}

// ========== 并发控制 ==========
async function withConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const queue = items.map((item, i) => ({ item, i }))
  const workers: Promise<void>[] = []

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const { item, i } = queue.shift()!
          results[i] = await fn(item)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

// ========== 主逻辑 ==========
async function main() {
  // 1. 读取 package.json
  const pkgJson: PkgJson = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf-8'),
  )

  const lockVersions = readLockVersions()

  // 2. 收集要检查的依赖
  const entries: { name: string; wanted: string; type: 'dep' | 'dev' }[] = []

  if (!onlyDev) {
    for (const [name, version] of Object.entries(pkgJson.dependencies ?? {})) {
      entries.push({ name, wanted: version, type: 'dep' })
    }
  }
  if (!onlyDeps) {
    for (const [name, version] of Object.entries(pkgJson.devDependencies ?? {})) {
      entries.push({ name, wanted: version, type: 'dev' })
    }
  }

  if (entries.length === 0) {
    console.log('没有需要检查的依赖。')
    return
  }

  console.log(
    `\n${c.bold}📦 正在检查 ${entries.length} 个依赖的最新版本...${c.reset}\n`,
  )

  // 3. 并发获取最新版本
  const start = Date.now()
  const infos = await withConcurrency(entries, 15, async ({ name, wanted, type }) => {
    const result: VersionInfo = {
      name,
      type,
      wanted,
      current: lockVersions.get(name) || wanted.replace(/^[\^~]/, ''),
      latest: '?',
      status: 'error',
    }
    try {
      result.latest = await fetchLatestVersion(name)
      result.status = getStatus(result.current, result.latest)
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e)
    }
    return result
  })

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  // 4. 筛选
  let filtered = infos
  if (majorOnly) {
    filtered = infos.filter(i => i.status === 'major')
  } else if (minorOnly) {
    filtered = infos.filter(i => i.status === 'major' || i.status === 'minor')
  }

  // 5. 输出表格
  const maxNameLen = Math.max(...filtered.map(i => i.name.length), 6)

  const header = `${c.bold}${'Name'.padEnd(maxNameLen + 2)} ${'Current'.padEnd(14)} ${'Latest'.padEnd(14)} ${'Type'.padEnd(6)} Status${c.reset}`
  console.log(header)
  console.log('─'.repeat(header.length - c.bold.length * 2 - c.reset.length * 2 + 10))

  const statusColors: Record<string, string> = {
    'up-to-date': c.green,
    'patch': c.cyan,
    'minor': c.yellow,
    'major': c.red,
    'error': c.red,
  }
  const statusIcons: Record<string, string> = {
    'up-to-date': '✅ 最新',
    'patch': '📌 补丁',
    'minor': '⬆️  次版本',
    'major': '🚀 大版本',
    'error': '❌ 错误',
  }

  let counts = { 'up-to-date': 0, patch: 0, minor: 0, major: 0, error: 0 }

  for (const info of filtered) {
    const color = statusColors[info.status] || c.reset
    const icon = statusIcons[info.status] || info.status
    const typeLabel = info.type === 'dev' ? c.dim + 'dev' + c.reset : c.blue + 'dep' + c.reset

    const diff = info.status === 'error'
      ? info.error?.substring(0, 30) || '?'
      : info.latest

    console.log(
      `${color}${info.name.padEnd(maxNameLen + 2)} ${(info.current).padEnd(14)} ${(diff).padEnd(14)} ${typeLabel}   ${icon}${c.reset}`,
    )

    counts[info.status]++
  }

  // 6. 汇总
  console.log('─'.repeat(header.length - c.bold.length * 2 - c.reset.length * 2 + 10))
  const total = filtered.length
  console.log(
    `\n${c.bold}总计: ${total}${c.reset} 个包（耗时 ${elapsed}s）`,
  )
  console.log(
    `  ${c.green}✅ 最新: ${counts['up-to-date']}${c.reset}  ${c.cyan}📌 补丁: ${counts.patch}${c.reset}  ${c.yellow}⬆️  次版本: ${counts.minor}${c.reset}  ${c.red}🚀 大版本: ${counts.major}${c.reset}  ${c.dim}❌ 出错: ${counts.error}${c.reset}`,
  )

  if (counts.major > 0) {
    console.log(
      `\n${c.yellow}💡 提示: 大版本更新可能包含 breaking changes，请谨慎更新。${c.reset}`,
    )
  }

  console.log()
}

main().catch(console.error)
