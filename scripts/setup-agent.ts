/**
 * Agent 环境初始化脚本（使用 uv 管理 Python 环境）
 *
 * uv 比传统 venv + pip 快 10-100 倍，统一管理 Python 版本和依赖。
 * 安装 uv：brew install uv / pip install uv / https://docs.astral.sh/uv/
 *
 * 用法：
 *   npx tsx scripts/setup-agent.ts              # 安装 Python 依赖（uv sync）
 *   npx tsx scripts/setup-agent.ts --check      # 仅检查环境
 *   npx tsx scripts/setup-agent.ts --download-models  # 下载本地模型
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const AGENT_DIR = join(import.meta.dirname, '..', 'agent')
const MODELS_DIR = join(AGENT_DIR, 'models')
const VENV_DIR = join(AGENT_DIR, '.venv')

interface CheckResult {
  ok: boolean
  message: string
}

// ─── 环境检查 ───

function checkUv(): CheckResult {
  try {
    const result = execSync('uv --version', { encoding: 'utf-8' }).trim()
    return { ok: true, message: `✅ ${result}` }
  } catch {
    return {
      ok: false,
      message: '❌ 未找到 uv，请安装：brew install uv 或 pip install uv（https://docs.astral.sh/uv/）',
    }
  }
}

function checkPython(): CheckResult {
  // uv 可以自动管理 Python 版本，先检查系统 Python
  try {
    const result = execSync('uv python --version', { encoding: 'utf-8' }).trim()
    const match = result.match(/(?:Python )?(\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1])
      const minor = parseInt(match[2])
      if (major >= 3 && minor >= 14) {
        return { ok: true, message: `✅ ${result}` }
      }
      return {
        ok: false,
        message: `❌ Python 版本过低: ${result}，需要 >= 3.14。运行: uv python install 3.14.6`,
      }
    }
    return { ok: true, message: `✅ ${result}` }
  } catch {
    // uv python 不可用，回退到系统 python3
    try {
      const result = execSync('python3 --version', { encoding: 'utf-8' }).trim()
      const match = result.match(/Python (\d+)\.(\d+)/)
      if (match && parseInt(match[1]) >= 3 && parseInt(match[2]) >= 14) {
        return { ok: true, message: `✅ ${result}（系统）` }
      }
      return { ok: true, message: `✅ ${result}（系统）` }
    } catch {
      return { ok: false, message: '❌ 未找到 Python 3.14+。运行: uv python install 3.14.6' }
    }
  }
}

function checkOllama(): CheckResult {
  try {
    const result = execSync('ollama --version', { encoding: 'utf-8' }).trim()
    return { ok: true, message: `✅ ${result}` }
  } catch {
    return {
      ok: false,
      message: '⚠️ 未找到 Ollama（本地模型功能不可用，云端 API 不受影响）',
    }
  }
}

function checkVenv(): CheckResult {
  if (existsSync(join(VENV_DIR, 'bin', 'python'))) {
    return { ok: true, message: '✅ .venv 已就绪' }
  }
  if (existsSync(join(VENV_DIR, 'Scripts', 'python.exe'))) {
    return { ok: true, message: '✅ .venv 已就绪' }
  }
  return { ok: false, message: '⚠️ .venv 未创建' }
}

// ─── 安装依赖 ───

function syncDependencies(): void {
  console.log('⚡ 使用 uv sync 同步依赖...')
  // uv sync 自动创建 .venv 并安装全部依赖，速度是 pip 的 10-100 倍
  execSync('uv sync', { cwd: AGENT_DIR, stdio: 'inherit' })
}

function pullOllamaModel(modelName: string): void {
  console.log(`下载 Ollama 模型: ${modelName}...`)
  try {
    execSync(`ollama pull ${modelName}`, { stdio: 'inherit' })
  } catch {
    console.warn(`⚠️ 模型 ${modelName} 下载失败，请手动运行: ollama pull ${modelName}`)
  }
}

// ─── 主逻辑 ───

async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const downloadModels = args.includes('--download-models')

  console.log('═══════════════════════════════════════')
  console.log('  MirageInk Agent 环境初始化 (uv)')
  console.log('═══════════════════════════════════════\n')

  // 环境检查
  const checks = [checkUv(), checkPython(), checkOllama(), checkVenv()]

  let allOk = true
  for (const check of checks) {
    console.log(`  ${check.message}`)
    if (!check.ok) allOk = false
  }

  if (checkOnly) {
    if (allOk) {
      console.log('\n✅ 所有检查通过，Agent 环境就绪')
    } else {
      console.log('\n⚠️ 部分检查未通过，请修复后重试')
    }
    return
  }

  // 安装依赖（uv sync 一步完成：创建 venv + 安装依赖）
  console.log('\n── 同步依赖 ──')
  syncDependencies()

  // 下载模型
  if (downloadModels) {
    console.log('\n── 下载本地模型 ──')
    mkdirSync(MODELS_DIR, { recursive: true })
    pullOllamaModel('qwen2.5:7b') // 默认本地模型
  }

  console.log('\n═══════════════════════════════════════')
  console.log('  ✅ Agent 环境初始化完成')
  console.log('  启动方式:')
  console.log('    uv run --directory agent python main.py')
  console.log('    cd agent && .venv/bin/python main.py')
  console.log('  或由 Rust Core 自动管理进程')
  console.log('═══════════════════════════════════════')
}

main().catch((err) => {
  console.error('初始化失败:', err)
  process.exit(1)
})
