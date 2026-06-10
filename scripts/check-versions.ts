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
import { execSync } from 'child_process'
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
  license: string
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

// ========== Node.js 工具链版本检测 ==========
interface ToolchainInfo {
  node: { version: string; latest: string; license: string }
  pnpm: { version: string; latest: string; license: string }
  npm: { version: string; latest: string; license: string }
  tsx: { version: string; latest: string; license: string }
}

async function getToolchainInfo(): Promise<ToolchainInfo> {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }

  const extractVer = (s: string) => {
    const m = s.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : s || 'N/A'
  }

  const nodeRaw = run('node --version')
  const pnpmRaw = run('pnpm --version')
  const npmRaw = run('npm --version')
  const tsxRaw = run('npx tsx --version')

  const nodeVer = nodeRaw.replace(/^v/, '') || 'N/A'
  const pnpmVer = extractVer(pnpmRaw)
  const npmVer = extractVer(npmRaw)
  const tsxVer = extractVer(tsxRaw)

  // 获取最新版本
  let nodeLatest = ''
  let pnpmLatest = ''
  let npmLatest = ''
  let tsxLatest = ''

  const fetchJson = async (url: string, timeoutMs = 8000) => {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const r = await fetch(url, { signal: controller.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as Record<string, unknown>
    } catch {
      return null
    } finally {
      clearTimeout(t)
    }
  }

  // Node.js 最新 LTS 版本（从 nodejs.org 发布列表）
  try {
    const releases = (await fetchJson(
      'https://nodejs.org/download/release/index.json',
    )) as Array<{ version: string; lts: string | false }> | null
    if (releases) {
      const lts = releases.find(r => r.lts !== false)
      if (lts) nodeLatest = lts.version.replace(/^v/, '')
    }
  } catch { /* ignore */ }

  // pnpm 最新版本（从 npm registry）
  try {
    const data = await fetchJson('https://registry.npmjs.org/pnpm/latest')
    if (data?.version) pnpmLatest = data.version as string
  } catch { /* ignore */ }

  // npm 最新版本（从 npm registry）
  try {
    const data = await fetchJson('https://registry.npmjs.org/npm/latest')
    if (data?.version) npmLatest = data.version as string
  } catch { /* ignore */ }

  // tsx 最新版本（从 npm registry）
  try {
    const data = await fetchJson('https://registry.npmjs.org/tsx/latest')
    if (data?.version) tsxLatest = data.version as string
  } catch { /* ignore */ }

  if (!nodeLatest) nodeLatest = nodeVer
  if (!pnpmLatest) pnpmLatest = pnpmVer
  if (!npmLatest) npmLatest = npmVer
  if (!tsxLatest) tsxLatest = tsxVer

  return {
    node: { version: nodeVer, latest: nodeLatest, license: 'MIT' },
    pnpm: { version: pnpmVer, latest: pnpmLatest, license: 'MIT' },
    npm: { version: npmVer, latest: npmLatest, license: 'Artistic-2.0' },
    tsx: { version: tsxVer, latest: tsxLatest, license: 'MIT' },
  }
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
async function fetchLatestVersion(pkgName: string): Promise<{ version: string; license: string }> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as { version: string; license?: string | { type: string } }
    const license = typeof data.license === 'string' ? data.license
      : data.license?.type || 'Unknown'
    return { version: data.version, license }
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

  // 打印 Node.js 工具链信息
  const toolchain = await getToolchainInfo()

  console.log(`${c.bold}🔧 Node.js 工具链环境:${c.reset}`)
  console.log(
    `${c.dim}  ${'工具'.padEnd(12)} ${'当前版本'.padEnd(14)} ${'最新版本'.padEnd(14)} ${'协议'.padEnd(18)}${c.reset}`,
  )
  console.log(c.dim + '  ' + '─'.repeat(58) + c.reset)

  const printTool = (
    name: string,
    version: string,
    latest: string,
    license: string,
  ) => {
    const stale = version !== 'N/A' && version !== latest
    const statusIcon = version === 'N/A'
      ? c.red + '❌ 未检测到'
      : stale
        ? c.yellow + '⬆️  可升级'
        : c.green + '✅ 最新'
    const verColor = stale ? c.yellow : c.cyan
    const latestColor = stale ? c.yellow : c.green
    console.log(
      `  ${name.padEnd(12)} ${verColor}${version.padEnd(14)}${c.reset} ${latestColor}${latest.padEnd(14)}${c.reset} ${statusIcon.padEnd(14)}${c.reset} ${c.dim}${license}${c.reset}`,
    )
  }

  printTool('node', toolchain.node.version, toolchain.node.latest, toolchain.node.license)
  printTool('pnpm', toolchain.pnpm.version, toolchain.pnpm.latest, toolchain.pnpm.license)
  printTool('npm', toolchain.npm.version, toolchain.npm.latest, toolchain.npm.license)
  printTool('tsx', toolchain.tsx.version, toolchain.tsx.latest, toolchain.tsx.license)

  console.log()

  // 3. 并发获取最新版本
  const start = Date.now()
  const infos = await withConcurrency(entries, 15, async ({ name, wanted, type }) => {
    const result: VersionInfo = {
      name,
      type,
      wanted,
      current: lockVersions.get(name) || wanted.replace(/^[\^~]/, ''),
      latest: '?',
      license: '?',
      status: 'error',
    }
    try {
      const fetched = await fetchLatestVersion(name)
      result.latest = fetched.version
      result.license = fetched.license
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

  const header = `${c.bold}${'Name'.padEnd(maxNameLen + 2)} ${'Current'.padEnd(14)} ${'Latest'.padEnd(14)} ${'Type'.padEnd(6)} ${'Status'.padEnd(10)} ${'License'.padEnd(16)}${c.reset}`
  console.log(header)
  console.log('─'.repeat(header.length - c.bold.length * 2 - c.reset.length * 2 + 10 + 21))

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
      `${color}${info.name.padEnd(maxNameLen + 2)} ${(info.current).padEnd(14)} ${(diff).padEnd(14)} ${typeLabel} ${icon.padEnd(10)} ${(info.license || 'N/A').padEnd(16)}${c.reset}`,
    )

    counts[info.status]++
  }

  // 6. 汇总
  console.log('─'.repeat(header.length - c.bold.length * 2 - c.reset.length * 2 + 10 + 21))
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
