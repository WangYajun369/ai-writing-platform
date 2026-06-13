#!/usr/bin/env node
/**
 * 检测 Python 项目依赖的当前版本与最新版本
 *   - Python 工具链 (python/uv)
 *   - Python 依赖 (agent/pyproject.toml)
 *
 * 用法: npx tsx scripts/check-python-versions.ts
 * 可选参数:
 *   --major   只显示有 major 版本更新的依赖
 *   --minor   只显示有 major 或 minor 版本更新的依赖
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')
const AGENT_DIR = join(ROOT, 'agent')

// ========== 类型定义 ==========
interface PythonDepInfo {
  name: string
  wanted: string           // pyproject.toml 中的约束
  current: string          // 已安装版本
  latest: string
  status: 'up-to-date' | 'patch' | 'minor' | 'major' | 'error'
  license: string
  error?: string
}

interface PythonToolchainInfo {
  python: { version: string; latest: string; license: string }
  uv: { version: string; latest: string; license: string }
}

// ========== 命令行参数解析 ==========
const args = process.argv.slice(2)
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
}

// ========== 版本比较工具 ==========
function parseSemver(version: string): [number, number, number, string] {
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

function getStatus(current: string, latest: string): PythonDepInfo['status'] {
  const [cMaj, cMin, cPat] = parseSemver(current)
  const [lMaj, lMin, lPat] = parseSemver(latest)
  if (lMaj > cMaj) return 'major'
  if (lMin > cMin) return 'minor'
  if (lPat > cPat) return 'patch'
  return 'up-to-date'
}

// ========== Python 工具链版本检测 ==========
async function getPythonToolchainInfo(): Promise<PythonToolchainInfo> {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }

  // 优先使用 uv 管理的 Python（在 agent 目录下）
  let pythonRaw = run(`cd "${AGENT_DIR}" && uv run python --version`)
  if (!pythonRaw) pythonRaw = run('python3 --version')
  if (!pythonRaw) pythonRaw = run('python --version')
  if (!pythonRaw) pythonRaw = run('python3.14 --version')

  const pythonVer = pythonRaw.replace(/^Python\s+/, '').trim() || 'N/A'

  // uv 版本
  const uvRaw = run('uv --version')
  const uvMatch = uvRaw.match(/(\d+\.\d+\.\d+)/)
  const uvVer = uvMatch ? uvMatch[1] : (uvRaw || 'N/A')

  let pythonLatest = pythonVer
  let uvLatest = uvVer

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

  // Python 最新版本（从 python.org）
  try {
    const releases = await fetchJson(
      'https://www.python.org/api/v2/downloads/release/',
    ) as Array<{ name: string; is_latest: boolean }> | null
    if (releases) {
      const latest = releases.find(r => r.is_latest && r.name?.startsWith('3.'))
      if (latest) {
        const verMatch = latest.name.match(/^(\d+\.\d+\.\d+)/)
        if (verMatch) pythonLatest = verMatch[1]
      }
    }
  } catch { /* ignore */ }

  // uv 最新版本（从 PyPI）
  try {
    const data = await fetchJson('https://pypi.org/pypi/uv/json')
    if (data?.info && (data.info as Record<string, unknown>).version) {
      uvLatest = (data.info as Record<string, unknown>).version as string
    }
  } catch { /* ignore */ }

  return {
    python: { version: pythonVer, latest: pythonLatest, license: 'PSF' },
    uv: { version: uvVer, latest: uvLatest, license: 'MIT/Apache-2.0' },
  }
}

// ========== 解析 pyproject.toml 中的 Python 依赖 ==========
function parsePyprojectDeps(): { name: string; wanted: string }[] {
  try {
    const content = readFileSync(join(AGENT_DIR, 'pyproject.toml'), 'utf-8')
    // 找到 dependencies = [ 起始位置
    const startMatch = content.match(/dependencies\s*=\s*\[/)
    if (!startMatch || startMatch.index === undefined) return []

    // 括号计数，跳过嵌套的 []（如 uvicorn[standard]）找到匹配的 ]
    const startPos = startMatch.index + startMatch[0].length - 1 // 指向 [
    let depth = 0
    let endPos = -1
    for (let i = startPos; i < content.length; i++) {
      if (content[i] === '[') depth++
      else if (content[i] === ']') {
        depth--
        if (depth === 0) { endPos = i; break }
      }
    }
    if (endPos === -1) return []

    const arrayContent = content.substring(startPos + 1, endPos)

    const deps: { name: string; wanted: string }[] = []
    const lines = arrayContent.split('\n')
    for (const line of lines) {
      // 匹配 "package-name>=version" 或 "package-name[extra]>=version"
      const match = line.match(/^\s*"([a-zA-Z0-9_-]+)(?:\[[^\]]*\])?\s*([><=!]+\s*[\d.]+(?:\s*,\s*[><=!]+\s*[\d.]+)*)?"/)
      if (match && match[1]) {
        const name = match[1]
        const constraint = match[2] ? match[2].trim() : '*'
        deps.push({ name, wanted: constraint })
      }
    }
    return deps
  } catch {
    return []
  }
}

// ========== 获取已安装的 Python 依赖版本（通过 uv）==========
function getInstalledPythonDeps(depNames: string[]): Map<string, string> {
  const map = new Map<string, string>()

  // 优先使用 uv pip list（在 agent 目录下，自动使用 uv 管理的 venv）
  try {
    const result = execSync(
      `cd "${AGENT_DIR}" && uv pip list --format json`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
    )
    const pkgs = JSON.parse(result) as Array<{ name: string; version: string }>
    const nameSet = new Set(depNames)
    for (const pkg of pkgs) {
      if (nameSet.has(pkg.name)) {
        map.set(pkg.name, pkg.version)
      }
    }
    return map
  } catch {
    // uv pip list 失败时回退到逐个查询
  }

  // 回退方案：逐个用 pip show 查询
  for (const name of depNames) {
    try {
      const result = execSync(
        `python3 -m pip show "${name}" 2>/dev/null || python -m pip show "${name}" 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      )
      const verMatch = result.match(/^Version:\s*(.+)$/m)
      if (verMatch) {
        map.set(name, verMatch[1].trim())
      }
    } catch {
      // 未安装
    }
  }
  return map
}

// ========== 从 PyPI 获取最新版本 ==========
async function fetchLatestPyPIVersion(pkgName: string): Promise<{ version: string; license: string }> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(pkgName)}/json`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const r = await fetch(url, { signal: controller.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = (await r.json()) as {
      info: {
        version: string
        license?: string | null
        license_expression?: string | null
        classifiers?: string[]
      }
    }

    // 从多来源提取 license（优先级从高到低）
    let license = 'Unknown'

    // 1. license_expression（最标准）
    if (data.info.license_expression) {
      license = data.info.license_expression
    }
    // 2. classifiers 中的 license 条目
    else if (data.info.classifiers) {
      const licClassifier = data.info.classifiers.find(c => c.startsWith('License ::'))
      if (licClassifier) {
        // 提取 "License :: OSI Approved :: MIT License" → "MIT License"
        const parts = licClassifier.split(' :: ')
        license = parts[parts.length - 1]
      }
    }
    // 3. info.license 原始字段（兼容旧包）
    else if (data.info.license) {
      license = data.info.license
    }

    return { version: data.info.version, license }
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

// ========== 辅助：打印工具行 ==========
function printTool(
  name: string,
  version: string,
  latest: string,
  license: string,
) {
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

// ========== 主逻辑 ==========
async function main() {
  // 1. 打印 Python 工具链信息
  const pythonToolchain = await getPythonToolchainInfo()

  console.log(`\n${c.bold}🐍 Python 工具链环境:${c.reset}`)
  console.log(
    `${c.dim}  ${'工具'.padEnd(12)} ${'当前版本'.padEnd(14)} ${'最新版本'.padEnd(14)} ${'协议'.padEnd(18)}${c.reset}`,
  )
  console.log(c.dim + '  ' + '─'.repeat(58) + c.reset)

  printTool('python', pythonToolchain.python.version, pythonToolchain.python.latest, pythonToolchain.python.license)
  printTool('uv', pythonToolchain.uv.version, pythonToolchain.uv.latest, pythonToolchain.uv.license)

  // 2. 解析 pyproject.toml 依赖
  const pyDeps = parsePyprojectDeps()
  if (pyDeps.length === 0) {
    console.log(`\n${c.dim}  未找到 agent/pyproject.toml，无 Python 依赖可检查。${c.reset}\n`)
    return
  }

  const pyDepNames = pyDeps.map(d => d.name)
  const installedDeps = getInstalledPythonDeps(pyDepNames)

  console.log(`\n${c.bold}🐍 Python 依赖 (agent/pyproject.toml):${c.reset}\n`)

  // 3. 并发获取 PyPI 最新版本
  const start = Date.now()
  const pyInfos = await withConcurrency(pyDeps, 10, async ({ name, wanted }) => {
    const result: PythonDepInfo = {
      name,
      wanted,
      current: installedDeps.get(name) || 'N/A',
      latest: '?',
      license: '?',
      status: 'error',
    }
    try {
      const fetched = await fetchLatestPyPIVersion(name)
      result.latest = fetched.version
      result.license = fetched.license
      if (result.current !== 'N/A') {
        result.status = getStatus(result.current, result.latest)
      } else {
        result.status = 'up-to-date'
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e)
    }
    return result
  })

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  // 4. 筛选
  let filtered = pyInfos
  if (majorOnly) {
    filtered = pyInfos.filter(i => i.status === 'major')
  } else if (minorOnly) {
    filtered = pyInfos.filter(i => i.status === 'major' || i.status === 'minor')
  }

  // 5. 输出表格
  const maxNameLen = Math.max(...filtered.map(i => i.name.length), 6)

  const header = `${c.bold}${'Name'.padEnd(maxNameLen + 2)} ${'Current'.padEnd(14)} ${'Latest'.padEnd(14)} ${'Constraint'.padEnd(14)} ${'Status'.padEnd(10)} ${'License'.padEnd(16)}${c.reset}`
  console.log(header)
  console.log(c.dim + '─'.repeat(80) + c.reset)

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

    const diff = info.status === 'error'
      ? info.error?.substring(0, 24) || '?'
      : info.latest

    console.log(
      `${color}${info.name.padEnd(maxNameLen + 2)} ${info.current.padEnd(14)} ${diff.padEnd(14)} ${info.wanted.padEnd(14)} ${icon.padEnd(10)} ${(info.license || 'N/A').padEnd(16)}${c.reset}`,
    )

    counts[info.status]++
  }

  // 6. 汇总
  console.log(c.dim + '─'.repeat(80) + c.reset)
  const total = filtered.length
  console.log(
    `\n${c.bold}Python 依赖总计: ${total}${c.reset} 个包（耗时 ${elapsed}s）`,
  )
  console.log(
    `  ${c.green}✅ 最新: ${counts['up-to-date']}${c.reset}  ${c.cyan}📌 补丁: ${counts.patch}${c.reset}  ${c.yellow}⬆️  次版本: ${counts.minor}${c.reset}  ${c.red}🚀 大版本: ${counts.major}${c.reset}  ${c.dim}❌ 出错: ${counts.error}${c.reset}`,
  )

  if (counts.major > 0) {
    console.log(
      `\n${c.yellow}💡 提示: Python 依赖大版本更新可能包含 breaking changes，请谨慎更新。${c.reset}`,
    )
  }

  console.log()
}

main().catch(console.error)
