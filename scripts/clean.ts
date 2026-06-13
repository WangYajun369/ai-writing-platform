/**
 * MirageInk (TimeWrite / 智写时光) 项目清理脚本
 * 清空全部编译结果和依赖，包括前端、Rust 后端的构建产物和 node_modules
 *
 * 运行: npx tsx scripts/clean.ts
 */

import { rmSync, existsSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')

/** 需要清理的目录（相对于项目根目录） */
const DIRS_TO_REMOVE = [
  // 前端构建产物
  'dist',
  // 前端依赖
  'node_modules',
  // Python 虚拟环境
  'agent/.venv',
  // Rust 后端构建产物
  'src-tauri/target',
]

/** 需要清理的文件（相对于项目根目录） */
const FILES_TO_REMOVE = [
  // TypeScript 增量编译信息
  'tsconfig.tsbuildinfo',
  'tsconfig.node.tsbuildinfo',
  // Python uv 锁文件
  'agent/uv.lock',
  // Rust 锁文件（可选，clean:all 时清理）
]

// ============================================================
// 颜色输出
// ============================================================
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const BOLD = '\x1b[1m'

function log(emoji: string, msg: string) {
  console.log(`  ${emoji}  ${msg}`)
}

function success(msg: string) {
  console.log(`  ${GREEN}✅${RESET}  ${msg}`)
}

function warn(msg: string) {
  console.log(`  ${YELLOW}⚠️${RESET}   ${msg}`)
}

function info(msg: string) {
  console.log(`  ${BLUE}ℹ️${RESET}   ${msg}`)
}

function heading(text: string) {
  console.log(`\n${BOLD}${text}${RESET}`)
}

// ============================================================
// 工具函数
// ============================================================

/** 获取目录/文件大小（可读格式） */
function getSize(dirPath: string): string {
  try {
    const stat = statSync(dirPath)
    if (stat.isFile()) return formatBytes(stat.size)

    let totalSize = 0
    const walk = (p: string) => {
      const entries = readdirSync(p, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(p, entry.name)
        try {
          const s = statSync(fullPath)
          if (s.isDirectory()) walk(fullPath)
          else totalSize += s.size
        } catch { /* 跳过无法读取的文件 */ }
      }
    }
    walk(dirPath)
    return formatBytes(totalSize)
  } catch {
    return '未知'
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

/** 安全删除目录 */
function removeDir(relPath: string): void {
  const absPath = join(ROOT, relPath)
  if (!existsSync(absPath)) {
    log('⏭️', `${relPath} — 不存在，跳过`)
    return
  }

  const size = getSize(absPath)
  try {
    rmSync(absPath, { recursive: true, force: true })
    success(`${relPath} — 已删除 (${size})`)
  } catch (e) {
    warn(`${relPath} — 删除失败：${e instanceof Error ? e.message : e}`)
  }
}

/** 安全删除文件 */
function removeFile(relPath: string): void {
  const absPath = join(ROOT, relPath)
  if (!existsSync(absPath)) return // 静默跳过不存在的文件

  const size = getSize(absPath)
  try {
    rmSync(absPath, { force: true })
    success(`${relPath} — 已删除 (${size})`)
  } catch (e) {
    warn(`${relPath} — 删除失败：${e instanceof Error ? e.message : e}`)
  }
}

// ============================================================
// 清理函数
// ============================================================

/** 清理前端和 Rust 的编译产物 */
function cleanBuildArtifacts() {
  heading('🔧 清理编译产物')
  for (const dir of DIRS_TO_REMOVE) {
    removeDir(dir)
  }
  for (const file of FILES_TO_REMOVE) {
    removeFile(file)
  }
}

/** 清理 Rust target 目录 + cargo clean */
function cleanRustTarget() {
  heading('🦀 清理 Rust 编译缓存')
  const targetPath = join(ROOT, 'src-tauri', 'target')
  if (existsSync(targetPath)) {
    const size = getSize(targetPath)
    try {
      rmSync(targetPath, { recursive: true, force: true })
      success(`src-tauri/target — 已删除 (${size})`)
    } catch {
      // rmSync 失败时尝试 cargo clean
      try {
        execSync('cargo clean', { cwd: join(ROOT, 'src-tauri'), stdio: 'pipe' })
        success('src-tauri/target — cargo clean 完成')
      } catch {
        warn('src-tauri/target — 清理失败，请手动删除')
      }
    }
  } else {
    log('⏭️', 'src-tauri/target — 不存在，跳过')
  }
}

/** 清理 node_modules */
function cleanNodeModules() {
  heading('📦 清理依赖')
  removeDir('node_modules')
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const args = process.argv.slice(2)
  const mode = args.includes('--all') || args.includes('-a') ? 'all' : 'default'

  console.log('\n🧹  MirageInk (TimeWrite) 项目清理')
  console.log('='.repeat(50))

  if (mode === 'default') {
    info('默认模式：清理编译产物 + 依赖（保留 Rust target）')
    cleanBuildArtifacts()
    cleanNodeModules()
  } else {
    info('完整模式：清理所有编译产物 + 依赖 + Rust target')
    cleanBuildArtifacts()
    cleanNodeModules()
    cleanRustTarget()
  }

  console.log('\n' + '='.repeat(50))
  console.log('🎉  清理完成！\n')
  console.log('📋  后续步骤：')
  console.log('   1. pnpm install        # 重新安装前端依赖')
  console.log('   2. pnpm agent:setup    # 重新安装 Python 依赖（uv sync）')
  console.log('   3. pnpm tauri dev       # 启动开发环境\n')
}

main().catch((e) => {
  console.error('清理过程出错:', e)
  process.exit(1)
})
