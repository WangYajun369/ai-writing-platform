#!/usr/bin/env node
/**
 * 检测 Cargo.toml 中所有 Rust 依赖的当前版本与 crates.io 最新版本
 * 用法: npx tsx scripts/check-rust-versions.ts
 * 可选参数:
 *   --deps    仅检查 [dependencies]
 *   --build   仅检查 [build-dependencies]
 *   --dev     仅检查 [dev-dependencies]
 *   --major   只显示有 major 版本更新的依赖
 *   --minor   只显示有 major 或 minor 版本更新的依赖
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')

// ========== 类型定义 ==========
interface CrateVersion {
  name: string
  type: 'dep' | 'build' | 'dev'
  wanted: string          // Cargo.toml 中声明的版本
  current: string         // Cargo.lock 中的锁定版本（若可读取）
  latest: string
  status: 'up-to-date' | 'patch' | 'minor' | 'major' | 'error'
  error?: string
}

interface CratesIoResponse {
  crate: {
    max_stable_version: string
    max_version: string
    newest_version: string
    description: string
  }
}

// ========== 命令行参数解析 ==========
const args = process.argv.slice(2)
const onlyDeps = args.includes('--deps')
const onlyBuild = args.includes('--build')
const onlyDev = args.includes('--dev')
const majorOnly = args.includes('--major')
const minorOnly = args.includes('--minor')

// 默认：未指定任何过滤时，检查所有
const checkAll = !onlyDeps && !onlyBuild && !onlyDev

// ========== 颜色工具 ==========
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

// ========== Cargo.toml 解析 ==========
interface CrateEntry {
  name: string
  version: string
  type: 'dep' | 'build' | 'dev'
}

function parseCargoToml(content: string): CrateEntry[] {
  const entries: CrateEntry[] = []
  let section: 'dep' | 'build' | 'dev' | null = null

  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // 检测节头
    if (line === '[dependencies]') {
      section = 'dep'
      continue
    }
    if (line === '[build-dependencies]') {
      section = 'build'
      continue
    }
    if (line === '[dev-dependencies]') {
      section = 'dev'
      continue
    }

    // 节结束（遇到下一个节头或空行后接新节头）
    if (line.startsWith('[') && section !== null) {
      section = null
      continue
    }

    if (!section) continue
    if (line === '' || line.startsWith('#')) continue

    // 解析依赖行
    // 格式1: crate_name = "version"
    // 格式2: crate_name = { version = "x.y", features = [...] }
    const simpleMatch = line.match(/^(\S+)\s*=\s*"([^"]+)"/)
    if (simpleMatch) {
      const name = simpleMatch[1]
      const version = simpleMatch[2]

      // 跳过注释和内部引用（workspace、path 引用等）
      if (name.startsWith('#')) continue

      entries.push({ name, version, type: section })
      continue
    }

    // 格式3: 表格式（可能跨多行）
    const tableStart = line.match(/^(\S+)\s*=\s*\{/)
    if (tableStart) {
      const name = tableStart[1]
      // 收集直到 } 的内容
      let buffer = line.substring(line.indexOf('{'))
      let j = i + 1
      while (!buffer.includes('}') && j < lines.length) {
        buffer += ' ' + lines[j].trim()
        j++
      }
      // 跳过已消费的行
      if (j > i + 1) i = j - 1

      // 从表内容中提取 version
      const verMatch = buffer.match(/version\s*=\s*"([^"]+)"/)
      if (verMatch) {
        entries.push({ name, version: verMatch[1], type: section })
      }
      continue
    }

    // 多行表格式（名在第一行，{ 在下一行）
    const multiLineStart = line.match(/^(\S+)\s*=\s*$/)
    if (multiLineStart && i + 1 < lines.length && lines[i + 1].trim() === '{') {
      const name = multiLineStart[1]
      let buffer = '{'
      let j = i + 2
      while (!buffer.includes('}') && j < lines.length) {
        buffer += ' ' + lines[j].trim()
        j++
      }
      i = j - 1
      const verMatch = buffer.match(/version\s*=\s*"([^"]+)"/)
      if (verMatch) {
        entries.push({ name, version: verMatch[1], type: section })
      }
    }
  }

  return entries
}

// ========== Cargo.lock 解析（获取锁定版本）==========
function parseCargoLock(): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const content = readFileSync(join(ROOT, 'src-tauri', 'Cargo.lock'), 'utf-8')
    // Cargo.lock 格式:
    // [[package]]
    // name = "crate_name"
    // version = "1.2.3"
    const pkgRegex = /\[\[package\]\]\nname\s*=\s*"([^"]+)"\nversion\s*=\s*"([^"]+)"/g
    let match: RegExpExecArray | null
    while ((match = pkgRegex.exec(content)) !== null) {
      map.set(match[1], match[2])
    }
  } catch {
    // Cargo.lock 不存在
  }
  return map
}

// ========== 版本比较工具 ==========
type SemanticPart = [number, number, number, string]

function parseSemver(version: string): SemanticPart {
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

/** 将 pre-release 标识符转换为数字权重用于比较 */
function preWeight(pre: string): number {
  if (!pre) return 1 // 正式版权重最高
  if (pre.startsWith('alpha')) return -3
  if (pre.startsWith('beta')) return -2
  if (pre.startsWith('rc')) return -1
  return 0
}

function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat, aPre] = parseSemver(a)
  const [bMaj, bMin, bPat, bPre] = parseSemver(b)
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1
  if (aMin !== bMin) return aMin < bMin ? -1 : 1
  if (aPat !== bPat) return aPat < bPat ? -1 : 1
  const aw = preWeight(aPre), bw = preWeight(bPre)
  return aw < bw ? -1 : aw > bw ? 1 : 0
}

function getStatus(current: string, latest: string): CrateVersion['status'] {
  const [cMaj, cMin] = parseSemver(current)
  const [lMaj, lMin] = parseSemver(latest)
  if (lMaj > cMaj) return 'major'
  if (lMin > cMin) return 'minor'
  if (compareSemver(current, latest) < 0) return 'patch'
  return 'up-to-date'
}

/** 将简写版本（如 "2"、"0.12"）补全为标准 semver */
function normalizeCargoVersion(v: string, latest?: string): string {
  const trimmed = v.trim()
  // 已经是完整的三段式
  if (/^\d+\.\d+\.\d+/.test(trimmed)) return trimmed

  const parts = trimmed.split('.')
  if (parts.length === 1) {
    // "2" -> 使用 latest 的主版本号 + ".0.0" 作为比较基准
    // 或者直接补全为 "2.0.0"
    return `${parts[0]}.0.0`
  }
  if (parts.length === 2) {
    // "0.12" -> "0.12.0"
    return `${parts[0]}.${parts[1]}.0`
  }
  return trimmed
}

// ========== 从 crates.io API 获取最新版本 ==========
async function fetchLatestVersion(crateName: string): Promise<string | null> {
  const url = `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MirageInk/check-versions (dependency checker)',
        'Accept': 'application/json',
      },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as CratesIoResponse
    // 优先使用 max_stable_version，保证拿到的不是 pre-release
    return data.crate.max_stable_version || data.crate.max_version
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
  // 1. 读取并解析 Cargo.toml
  const cargoPath = join(ROOT, 'src-tauri', 'Cargo.toml')
  let cargoContent: string
  try {
    cargoContent = readFileSync(cargoPath, 'utf-8')
  } catch {
    console.error(`${c.red}错误: 找不到 ${cargoPath}${c.reset}`)
    process.exit(1)
  }

  const allEntries = parseCargoToml(cargoContent)

  // 2. 根据参数过滤
  let entries = allEntries
  if (onlyDeps) entries = allEntries.filter(e => e.type === 'dep')
  else if (onlyBuild) entries = allEntries.filter(e => e.type === 'build')
  else if (onlyDev) entries = allEntries.filter(e => e.type === 'dev')

  if (entries.length === 0) {
    console.log('没有需要检查的依赖。')
    return
  }

  // 3. 读取 Cargo.lock 获取锁定版本
  const lockVersions = parseCargoLock()

  console.log(
    `\n${c.bold}🦀 正在检查 ${entries.length} 个 Rust 依赖的最新版本...${c.reset}\n`,
  )

  // 4. 并发获取 crates.io 最新版本
  const start = Date.now()
  const infos = await withConcurrency(entries, 10, async ({ name, version, type }) => {
    const result: CrateVersion = {
      name,
      type,
      wanted: version,
      current: lockVersions.get(name) || normalizeCargoVersion(version),
      latest: '?',
      status: 'error',
    }
    try {
      const latest = await fetchLatestVersion(name)
      if (latest === null) {
        result.error = 'crate not found'
        result.latest = 'N/A'
        result.status = 'error'
      } else {
        result.latest = latest
        result.status = getStatus(normalizeCargoVersion(result.current), latest)
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e)
      result.latest = 'ERR'
    }
    return result
  })

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  // 5. 应用版本过滤
  let filtered = infos
  if (majorOnly) {
    filtered = infos.filter(i => i.status === 'major')
  } else if (minorOnly) {
    filtered = infos.filter(i => i.status === 'major' || i.status === 'minor')
  }

  // 6. 输出表格
  const maxNameLen = Math.max(...filtered.map(i => i.name.length), 6)

  const header =
    `${c.bold}${'Name'.padEnd(maxNameLen + 2)} ${'Current'.padEnd(13)} ${'Latest'.padEnd(13)} ${'Type'.padEnd(7)} Status${c.reset}`
  console.log(header)
  console.log('─'.repeat(maxNameLen + 2 + 13 + 13 + 7 + 6))

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

  const typeLabels: Record<string, string> = {
    dep: c.blue + 'dep' + c.reset,
    build: c.magenta + 'build' + c.reset,
    dev: c.dim + 'dev' + c.reset,
  }

  let counts: Record<string, number> = { 'up-to-date': 0, patch: 0, minor: 0, major: 0, error: 0 }

  for (const info of filtered) {
    const color = statusColors[info.status] || c.reset
    const icon = statusIcons[info.status] || info.status
    const typeLabel = typeLabels[info.type] || info.type

    const dispLatest = info.status === 'error'
      ? (info.error || info.latest).substring(0, 12)
      : info.latest

    console.log(
      `${color}${info.name.padEnd(maxNameLen + 2)} ${info.current.padEnd(13)} ${dispLatest.padEnd(13)} ${typeLabel}   ${icon}${c.reset}`,
    )

    counts[info.status]++
  }

  // 7. 汇总
  console.log('─'.repeat(maxNameLen + 2 + 13 + 13 + 7 + 6))
  const total = filtered.length
  console.log(
    `\n${c.bold}总计: ${total}${c.reset} 个 crate（耗时 ${elapsed}s）`,
  )
  console.log(
    `  ${c.green}✅ 最新: ${counts['up-to-date']}${c.reset}  ${c.cyan}📌 补丁: ${counts.patch}${c.reset}  ${c.yellow}⬆️  次版本: ${counts.minor}${c.reset}  ${c.red}🚀 大版本: ${counts.major}${c.reset}  ${c.dim}❌ 出错: ${counts.error}${c.reset}`,
  )

  if (counts.major > 0) {
    console.log(
      `\n${c.yellow}💡 提示: 大版本更新可能包含 breaking changes，请参考 CHANGELOG 后谨慎更新。${c.reset}`,
    )
  }

  console.log()
}

main().catch(console.error)
