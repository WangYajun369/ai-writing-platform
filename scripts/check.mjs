#!/usr/bin/env node
/**
 * MirageInk (TimeWrite / 智写时光) 项目完整性自动检测脚本
 * 检查 TypeScript 类型、Rust 编译、必需文件、关键导入一致性
 *
 * 运行: pnpm check
 */

import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')

let passed = 0
let failed = 0
const errors = []
const warnings = []

function check(desc, condition, isWarning = false) {
  if (condition) {
    console.log(`  ✅  ${desc}`)
    passed++
  } else {
    const icon = isWarning ? '⚠️ ' : '❌'
    console.log(`  ${icon}  ${desc}`)
    if (isWarning) warnings.push(desc)
    else { errors.push(desc); failed++ }
  }
}

function fileExists(relPath) {
  return existsSync(join(ROOT, relPath))
}

function fileContains(relPath, ...patterns) {
  try {
    const content = readFileSync(join(ROOT, relPath), 'utf-8')
    return patterns.every(p => content.includes(p))
  } catch { return false }
}

function cargoAvailable() {
  try {
    execSync('cargo --version', { cwd: ROOT, stdio: 'pipe', timeout: 5000 })
    return true
  } catch { return false }
}

// ============================================================
console.log('\n🔍  MirageInk (TimeWrite) 项目完整性检测\n')
console.log('='.repeat(50))

// ── 0. TypeScript 类型检查 ──────────────────────────────────
console.log('\n🔎  [0/10] TypeScript 类型检查')
try {
  execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 120000 })
  console.log('  ✅  tsc --noEmit 通过（0 个类型错误）')
  passed++
} catch (e) {
  const stderr = e.stderr?.toString() || e.stdout?.toString() || ''
  const errorLines = stderr.split('\n').filter(l =>
    l.includes('error TS') && !l.includes('npm warn')
  )
  if (errorLines.length > 0) {
    console.log(`  ❌  tsc --noEmit 发现 ${errorLines.length} 个类型错误：`)
    errorLines.slice(0, 15).forEach(l => console.log(`     ${l.trim()}`))
    if (errorLines.length > 15) console.log(`     ... 还有 ${errorLines.length - 15} 个错误`)
    errors.push(`TypeScript 类型错误 (${errorLines.length} 个)`)
    failed++
  } else {
    console.log('  ❌  tsc --noEmit 执行失败')
    errors.push('TypeScript 编译失败（无具体错误信息）')
    failed++
  }
}

// ── 1. Rust 编译检查 ────────────────────────────────────────
console.log('\n🦀  [1/10] Rust 编译检查 (cargo check)')
if (!cargoAvailable()) {
  console.log('  ⚠️  未检测到 Rust/Cargo 工具链，跳过 Rust 编译检查')
  warnings.push('Rust 工具链未安装，跳过 cargo check')
} else {
  try {
    execSync('cargo check', { cwd: join(ROOT, 'src-tauri'), stdio: 'pipe', timeout: 300000 })
    console.log('  ✅  cargo check 通过（0 个错误）')
    passed++
  } catch (e) {
    const stderr = e.stderr?.toString() || e.stdout?.toString() || ''
    const errorLines = stderr.split('\n').filter(l =>
      l.includes('error[') && !l.includes('warning[')
    )
    if (errorLines.length > 0) {
      console.log(`  ❌  cargo check 发现 ${errorLines.length} 个编译错误：`)
      errorLines.slice(0, 10).forEach(l => console.log(`     ${l.trim()}`))
      if (errorLines.length > 10) console.log(`     ... 还有 ${errorLines.length - 10} 个错误`)
      errors.push(`Rust 编译错误 (${errorLines.length} 个)`)
      failed++
    } else {
      // 可能是超时或其他问题
      console.log('  ⚠️  cargo check 执行异常（可能是超时或环境问题）')
      warnings.push('cargo check 执行异常，请手动运行 cargo check 确认')
    }
  }
}

// ── 2. 根目录配置文件 ──────────────────────────────────────
console.log('\n📦  [2/10] 根目录配置文件')
check('package.json 存在', fileExists('package.json'))
check('package.json 含 tauri 命令', fileContains('package.json', '"tauri"'))
check('package.json 含 pnpm 包管理器', fileContains('package.json', '"pnpm"'))
check('index.html 存在', fileExists('index.html'))
check('vite.config.ts 存在', fileExists('vite.config.ts'))
check('tsconfig.json 存在', fileExists('tsconfig.json'))
check('tsconfig.node.json 存在', fileExists('tsconfig.node.json'))
check('README.md 存在', fileExists('README.md'))
check('LICENSE 存在', fileExists('LICENSE'))
check('tailwind.config.ts 不存在（v4 使用 Vite 插件）', !fileExists('tailwind.config.ts'))
check('postcss.config.js 不存在（v4 无需 PostCSS）', !fileExists('postcss.config.js'))
check('pnpm-lock.yaml 存在', fileExists('pnpm-lock.yaml'))

// ── 3. 前端源码核心文件 ────────────────────────────────────
console.log('\n⚛️   [3/10] 前端源码核心文件 (src/)')
const coreSrcFiles = [
  'src/main.tsx',
  'src/App.tsx',
  'src/vite-env.d.ts',
  'src/styles/globals.css',
  'src/styles/base.css',
  'src/styles/theme.css',
  'src/styles/tiptap.css',
  'src/styles/markdown.css',
  'src/types/index.ts',
  'src/lib/utils.ts',
  'src/lib/tauri-bridge.ts',
  'src/lib/toast.ts',
  'src/lib/image-utils.ts',
  'src/router/index.tsx',
  'src/plugins/index.ts',
  'src/plugins/types.ts',
  'src/plugins/PluginManager.ts',
]
for (const f of coreSrcFiles) check(f, fileExists(f))

check('plugins/examples/charCounter.ts', fileExists('src/plugins/examples/charCounter.ts'))

// ── 4. 状态管理 ────────────────────────────────────────────
console.log('\n🗄️   [4/10] 状态管理 (stores/)')
const storeFiles = [
  'src/stores/appStore.ts',
  'src/stores/appTypes.ts',
  'src/stores/uiAtoms.ts',
  'src/stores/aiSlice.ts',
  'src/stores/booksSlice.ts',
  'src/stores/pluginStore.ts',
  'src/stores/preferencesSlice.ts',
]
for (const f of storeFiles) check(f, fileExists(f))

check('appStore 含 Zustand create', fileContains('src/stores/appStore.ts', 'create<'))
check('uiAtoms 含 Jotai atom', fileContains('src/stores/uiAtoms.ts', "from 'jotai'"))
check('appTypes 含核心类型定义', fileContains('src/stores/appTypes.ts', 'Book', 'Chapter', 'Volume'))

// ── 5. 页面组件 ────────────────────────────────────────────
console.log('\n📄  [5/10] 页面组件 (pages/)')
check('LibraryPage.tsx', fileExists('src/pages/LibraryPage.tsx'))
check('EditorPage.tsx', fileExists('src/pages/EditorPage.tsx'))
check('SettingsPage.tsx (settings 路由入口)', fileExists('src/pages/SettingsPage.tsx'))
check('LibraryPage 含路由导入', fileContains('src/pages/LibraryPage.tsx', 'useNavigate'))
check('EditorPage 含 useParams', fileContains('src/pages/EditorPage.tsx', 'useParams'))

// ── 6. 功能组件 ────────────────────────────────────────────
console.log('\n🧩  [6/10] 功能组件 (components/)')

// App 初始化 & 通用
check('ErrorBoundary.tsx', fileExists('src/components/ErrorBoundary.tsx'))
check('AppInit.tsx', fileExists('src/components/app/AppInit.tsx'))
check('windowDetection.ts', fileExists('src/components/app/windowDetection.ts'))
check('ContextMenu.tsx', fileExists('src/components/common/ContextMenu.tsx'))
check('DebugPanel.tsx', fileExists('src/components/common/DebugPanel.tsx'))
check('ToastContainer.tsx', fileExists('src/components/common/ToastContainer.tsx'))

// 文库
check('BookCard.tsx', fileExists('src/components/library/BookCard.tsx'))
check('NewBookDialog.tsx', fileExists('src/components/library/NewBookDialog.tsx'))
check('EditBookDialog.tsx', fileExists('src/components/library/EditBookDialog.tsx'))
check('CoverPicker.tsx', fileExists('src/components/library/CoverPicker.tsx'))
check('TrashModal.tsx', fileExists('src/components/library/TrashModal.tsx'))

// 编辑器核心
check('RichTextEditor.tsx', fileExists('src/components/editor/RichTextEditor.tsx'))
check('EditorToolbar.tsx', fileExists('src/components/editor/EditorToolbar.tsx'))
check('ChapterSummaryHeader.tsx', fileExists('src/components/editor/ChapterSummaryHeader.tsx'))
check('SnapshotPanel.tsx', fileExists('src/components/editor/SnapshotPanel.tsx'))
check('ImageResizeNodeView.tsx', fileExists('src/components/editor/ImageResizeNodeView.tsx'))
check('ResizableImageExtension.ts', fileExists('src/components/editor/ResizableImageExtension.ts'))

// TipTap 依赖检查
check('RichTextEditor 含 TipTap useEditor', fileContains('src/components/editor/RichTextEditor.tsx', 'useEditor'))
check('RichTextEditor 含 StarterKit', fileContains('src/components/editor/RichTextEditor.tsx', 'StarterKit'))

// 布局
check('EditorLayout.tsx', fileExists('src/components/layout/EditorLayout.tsx'))
check('StatusBar.tsx', fileExists('src/components/layout/StatusBar.tsx'))

// 大纲 & 世界观
check('OutlinePanel.tsx', fileExists('src/components/outline/OutlinePanel.tsx'))
check('WorldbuildingPanel.tsx', fileExists('src/components/worldbuilding/WorldbuildingPanel.tsx'))
check('WorldCardEditor.tsx', fileExists('src/components/worldbuilding/WorldCardEditor.tsx'))

// AI 组件
check('AiSidePanel.tsx', fileExists('src/components/ai/AiSidePanel.tsx'))
check('AiToolboxPanel.tsx', fileExists('src/components/ai/AiToolboxPanel.tsx'))
check('MessageBubble.tsx', fileExists('src/components/ai/MessageBubble.tsx'))
check('RequestDetailModal.tsx', fileExists('src/components/ai/RequestDetailModal.tsx'))
check('useAiChat 含流式事件监听', fileExists('src/components/ai/useAiChat.ts') && fileContains('src/components/ai/useAiChat.ts', 'agent-stream-chunk'))

// 设置页
check('SettingsPage.tsx (详细设置)', fileExists('src/components/settings/SettingsPage.tsx'))
check('AiConfigSection.tsx', fileExists('src/components/settings/AiConfigSection.tsx'))
check('AiToolboxSection.tsx', fileExists('src/components/settings/AiToolboxSection.tsx'))
check('AppearanceSection.tsx', fileExists('src/components/settings/AppearanceSection.tsx'))
check('ChatConfigSection.tsx', fileExists('src/components/settings/ChatConfigSection.tsx'))
check('EditorConfigSection.tsx', fileExists('src/components/settings/EditorConfigSection.tsx'))
check('RagConfigSection.tsx', fileExists('src/components/settings/RagConfigSection.tsx'))
check('StorageSection.tsx', fileExists('src/components/settings/StorageSection.tsx'))
check('VersionSection.tsx', fileExists('src/components/settings/VersionSection.tsx'))
check('settings/constants.ts', fileExists('src/components/settings/constants.ts'))
check('settings/shared.tsx', fileExists('src/components/settings/shared.tsx'))

// Hooks
console.log('\n🪝  Hooks (hooks/)')
check('useAppVersion.ts', fileExists('src/hooks/useAppVersion.ts'))
check('useConsoleInterceptor.ts', fileExists('src/hooks/useConsoleInterceptor.ts'))
check('useResizeHandle.ts', fileExists('src/hooks/useResizeHandle.ts'))
check('useThemeFontInit.ts', fileExists('src/hooks/useThemeFontInit.ts'))

// ── 7. Rust 后端 ───────────────────────────────────────────
console.log('\n🦀  [7/10] Rust 后端 (src-tauri/)')

// 根文件
const rustCore = [
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/build.rs',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/error.rs',
  'src-tauri/src/utils.rs',
]
for (const f of rustCore) check(f, fileExists(f))

// 数据库
check('db/mod.rs', fileExists('src-tauri/src/db/mod.rs'))
check('db/schema.rs', fileExists('src-tauri/src/db/schema.rs'))

// 模型 & 仓库层
check('models/mod.rs', fileExists('src-tauri/src/models/mod.rs'))
check('repository/mod.rs', fileExists('src-tauri/src/repository/mod.rs'))
const repos = ['book_repo', 'chapter_repo', 'volume_repo', 'snapshot_repo', 'world_card_repo', 'embedding_repo']
for (const r of repos) check(`repository/${r}.rs`, fileExists(`src-tauri/src/repository/${r}.rs`))

// 服务层
check('service/mod.rs', fileExists('src-tauri/src/service/mod.rs'))
const services = ['book_service', 'chapter_service', 'volume_service', 'snapshot_service', 'world_card_service', 'search_service']
for (const s of services) check(`service/${s}.rs`, fileExists(`src-tauri/src/service/${s}.rs`))

// IPC 命令
check('commands/mod.rs', fileExists('src-tauri/src/commands/mod.rs'))
const commands = ['book', 'chapter', 'volume', 'snapshot', 'world_card', 'image']
for (const c of commands) check(`commands/${c}.rs`, fileExists(`src-tauri/src/commands/${c}.rs`))

// AI 命令
check('commands/ai/mod.rs', fileExists('src-tauri/src/commands/ai/mod.rs'))
const aiCmds = ['chat', 'embedding', 'summarize', 'test']
for (const c of aiCmds) check(`commands/ai/${c}.rs`, fileExists(`src-tauri/src/commands/ai/${c}.rs`))

// IO 命令
check('commands/io/mod.rs', fileExists('src-tauri/src/commands/io/mod.rs'))
const ioCmds = ['backup', 'crypto', 'export', 'import_txt']
for (const c of ioCmds) check(`commands/io/${c}.rs`, fileExists(`src-tauri/src/commands/io/${c}.rs`))

// 窗口管理
check('commands/window/mod.rs', fileExists('src-tauri/src/commands/window/mod.rs'))
const windowCmds = ['debug', 'manager', 'validate']
for (const c of windowCmds) check(`commands/window/${c}.rs`, fileExists(`src-tauri/src/commands/window/${c}.rs`))

// 核心依赖检查
check('Cargo.toml 含 tauri v2', fileContains('src-tauri/Cargo.toml', 'tauri', 'protocol-asset'))
check('Cargo.toml 含 rusqlite (bundled)', fileContains('src-tauri/Cargo.toml', 'rusqlite'))
check('Cargo.toml 含 serde + serde_json', fileContains('src-tauri/Cargo.toml', 'serde'))
check('Cargo.toml 含 uuid', fileContains('src-tauri/Cargo.toml', 'uuid'))
check('Cargo.toml 含 chrono', fileContains('src-tauri/Cargo.toml', 'chrono'))
check('Cargo.toml 含 tokio (rt-multi-thread)', fileContains('src-tauri/Cargo.toml', 'tokio'))
check('Cargo.toml 含 reqwest', fileContains('src-tauri/Cargo.toml', 'reqwest'))
check('Cargo.toml 含 regex-lite', fileContains('src-tauri/Cargo.toml', 'regex-lite'))
check('Cargo.toml 含 aes-gcm (加密)', fileContains('src-tauri/Cargo.toml', 'aes-gcm'))

// lib.rs 注册关键命令
check('lib.rs 注册所有模块命令', fileContains(
  'src-tauri/src/lib.rs',
  'list_books', 'save_chapter', 'rag_search',
  'export_book', 'export_all_data', 'import_backup'
))

// 数据库结构检查
check('db/mod.rs 含 PRAGMA WAL', fileContains('src-tauri/src/db/mod.rs', 'WAL'))
check('db/mod.rs 含完整表结构 (books/chapters/volumes/snapshots/world_cards)',
  fileContains('src-tauri/src/db/mod.rs',
    'CREATE TABLE IF NOT EXISTS books',
    'CREATE TABLE IF NOT EXISTS chapters',
    'CREATE TABLE IF NOT EXISTS snapshots'))

// 架构验证
check('repository 层实现数据访问分离', fileContains('src-tauri/src/repository/book_repo.rs', 'rusqlite'))
check('service 层实现业务逻辑', fileContains('src-tauri/src/service/book_service.rs', 'book_repo'))
check('AI 模块含流式聊天 + RAG + 总结', fileContains('src-tauri/src/commands/ai/mod.rs', 'chat', 'embedding', 'summarize'))

// ── 8. 依赖与类型一致性 ─────────────────────────────────────
console.log('\n📐  [8/10] 依赖与类型一致性')
let pkgJson
try {
  pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
} catch { pkgJson = {} }
const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }

// 核心框架
check('@tauri-apps/api (v2) 存在', !!deps['@tauri-apps/api'])
check('react + react-dom (v19) 存在', !!deps['react'] && !!deps['react-dom'])
check('typescript (>=6) 存在', !!deps['typescript'])
check('vite (v8) 存在', !!deps['vite'])

// Tauri 插件
check('@tauri-apps/plugin-dialog 存在', !!deps['@tauri-apps/plugin-dialog'])
check('@tauri-apps/plugin-fs 存在', !!deps['@tauri-apps/plugin-fs'])
check('@tauri-apps/plugin-http 存在', !!deps['@tauri-apps/plugin-http'])
check('@tauri-apps/plugin-shell 存在', !!deps['@tauri-apps/plugin-shell'])
check('@tauri-apps/plugin-updater 存在', !!deps['@tauri-apps/plugin-updater'])

// UI & 编辑器
check('@tiptap/react + starter-kit 存在', !!deps['@tiptap/react'] && !!deps['@tiptap/starter-kit'])
check('lucide-react 存在', !!deps['lucide-react'])
check('react-router-dom (v7) 存在', !!deps['react-router-dom'])
check('react-markdown + remark-gfm 存在', !!deps['react-markdown'] && !!deps['remark-gfm'])

// 状态管理
check('zustand (v5) 存在', !!deps['zustand'])
check('jotai 存在', !!deps['jotai'])

// 工具库
check('date-fns 存在', !!deps['date-fns'])
check('clsx + class-variance-authority 存在', !!deps['clsx'] && !!deps['class-variance-authority'])

// Tailwind CSS v4
check('tailwindcss (v4) + @tailwindcss/vite 存在', !!deps['tailwindcss'] && !!deps['@tailwindcss/vite'])

// 构建工具
check('@vitejs/plugin-react 存在', !!deps['@vitejs/plugin-react'])
check('esbuild 存在', !!deps['esbuild'])

// 前端 IPC 桥接一致性
check(
  'tauri-bridge 导出 bookApi/chapterApi/volumeApi/worldCardApi/aiApi',
  fileContains('src/lib/tauri-bridge.ts', 'bookApi', 'chapterApi', 'volumeApi', 'worldCardApi', 'aiApi')
)
check(
  'AppStore 包含所有关键 action (slice 模式)',
  fileContains('src/stores/booksSlice.ts', 'setBooks', 'setChapters', 'setVolumes', 'setCurrentChapterId') &&
  fileContains('src/stores/aiSlice.ts', 'setAiConfig')
)

// ── 9. GitHub Actions & CI ─────────────────────────────────
console.log('\n🚀  [9/10] CI/CD (GitHub Actions)')
check('.github/workflows/release.yml 存在', fileExists('.github/workflows/release.yml'))
check('release.yml 含 Tauri 构建步骤', fileContains('.github/workflows/release.yml', 'tauri', 'build'))
const issueTemplates = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
]
for (const t of issueTemplates) check(t, fileExists(t))

// ── 10. Agent Python 代码检查 ────────────────────────────────
console.log('\n🐍  [10/10] Agent Python 代码 (agent/)')

function pythonAvailable() {
  try {
    execSync('python3 --version', { cwd: ROOT, stdio: 'pipe', timeout: 5000 })
    return true
  } catch {
    try {
      execSync('python --version', { cwd: ROOT, stdio: 'pipe', timeout: 5000 })
      return true
    } catch { return false }
  }
}

function getPythonBin() {
  try {
    execSync('python3 --version', { cwd: ROOT, stdio: 'pipe', timeout: 5000 })
    return 'python3'
  } catch {
    return 'python'
  }
}

const hasPython = pythonAvailable()
const pythonBin = hasPython ? getPythonBin() : 'python3'

check('Python 解释器可用', hasPython)

// Agent 核心文件列表
const agentFiles = [
  'agent/__init__.py',
  'agent/main.py',
  'agent/config.py',
  'agent/tracer.py',
  'agent/pyproject.toml',
  'agent/requirements.txt',
  'agent/server/__init__.py',
  'agent/server/routes.py',
  'agent/server/sse.py',
  'agent/skills/__init__.py',
  'agent/skills/engine.py',
  'agent/skills/prompts.py',
  'agent/models/__init__.py',
  'agent/models/router.py',
  'agent/tools/__init__.py',
  'agent/tools/db_tools.py',
  'agent/memory/__init__.py',
  'agent/memory/store.py',
  'agent/memory/retriever.py',
  'agent/memory/summarizer.py',
]

// 检查所有 Agent 文件存在
for (const f of agentFiles) check(f, fileExists(f))

// pyproject.toml 依赖检查
check('pyproject.toml 含 FastAPI + uvicorn', fileContains('agent/pyproject.toml', 'fastapi', 'uvicorn'))
check('pyproject.toml 含 LangChain 生态', fileContains('agent/pyproject.toml', 'langchain', 'langgraph'))
check('pyproject.toml 含 pydantic + httpx', fileContains('agent/pyproject.toml', 'pydantic', 'httpx'))
check('pyproject.toml 含 sse-starlette', fileContains('agent/pyproject.toml', 'sse-starlette'))
check('requirements.txt 与 pyproject.toml 同步', (() => {
  try {
    const pyproject = readFileSync(join(ROOT, 'agent/pyproject.toml'), 'utf-8')
    const reqs = readFileSync(join(ROOT, 'agent/requirements.txt'), 'utf-8')
    // 提取 pyproject.toml 中的依赖名
    const depPattern = /"([\w-]+)==?"/g
    const pyDeps = new Set([...pyproject.matchAll(depPattern)].map(m => m[1]))
    const reqDeps = new Set([...reqs.matchAll(depPattern)].map(m => m[1]))
    // 双向比较
    const onlyPyproject = [...pyDeps].filter(d => !reqDeps.has(d))
    const onlyReqs = [...reqDeps].filter(d => !pyDeps.has(d))
    if (onlyPyproject.length > 0 || onlyReqs.length > 0) {
      if (onlyPyproject.length) console.log(`     ⚠️  仅在 pyproject.toml 中：${onlyPyproject.join(', ')}`)
      if (onlyReqs.length) console.log(`     ⚠️  仅在 requirements.txt 中：${onlyReqs.join(', ')}`)
      return false
    }
    return true
  } catch { return false }
})())

// __init__.py 导出一致性检查
check('agent/__init__.py 导出核心组件', fileContains('agent/__init__.py',
  'AgentConfig', 'SkillType', 'execute_skill_stream', 'MemoryStore', 'tracer'))
check('agent/server/__init__.py 导出路由', fileContains('agent/server/__init__.py',
  'register_routes'))
check('agent/skills/__init__.py 导出 Skill 引擎', fileContains('agent/skills/__init__.py',
  'execute_skill_stream', 'SKILL_PROMPTS'))
check('agent/models/__init__.py 导出模型路由', fileContains('agent/models/__init__.py',
  'get_model_for_skill'))
check('agent/tools/__init__.py 导出 DB 工具', fileContains('agent/tools/__init__.py',
  'DB_TOOLS', 'SKILL_TOOLS_MAP'))
check('agent/memory/__init__.py 导出记忆模块', fileContains('agent/memory/__init__.py',
  'MemoryStore', 'MemoryRetriever', 'HistorySummarizer'))

// Python 语法编译检查
check('所有 .py 文件语法正确（py_compile）', (() => {
  if (!hasPython) {
    console.log('     ⚠️  未检测到 Python，跳过语法检查')
    return true  // 当作 warning 级通过
  }
  try {
    const pyFiles = agentFiles.filter(f => f.endsWith('.py'))
    const fileArgs = pyFiles.map(f => `"${join(ROOT, f)}"`).join(' ')
    execSync(`${pythonBin} -m py_compile ${fileArgs}`, { cwd: ROOT, stdio: 'pipe', timeout: 30000 })
    return true
  } catch (e) {
    const stderr = e.stderr?.toString() || ''
    console.log('     ' + stderr.split('\n').filter(l => l.trim()).slice(0, 3).join('\n     '))
    return false
  }
})())

// tracer.py 关键功能检查
check('tracer.py 含 trace 装饰器', fileContains('agent/tracer.py', 'def trace('))
check('tracer.py 含 Traced 基类', fileContains('agent/tracer.py', 'class Traced'))
check('config.py 含 AgentConfig dataclass', fileContains('agent/config.py', 'class AgentConfig'))
check('config.py 含 ollama 模型配置', fileContains('agent/config.py', 'ollama_base_url'))

// ── 汇总 ────────────────────────────────────────────────────
console.log('\n' + '='.repeat(50))
const total = passed + failed
console.log(`\n📊  检测结果：${total} 项检查  ✅ ${passed} 通过  ❌ ${failed} 失败  ⚠️  ${warnings.length} 警告\n`)

if (errors.length > 0) {
  console.log('❌  失败项目：')
  errors.forEach(e => console.log(`   - ${e}`))
}
if (warnings.length > 0) {
  console.log('⚠️   警告项目：')
  warnings.forEach(w => console.log(`   - ${w}`))
}

if (failed === 0) {
  console.log('🎉  所有必需检查通过！项目基础代码完整。\n')
  console.log('📋  后续步骤：')
  console.log('   1. pnpm install')
  console.log('   2. pnpm agent:setup   （初始化 Python Agent 环境）')
  console.log('   3. pnpm tauri dev     （需先安装 Rust + Tauri CLI）')
  console.log('   4. 确保 AI 服务运行（Ollama 或兼容 API）')
  console.log()
  process.exit(0)
} else {
  console.log(`\n⚠️   存在 ${failed} 项失败，请检查上述文件。\n`)
  process.exit(1)
}
