#!/usr/bin/env node
/**
 * Node.js 版本管理工具（基于 nvm）
 *
 * 用法:
 *   npx tsx scripts/node-manager.ts          交互式选择菜单（推荐）
 *   npx tsx scripts/node-manager.ts --status  显示状态面板
 *   npx tsx scripts/node-manager.ts --use lts 命令行模式
 *   ... (其他 CLI 参数向下兼容)
 *
 * 注意: nvm use 需在 shell 中执行，脚本会输出待执行的命令。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')

// ========== 颜色 ==========
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

// ========== NVM 辅助 ==========
const NVM_DIR = process.env.NVM_DIR || `${process.env.HOME}/.nvm`

function runNvm(cmd: string): string {
  try {
    return execSync(
      `. "${NVM_DIR}/nvm.sh" 2>/dev/null && ${cmd}`,
      {
        encoding: 'utf-8',
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    ).trim()
  } catch {
    return ''
  }
}

function checkNvm(): boolean {
  const hasNvmSh = existsSync(`${NVM_DIR}/nvm.sh`)
  if (!hasNvmSh) {
    console.log(`${c.red}❌ 未找到 nvm，请先安装:${c.reset}`)
    console.log(`${c.dim}   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash${c.reset}`)
    return false
  }
  return true
}

// ========== 版本解析 ==========
interface NodeVersion {
  version: string  // 完整版本号，如 v24.12.0
  major: number
  codename?: string
  isLts: boolean
}

function parseNodeVersion(v: string): NodeVersion {
  const match = v.match(/v?(\d+)\.(\d+)\.(\d+)/)
  const major = match ? parseInt(match[1], 10) : 0
  return { version: match ? `v${match[1]}.${match[2]}.${match[3]}` : v, major, isLts: major % 2 === 0 }
}

function parseInstalledVersions(raw: string): NodeVersion[] {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^v\d+\.\d+\.\d+/.test(line.replace('->', '').trim()))
    .map(line => {
      const v = line.replace('->', '').replace(/\*.*$/, '').trim()
      return parseNodeVersion(v)
    })
}

// ========== 状态面板 ==========
function showStatus() {
  if (!checkNvm()) return

  const currentRaw = runNvm('nvm current')
  const current = currentRaw || runNvm('node --version')
  const installedRaw = runNvm('nvm ls --no-colors')
  const installed = parseInstalledVersions(installedRaw)
  const defaultRaw = runNvm('nvm alias default --no-colors')
  const defaultMatch = defaultRaw.match(/->\s+(\S+)/)
  const defaultVer = defaultMatch ? defaultMatch[1] : ''

  // 读取项目要求
  let requiredNode = ''
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    requiredNode = pkg?.engines?.node || ''
  } catch { /* ignore */ }

  const nvmrcPath = join(ROOT, '.nvmrc')
  const nvmrcVer = existsSync(nvmrcPath)
    ? readFileSync(nvmrcPath, 'utf-8').trim()
    : ''

  // 满足性检查
  const currentMajor = parseInt(current.replace(/^v/, '').split('.')[0], 10) || 0
  const reqMin = parseInt((requiredNode.match(/>=\s*(\d+)/) || ['', '0'])[1], 10)
  const meetsRequirement = reqMin === 0 || currentMajor >= reqMin

  // 分隔线
  const sep = c.dim + '  ' + '─'.repeat(50) + c.reset

  console.log(`\n${c.bold}🟢 Node.js 版本管理${c.reset}\n`)
  console.log(sep)

  // 当前版本
  console.log(`\n${c.bold}📌 当前版本${c.reset}`)
  const cleanCurrent = current.replace(/^v/, '')
  console.log(`  Node    : ${c.cyan}${cleanCurrent}${c.reset}`)
  if (defaultVer) {
    console.log(`  默认    : ${c.dim}${defaultVer}${c.reset}`)
  }

  // 项目要求
  if (requiredNode) {
    const icon = meetsRequirement ? '✅' : '❌'
    const color = meetsRequirement ? c.green : c.red
    console.log(`\n${c.bold}📋 项目要求${c.reset}`)
    console.log(`  engines : ${c.dim}node ${requiredNode}${c.reset}`)
    console.log(`  状态    : ${color}${icon} ${meetsRequirement ? '满足' : '不满足'}${c.reset}`)
  }

  if (nvmrcVer) {
    const match = nvmrcVer === cleanCurrent || nvmrcVer === current
    console.log(`  .nvmrc  : ${c.dim}${nvmrcVer}${c.reset} ${match ? c.green + '✅' : c.yellow + '⚠️  与当前不一致'}${c.reset}`)
  } else {
    console.log(`  .nvmrc  : ${c.dim}(未创建)${c.reset}`)
  }

  // 已安装版本
  console.log(`\n${c.bold}📦 已安装版本${c.reset}`)
  if (installed.length === 0) {
    console.log('  (无)')
  } else {
    // 去重后按 major 分组显示
    const majorMap = new Map<number, string[]>()
    for (const v of installed) {
      if (!majorMap.has(v.major)) majorMap.set(v.major, [])
      majorMap.get(v.major)!.push(v.version)
    }
    const sortedMajors = [...majorMap.keys()].sort((a, b) => b - a)
    for (const major of sortedMajors) {
      const vers = majorMap.get(major)!
      const isCurrent = parseInt(current.replace(/^v/, '').split('.')[0], 10) === major
      const prefix = isCurrent ? `${c.green}→` : ' '
      const detail = vers.map(v => v === current ? `${c.green}${v}${c.reset}` : `${c.dim}${v}${c.reset}`).join(', ')
      const ltsIcon = major % 2 === 0 ? `${c.dim}[LTS]${c.reset}` : ''
      console.log(`  ${prefix} Node ${major} ${ltsIcon}: ${detail}`)
    }
  }

  // 推荐操作
  console.log(`\n${c.bold}💡 快捷操作${c.reset}`)
  console.log(`  ${c.dim}pnpm node                     ${c.reset}# 进入交互式菜单`)
  console.log(`  ${c.dim}pnpm node --use lts           ${c.reset}# 切换到最新 LTS`)
  console.log(`  ${c.dim}pnpm node --sync              ${c.reset}# 同步 .nvmrc`)
  console.log(`  ${c.dim}pnpm node --help              ${c.reset}# 查看帮助`)
  console.log()
}

// ========== 列出版本 ==========
function listInstalled() {
  if (!checkNvm()) return
  const raw = runNvm('nvm ls --no-colors')
  console.log(`\n${c.bold}📦 已安装的 Node 版本${c.reset}\n`)
  const lines = raw.split('\n')
  for (const line of lines) {
    // 跳过空别名行
    if (/(?:lts\/\*|iojs|unstable)\s*->\s*(?:N\/A|lts\/\w+)/.test(line)) continue
    // 跳过 lts/旧代号 → N/A 的未安装别名
    if (/lts\/\w+\s*->\s*\S+\s*\(->\s*N\/A\)/.test(line)) continue
    if (line.trim().startsWith('->')) {
      console.log(`  ${c.green}${line}${c.reset}`)
    } else if (/v\d+\.\d+\.\d+\s*\*/.test(line)) {
      console.log(`  ${c.dim}${line}${c.reset}`)
    } else if (/v\d+\.\d+\.\d+/.test(line.trim())) {
      console.log(`  ${c.dim}${line}${c.reset}`)
    } else if (line.trim()) {
      console.log(`  ${line}`)
    }
  }
  console.log()
}

function listRemote(count = 10) {
  if (!checkNvm()) return
  const raw = runNvm('nvm ls-remote --lts --no-colors')
  const lines = raw.split('\n').filter(l => /v\d+\.\d+\.\d+/.test(l))

  console.log(`\n${c.bold}🌐 远程 LTS 版本（最近 ${count} 个）${c.reset}\n`)
  console.log(`  ${c.dim}Version         LTS 代号${c.reset}`)
  console.log(`  ${c.dim}────────────────────────────${c.reset}`)

  const recent = lines.slice(-count)
  for (const line of recent) {
    // 清理行前缀（可能的 -> 箭头或空格）
    const clean = line.replace(/^->?\s+/, '').trim()
    const parts = clean.split(/\s+/)
    const ver = parts[0] || ''
    const ltsName = line.match(/\((?:Latest\s+)?LTS:\s*(\w+)\)/)?.[1] || ''
    const isLatest = line.includes('Latest LTS')
    const isCurrent = line.trim().startsWith('->')

    const marker = isCurrent ? `${c.green}→` : ' '
    const verColor = isLatest ? c.green : isCurrent ? c.yellow : c.dim

    console.log(
      `  ${marker} ${verColor}${ver.padEnd(16)}${c.reset} ${c.cyan}${ltsName}${c.reset}${isLatest ? ` ${c.green}(最新)${c.reset}` : ''}`,
    )
  }
  console.log()
}

// ========== 安装 & 切换 ==========
function installVersion(version: string) {
  if (!checkNvm()) return

  console.log(`\n${c.bold}📥 安装 Node ${version}...${c.reset}\n`)
  const result = runNvm(`nvm install ${version}`)
  console.log(result)

  // 检查是否安装成功
  const after = runNvm(`nvm ls ${version} --no-colors`)
  if (after.includes(version.replace(/^v/, '')) && !after.includes('N/A')) {
    console.log(`\n${c.green}✅ Node ${version} 安装成功${c.reset}`)
  } else {
    console.log(`\n${c.red}❌ 安装可能失败，请检查 nvm ls-remote 确认版本号${c.reset}`)
  }
}

function useVersion(version: string) {
  if (!checkNvm()) return

  // 规范化版本名
  let targetVersion = version
  if (version === 'lts') targetVersion = '--lts'
  else if (version === 'latest') targetVersion = 'node'

  // 先检查是否已安装
  const lsOutput = runNvm(`nvm ls ${targetVersion} --no-colors`)
  const alreadyInstalled = !lsOutput.includes('N/A') && /\d+\.\d+\.\d+/.test(lsOutput)

  if (!alreadyInstalled) {
    console.log(`\n${c.bold}📥 Node ${version} 未安装，正在安装...${c.reset}\n`)
    const result = runNvm(`nvm install ${targetVersion}`)
    console.log(result)
  }

  // 获取实际版本号
  const actualVerRaw = runNvm(`nvm version ${targetVersion}`)
  const actualVer = actualVerRaw.replace(/^v/, '') || version

  const nvmrcPath = join(ROOT, '.nvmrc')
  writeFileSync(nvmrcPath, actualVer + '\n')

  console.log(`\n${c.bold}✅ 已完成设置！${c.reset}`)
  console.log(`\n  版本   : ${c.cyan}${actualVer}${c.reset}`)
  console.log(`  .nvmrc : ${c.green}已更新 → ${actualVer}${c.reset}`)
  console.log(`\n${c.yellow}  请在终端中执行以下命令使版本生效:${c.reset}`)
  console.log(`\n  ${c.bold}  nvm use${c.reset}`)
  console.log(`\n  ${c.dim}# 或重新进入项目目录（.nvmrc 会自动触发）${c.reset}`)
  console.log(`  ${c.dim}  cd . && cd - > /dev/null${c.reset}`)
  console.log()
}

// ========== 卸载 ==========
function uninstallVersion(version: string) {
  if (!checkNvm()) return

  const current = runNvm('nvm current')
  if (current === version || current === `v${version}`) {
    console.log(`\n${c.yellow}⚠️  不能卸载当前正在使用的版本 (${current})${c.reset}`)
    console.log(`${c.dim}  请先切换到其他版本: nvm use <other-version>${c.reset}\n`)
    return
  }

  console.log(`\n${c.bold}🗑️  卸载 Node ${version}...${c.reset}\n`)
  const result = runNvm(`nvm uninstall ${version}`)
  console.log(result)
  console.log()
}

// ========== 设置默认 ==========
function setDefault(version: string) {
  if (!checkNvm()) return

  console.log(`\n${c.bold}🔧 设置默认 Node 版本为 ${version}...${c.reset}\n`)
  const result = runNvm(`nvm alias default ${version}`)
  console.log(result || `${c.green}✅ 默认版本已设置为 ${version}${c.reset}`)
  console.log()
}

// ========== 同步 .nvmrc ==========
function syncNvmrc() {
  if (!checkNvm()) return

  const current = runNvm('nvm current').replace(/^v/, '')
  const nvmrcPath = join(ROOT, '.nvmrc')

  writeFileSync(nvmrcPath, current + '\n')
  console.log(`\n${c.bold}✅ .nvmrc 已更新${c.reset}`)
  console.log(`  内容: ${c.green}${current}${c.reset}`)
  console.log(`\n  ${c.dim}# 之后进入项目目录时，nvm 会自动使用此版本（如已配置自动切换）${c.reset}\n`)
}

// ========== 帮助 ==========
function showHelp() {
  console.log(`\n${c.bold}🟢 Node.js 版本管理工具（基于 nvm）${c.reset}\n`)
  console.log(`${c.dim}用法:${c.reset}`)
  console.log(`  ${c.cyan}pnpm node${c.reset}                 交互式选择菜单（推荐）\n`)
  console.log(`${c.dim}命令行模式:${c.reset}`)
  console.log(`  ${c.cyan}--status${c.reset}            显示当前 Node 环境状态面板`)
  console.log(`  ${c.cyan}--use <version>${c.reset}     安装并准备切换到指定版本`)
  console.log(`                       支持: lts / 22 / 20.19.4 / jod / krypton`)
  console.log(`  ${c.cyan}--install <ver>${c.reset}     仅安装指定版本`)
  console.log(`  ${c.cyan}--uninstall <ver>${c.reset}   卸载指定版本`)
  console.log(`  ${c.cyan}--ls${c.reset}                列出已安装版本`)
  console.log(`  ${c.cyan}--ls-remote [N]${c.reset}    列出远程 LTS 版本（默认 10 个）`)
  console.log(`  ${c.cyan}--sync${c.reset}              根据当前版本创建/更新 .nvmrc`)
  console.log(`  ${c.cyan}--set-default <v>${c.reset}   设置新终端默认使用的 Node 版本`)
  console.log(`  ${c.cyan}--help${c.reset}              显示此帮助\n`)
  console.log(`${c.dim}注意: --use 完成后，请在终端执行 nvm use 使版本生效。${c.reset}`)
  console.log(`${c.dim}      .nvmrc 会在 cd 入目录时自动触发版本切换（需 nvm 配置）。${c.reset}\n`)
}

// ========== 交互式菜单 ==========
function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise(resolve => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `
    rl.question(prompt, answer => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function interactiveMenu() {
  if (!checkNvm()) return

  const MENU = [
    { key: '1', label: '📌 查看状态面板', action: () => showStatus() },
    { key: '2', label: '📥 安装并切换到指定版本 (--use)', action: () => menuUse() },
    { key: '3', label: '📦 仅安装指定版本 (--install)', action: () => menuInstall() },
    { key: '4', label: '🗑️  卸载指定版本 (--uninstall)', action: () => menuUninstall() },
    { key: '5', label: '📋 列出已安装版本 (--ls)', action: () => listInstalled() },
    { key: '6', label: '🌐 查看远程 LTS 版本 (--ls-remote)', action: () => menuLsRemote() },
    { key: '7', label: '🔄 同步 .nvmrc (--sync)', action: () => syncNvmrc() },
    { key: '8', label: '🔧 设置默认版本 (--set-default)', action: () => menuSetDefault() },
    { key: 'h', label: '❓ 查看帮助', action: () => showHelp() },
    { key: '0', label: '👋 退出', action: null as (() => void) | null },
  ]

  let running = true
  while (running) {
    console.log(`\n${c.bold}${c.cyan}╔══════════════════════════════════╗${c.reset}`)
    console.log(`${c.bold}${c.cyan}║${c.reset}    🟢 ${c.bold}Node.js 版本管理${c.reset}            ${c.bold}${c.cyan}║${c.reset}`)
    console.log(`${c.bold}${c.cyan}╚══════════════════════════════════╝${c.reset}`)
    console.log()
    for (const item of MENU) {
      const keyColor = item.key === '0' ? c.dim : c.cyan
      console.log(`  ${keyColor}[${item.key}]${c.reset} ${item.label}`)
    }
    console.log()

    const choice = await ask('请选择操作', '1')

    const selected = MENU.find(m => m.key === choice)
    if (!selected) {
      console.log(`\n${c.yellow}⚠️  无效选择: ${choice}，请输入菜单中的数字${c.reset}`)
      continue
    }

    if (selected.action === null) {
      console.log(`\n${c.green}👋 再见！${c.reset}\n`)
      running = false
      break
    }

    console.log(c.dim + '─'.repeat(50) + c.reset)
    try {
      await (selected.action() as unknown as Promise<void>)
    } catch (err) {
      console.log(`${c.red}❌ 操作失败: ${err}${c.reset}`)
    }
  }
}

async function menuUse() {
  const ver = await ask(
    `请输入版本号（如 lts、22、20.19.4、jod、krypton）`,
    'lts',
  )
  if (!ver) {
    console.log(`${c.yellow}⚠️  已取消${c.reset}`)
    return
  }
  useVersion(ver)
}

async function menuInstall() {
  const ver = await ask('请输入版本号（如 24.16.0、22）')
  if (!ver) {
    console.log(`${c.yellow}⚠️  已取消${c.reset}`)
    return
  }
  installVersion(ver)
}

async function menuUninstall() {
  const current = runNvm('nvm current').replace(/^v/, '')
  const lsRaw = runNvm('nvm ls --no-colors')
  const installed = parseInstalledVersions(lsRaw)
  console.log()
  for (const v of installed) {
    const marker = v.version === current || `v${current}` === v.version
      ? `${c.green}(当前)${c.reset}`
      : ''
    console.log(`  ${c.dim}${v.version}${c.reset} ${marker}`)
  }
  console.log()
  const ver = await ask('请输入要卸载的版本号（如 16.20.2）')
  if (!ver) {
    console.log(`${c.yellow}⚠️  已取消${c.reset}`)
    return
  }
  uninstallVersion(ver)
}

async function menuLsRemote() {
  const nStr = await ask('显示最近多少个版本', '10')
  const n = parseInt(nStr, 10) || 10
  listRemote(n)
}

async function menuSetDefault() {
  const ver = await ask('请输入要设为默认的版本号（如 24、lts/jod）')
  if (!ver) {
    console.log(`${c.yellow}⚠️  已取消${c.reset}`)
    return
  }
  setDefault(ver)
}

// ========== 主入口 ==========
async function main() {
  const args = process.argv.slice(2)

  // 无参数 → 交互式菜单
  if (args.length === 0) {
    await interactiveMenu()
    return
  }

  // --help / -h
  if (args.includes('--help') || args.includes('-h')) {
    showHelp()
    return
  }

  // --status（显式请求状态面板）
  if (args.includes('--status')) {
    showStatus()
    return
  }

  // CLI 模式
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--use': {
        const ver = args[++i]
        if (!ver) {
          console.log(`${c.red}❌ 请指定版本，例: --use lts${c.reset}`)
          return
        }
        useVersion(ver)
        break
      }
      case '--install': {
        const ver = args[++i]
        if (!ver) {
          console.log(`${c.red}❌ 请指定版本，例: --install 24.16.0${c.reset}`)
          return
        }
        installVersion(ver)
        break
      }
      case '--uninstall': {
        const ver = args[++i]
        if (!ver) {
          console.log(`${c.red}❌ 请指定版本，例: --uninstall 16.20.2${c.reset}`)
          return
        }
        uninstallVersion(ver)
        break
      }
      case '--ls':
        listInstalled()
        break
      case '--ls-remote': {
        const n = args[i + 1] && !args[i + 1].startsWith('--') ? parseInt(args[++i], 10) : 10
        listRemote(n)
        break
      }
      case '--sync':
        syncNvmrc()
        break
      case '--set-default': {
        const ver = args[++i]
        if (!ver) {
          console.log(`${c.red}❌ 请指定版本，例: --set-default 24${c.reset}`)
          return
        }
        setDefault(ver)
        break
      }
      default:
        if (!arg.startsWith('--')) {
          console.log(`${c.yellow}⚠️  未知参数: ${arg}，使用 --help 查看帮助${c.reset}`)
        }
    }
  }
}

main().catch(console.error)
