/**
 * Agent 环境初始化脚本
 *
 * 用于开发环境和构建流程中准备 Python Agent Server 的依赖。
 *
 * 用法：
 *   npx tsx scripts/setup-agent.ts          # 安装 Python 依赖
 *   npx tsx scripts/setup-agent.ts --check  # 仅检查环境
 *   npx tsx scripts/setup-agent.ts --download-models  # 下载本地模型
 */

import { execSync, spawnSync } from 'child_process'
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

function checkPython(): CheckResult {
  try {
    const result = execSync('python3 --version', { encoding: 'utf-8' }).trim()
    const match = result.match(/Python (\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1])
      const minor = parseInt(match[2])
      if (major >= 3 && minor >= 10) {
        return { ok: true, message: `✅ ${result}` }
      }
      return {
        ok: false,
        message: `❌ Python 版本过低: ${result}，需要 >= 3.10`,
      }
    }
    return { ok: true, message: `✅ ${result}` }
  } catch {
    return { ok: false, message: '❌ 未找到 Python 3.10+' }
  }
}

function checkPip(): CheckResult {
  try {
    execSync('python3 -m pip --version', { encoding: 'utf-8' })
    return { ok: true, message: '✅ pip 可用' }
  } catch {
    return { ok: false, message: '❌ pip 不可用' }
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
    return { ok: true, message: '✅ 虚拟环境已创建' }
  }
  return { ok: false, message: '⚠️ 虚拟环境未创建' }
}

// ─── 安装依赖 ───

function createVenv(): void {
  if (existsSync(join(VENV_DIR, 'bin', 'python'))) {
    console.log('虚拟环境已存在，跳过创建')
    return
  }
  console.log('创建 Python 虚拟环境...')
  execSync(`python3 -m venv ${VENV_DIR}`, { stdio: 'inherit' })
}

function installDependencies(): void {
  console.log('安装 Python 依赖...')
  const pip = join(VENV_DIR, 'bin', 'pip')
  execSync(
    `${pip} install -r ${join(AGENT_DIR, 'requirements.txt')}`,
    { stdio: 'inherit' },
  )
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
  console.log('  MirageInk Agent 环境初始化')
  console.log('═══════════════════════════════════════\n')

  // 环境检查
  const checks = [checkPython(), checkPip(), checkOllama(), checkVenv()]

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

  // 安装依赖
  console.log('\n── 安装依赖 ──')
  createVenv()
  installDependencies()

  // 下载模型
  if (downloadModels) {
    console.log('\n── 下载本地模型 ──')
    mkdirSync(MODELS_DIR, { recursive: true })
    pullOllamaModel('qwen2.5:7b') // 默认本地模型
  }

  console.log('\n═══════════════════════════════════════')
  console.log('  ✅ Agent 环境初始化完成')
  console.log('  启动方式:')
  console.log(`    cd agent && ${join(VENV_DIR, 'bin', 'python')} main.py`)
  console.log('  或由 Rust Core 自动管理进程')
  console.log('═══════════════════════════════════════')
}

main().catch((err) => {
  console.error('初始化失败:', err)
  process.exit(1)
})
