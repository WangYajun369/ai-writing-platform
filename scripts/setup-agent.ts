/**
 * Agent 环境初始化脚本（使用 uv 管理 Python 环境）
 *
 * 默认使用可重定位 venv（将 Python 二进制复制到 .venv 内，非 symlink），
 * 整个 agent/.venv 目录可独立打包分发，用户无需安装 Python 运行时。
 * 如需快速迭代，可使用 --dev 切回 symlink 模式。
 *
 * 安装 uv：brew install uv / pip install uv，详见 https://docs.astral.sh/uv/
 *
 * @example
 *   npx tsx scripts/setup-agent.ts                  # 默认：可重定位 venv（打包用）
 *   npx tsx scripts/setup-agent.ts --dev            # 开发模式：uv sync symlink venv
 *   npx tsx scripts/setup-agent.ts --check          # 仅检查环境，不做任何安装
 *   npx tsx scripts/setup-agent.ts --download-models # 额外下载本地 LLM 模型
 */

import { execSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'

const PROJECT_DIR = join(import.meta.dirname, '..')
const AGENT_DIR = join(PROJECT_DIR, 'agent')
const MODELS_DIR = join(AGENT_DIR, 'models')
const VENV_DIR = join(AGENT_DIR, '.venv')
const PYTHON_VERSION_FILE = join(AGENT_DIR, '.python-version')

/** 环境检查结果的统一数据结构 */
interface CheckResult {
  ok: boolean
  message: string
}

/**
 * 从 agent/.python-version 读取目标 Python 版本
 *
 * 该文件由 uv 管理，指定项目所需的精确 Python 版本（如 3.14.2）。
 * 解析失败时回退到最低支持版本 3.11。
 *
 * @returns major/minor 版本号及 "major.minor" 格式的键名
 */
function readPythonVersion(): { major: number; minor: number; versionKey: string } {
  try {
    const content = readFileSync(PYTHON_VERSION_FILE, 'utf-8').trim()
    const match = content.match(/^(\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1])
      const minor = parseInt(match[2])
      return { major, minor, versionKey: `${major}.${minor}` }
    }
  } catch {
    // 文件不存在或无法解析，使用回退值
  }
  const fallbackMajor = 3
  const fallbackMinor = 11
  console.warn(`⚠️ 无法读取 ${PYTHON_VERSION_FILE}，回退到 ${fallbackMajor}.${fallbackMinor}`)
  return { major: fallbackMajor, minor: fallbackMinor, versionKey: `${fallbackMajor}.${fallbackMinor}` }
}

// ─── 环境检查 ───

/** 检查 uv 包管理器是否可用 */
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

/** 检查系统 Python 版本是否满足 agent/.python-version 的要求 */
function checkPython(): CheckResult {
  try {
    const required = readPythonVersion()
    const result = execSync('python3 --version', { encoding: 'utf-8' }).trim()
    const match = result.match(/Python (\d+)\.(\d+)/)
    if (match) {
      const major = parseInt(match[1])
      const minor = parseInt(match[2])
      if (major > required.major || (major === required.major && minor >= required.minor)) {
        return { ok: true, message: `✅ ${result}（系统）` }
      }
      return {
        ok: false,
        message: `❌ Python 版本过低: ${result}，需要 >= ${required.versionKey}。运行: uv python install ${required.versionKey}`,
      }
    }
    return { ok: true, message: `✅ ${result}（系统）` }
  } catch {
    const required = readPythonVersion()
    return {
      ok: false,
      message: `❌ 未找到 Python ${required.versionKey}+。运行: uv python install ${required.versionKey}`,
    }
  }
}

/** 检查 Ollama 本地 LLM 运行时是否可用（仅用于本地模型，云端 API 不需要） */
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

/** 返回 venv 内 Python 解释器的路径（处理 Windows/macOS/Linux 差异） */
function pythonInVenv(): string {
  if (process.platform === 'win32') {
    return join(VENV_DIR, 'Scripts', 'python.exe')
  }
  return join(VENV_DIR, 'bin', 'python')
}

/** 检查 .venv 目录是否已创建 */
function checkVenv(): CheckResult {
  if (existsSync(pythonInVenv())) {
    return { ok: true, message: '✅ .venv 已就绪' }
  }
  return { ok: false, message: '⚠️ .venv 未创建' }
}

// ─── 安装依赖 ───

/** 开发模式：通过 uv sync 创建 symlink venv，速度快，适合本地迭代 */
function syncDevDependencies(): void {
  console.log('⚡ 使用 uv sync 同步依赖...')
  execSync('uv sync', { cwd: AGENT_DIR, stdio: 'inherit' })
}

/**
 * 默认模式：创建自包含、可任意移动的 venv（Python 二进制复制到 .venv 内）
 *
 * 核心策略：用 uv python install 获取 python-build-standalone，创建 venv 后
 * 将 Python 二进制和 libpython 从 symlink 替换为真实复制文件，使整个
 * agent/.venv 目录可独立打包分发，用户无需安装任何 Python 运行时。
 *
 * 流程分 7 步：
 *   1. 安装 standalone Python（python-build-standalone）
 *   2. 定位 uv 安装的 Python 路径
 *   3. 清理旧 venv
 *   4. 创建新 venv（基于 standalone Python）
 *   5. 将 symlink 替换为真实文件（关键步骤）
 *   6. 安装 Python 依赖
 *   7. 验证 venv 自包含性
 */
function syncRelocatableDependencies(): void {
  const { versionKey: pythonVer } = readPythonVersion()
  console.log(`📦 安装 Python ${pythonVer}+ (python-build-standalone)...`)

  // 1. 使用 uv 安装 python-build-standalone（独立可重定位的 Python）
  execSync(`uv python install ">=${pythonVer}"`, { stdio: 'inherit' })

  // 2. 使用 uv python find 定位已安装的 standalone Python
  const isWin = process.platform === 'win32'
  let standalonePython = ''
  try {
    standalonePython = execSync(`uv python find ${pythonVer}`, {
      encoding: 'utf-8',
    }).trim()
  } catch {
    // uv python find 可能会失败，回退到目录扫描
  }

  // Fallback: 如果 uv python find 失败，扫描可能的安装目录
  if (!standalonePython || !existsSync(standalonePython)) {
    const possibleRoots = isWin
      ? [
          resolve(homedir(), '.local', 'share', 'uv', 'python'),
          resolve(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'uv', 'python'),
        ]
      : [resolve(homedir(), '.local', 'share', 'uv', 'python')]

    let found = false
    for (const root of possibleRoots) {
      if (!existsSync(root)) continue
      const entries = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
      const match = entries.find(e => e.name.startsWith(`cpython-${pythonVer}.`))
      if (match) {
        // 尝试 Windows 路径（无 bin/ 子目录）和 Unix 路径（有 bin/ 子目录）
        for (const binSubdir of isWin ? ['', 'bin'] : ['bin']) {
          const binDir = join(root, match.name, binSubdir)
          const binName = isWin ? 'python.exe' : `python${pythonVer}`
          const candidate = join(binDir, binName)
          if (existsSync(candidate)) {
            standalonePython = candidate
            found = true
            break
          }
        }
        if (found) break
      }
    }
    if (!found) {
      throw new Error(`未找到 standalone Python ${pythonVer}.x，请确认 uv python install 成功`)
    }
  }

  console.log(`🐍 独立 Python: ${standalonePython}`)

  // 推导 standalone 基础目录
  // python-build-standalone 结构:
  //   Unix/macOS: <base>/bin/python3.x  → base = dirname(binDir)
  //   Windows:    <base>/python.exe      → base = dirname(pythonDir)
  // 智能检测: python 所在目录是否叫 'bin' 或 'Scripts'
  const pythonBinDir = dirname(standalonePython)
  const parentDirName = basename(pythonBinDir).toLowerCase()
  let standaloneBase: string
  if (parentDirName === 'bin' || parentDirName === 'scripts') {
    standaloneBase = dirname(pythonBinDir)
  } else {
    standaloneBase = pythonBinDir
  }

  // 3. 删除旧 venv（如果存在）
  if (existsSync(VENV_DIR)) {
    console.log('🗑️  清理旧 .venv...')
    rmSync(VENV_DIR, { recursive: true, force: true })
  }

  // 4. 用 standalone Python 创建 venv（此时仍含 symlink）
  console.log('🔧 创建 venv...')
  execSync(`uv venv --python "${standalonePython}" "${VENV_DIR}"`, { stdio: 'inherit' })

  // 5. 将 symlink 替换为真实文件 → venv 自包含
  console.log('🔗  替换 symlink 为真实文件...')
  const venvBin = join(VENV_DIR, isWin ? 'Scripts' : 'bin')

  /** 复制文件并输出日志，跨平台兼容 */
  const doCopy = (src: string, dst: string) => {
    copyFileSync(src, dst)
    console.log(`  复制: ${src} -> ${dst}`)
  }

  if (!isWin) {
    // macOS/Linux：替换 python / python3 / python3.x symlink 为真实二进制
    for (const name of ['python', 'python3', `python${pythonVer}`]) {
      const target = join(venvBin, name)
      if (existsSync(target)) {
        rmSync(target, { force: true })
        doCopy(standalonePython, target)
      }
    }
    // 复制 libpython 动态库（.dylib / .so）
    const libDir = join(standaloneBase, 'lib')
    const venvLib = join(VENV_DIR, 'lib')
    if (existsSync(libDir)) {
      mkdirSync(venvLib, { recursive: true })
      for (const f of readdirSync(libDir).filter(f => f.startsWith('libpython'))) {
        doCopy(join(libDir, f), join(venvLib, f))
      }
    }
  } else {
    // Windows：替换 python.exe 为真实文件
    const targetPy = join(venvBin, 'python.exe')
    if (existsSync(targetPy)) {
      rmSync(targetPy, { force: true })
      doCopy(standalonePython, targetPy)
    }
    // 复制 Python DLL 运行时（python3*.dll）
    const venvLib = join(VENV_DIR, 'lib')
    mkdirSync(venvLib, { recursive: true })
    for (const f of readdirSync(standaloneBase).filter(f => f.endsWith('.dll') && f.includes('python3'))) {
      doCopy(join(standaloneBase, f), join(venvLib, f))
    }
  }

  // 5.5 复制 Python 标准库到 .venv（关键：使 venv 完全自包含）
  copyStdlib(standaloneBase, VENV_DIR, pythonVer)
  // 修正 pyvenv.cfg 的 home 路径，使其指向 venv 自身的 bin 目录
  // 这样 Python 会在 .venv/lib/python3.x/ 中找到刚复制的标准库
  {
    const cfgPath = join(VENV_DIR, 'pyvenv.cfg')
    const cfgContent = readFileSync(cfgPath, 'utf-8')
    const newHome = isWin ? 'Scripts' : 'bin'
    const updated = cfgContent.replace(/^home\s*=.*$/m, `home = ${newHome}`)
    writeFileSync(cfgPath, updated)
    console.log(`  修正 pyvenv.cfg: home = ${newHome}`)
  }

  // 6. 在可重定位 venv 中安装 Python 依赖
  console.log('📥 安装依赖...')
  const venvPython = pythonInVenv()
  execSync(`uv pip install --python "${venvPython}" -r "${join(AGENT_DIR, 'requirements.txt')}"`, {
    cwd: AGENT_DIR,
    stdio: 'inherit',
  })

  // 7. 验证：确保 Python 是真实文件而非 symlink，并确认核心库可正常导入
  console.log('🔍 验证 venv 自包含性...')
  const linkedPython = execSync(`"${venvPython}" -c "import sys; print(sys.executable)"`, {
    encoding: 'utf-8',
  }).trim()
  console.log(`   sys.executable = ${linkedPython}`)
  if (linkedPython === venvPython) {
    console.log('✅ venv Python 是真实文件（非 symlink），可重定位')
  } else {
    console.log(`⚠️  venv Python 可能是 symlink（${linkedPython}），重定位可能有问题`)
  }

  // 验证 uvicorn 和 fastapi 可正常导入
  execSync(`"${venvPython}" -c "import uvicorn; import fastapi; print('OK uvicorn', uvicorn.__version__, 'fastapi', fastapi.__version__)"`, {
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
}

/**
 * 递归复制目录，跳过 excluedNames 中指定的文件/目录名
 * 用于将 standalone Python 的标准库复制到自包含 venv 中
 */
function copyDirRecursive(src: string, dst: string, excludedNames: Set<string>): void {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const name = entry.name
    if (excludedNames.has(name)) continue
    const srcPath = join(src, name)
    const dstPath = join(dst, name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, excludedNames)
    } else if (entry.isSymbolicLink()) {
      try { copyFileSync(srcPath, dstPath) } catch { /* skip broken symlinks */ }
    } else {
      copyFileSync(srcPath, dstPath)
    }
  }
}

/**
 * 将 standalone Python 的标准库复制到 venv 的 lib 目录中
 * 排除 site-packages（由 uv pip install 管理）和 __pycache__（缓存文件）
 */
function copyStdlib(standaloneBase: string, venvDir: string, pythonVer: string): void {
  const stdlibSrc = join(standaloneBase, 'lib', `python${pythonVer}`)
  const stdlibDst = join(venvDir, 'lib', `python${pythonVer}`)
  if (!existsSync(stdlibSrc)) {
    console.warn(`⚠️ 标准库不存在: ${stdlibSrc}，跳过复制`)
    return
  }
  console.log('📚 复制 Python 标准库...')
  const before = Date.now()
  copyDirRecursive(stdlibSrc, stdlibDst, new Set(['site-packages', '__pycache__', 'EXTERNALLY-MANAGED']))
  console.log(`  完成 (${Date.now() - before}ms)`)
}

/** 通过 ollama pull 下载指定的 LLM 模型，失败时不中断流程 */
function pullOllamaModel(modelName: string): void {
  console.log(`下载 Ollama 模型: ${modelName}...`)
  try {
    execSync(`ollama pull ${modelName}`, { stdio: 'inherit' })
  } catch {
    console.warn(`⚠️ 模型 ${modelName} 下载失败，请手动运行: ollama pull ${modelName}`)
  }
}

// ─── 主入口 ───

/**
 * 主流程：环境检查 → 安装依赖 → 下载模型（可选）
 *
 * 根据命令行参数决定执行路径：
 * - 默认：可重定位 venv（Python 二进制复制到 .venv，打包可用）
 * - --dev：开发模式 uv sync symlink venv（快速迭代用）
 * - --check：仅检查，不安装
 * - --download-models：额外下载 Ollama 模型
 */
async function main() {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const devMode = args.includes('--dev')
  const downloadModels = args.includes('--download-models')

  console.log('═══════════════════════════════════════')
  console.log(`  MirageInk Agent 环境初始化 (uv${devMode ? ', 开发模式' : ', 可重定位模式'})`)
  console.log('═══════════════════════════════════════\n')

  // 第一步：运行所有环境检查
  const checks = [checkUv(), checkPython(), checkOllama(), checkVenv()]

  let allOk = true
  for (const check of checks) {
    console.log(`  ${check.message}`)
    if (!check.ok) allOk = false
  }

  // --check 模式下仅输出结果，不执行安装
  if (checkOnly) {
    if (allOk) {
      console.log('\n✅ 所有检查通过，Agent 环境就绪')
    } else {
      console.log('\n⚠️ 部分检查未通过，请修复后重试')
    }
    return
  }

  // 第二步：同步依赖（默认可重定位模式，--dev 切 symlink）
  console.log('\n── 同步依赖 ──')
  if (devMode) {
    syncDevDependencies()
  } else {
    syncRelocatableDependencies()
  }

  // 第三步：下载本地 LLM 模型（可选）
  if (downloadModels) {
    console.log('\n── 下载本地模型 ──')
    mkdirSync(MODELS_DIR, { recursive: true })
    pullOllamaModel('qwen2.5:7b') // 默认本地模型：通义千问 2.5 7B
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
