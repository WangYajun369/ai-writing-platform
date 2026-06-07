#!/usr/bin/env node
/**
 * TimeWrite 项目完整性自动检测脚本
 * 检查所有必需文件是否存在、关键导入是否一致
 */

import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
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

// ============================================================
console.log('\n🔍  TimeWrite 项目完整性检测\n')
console.log('='.repeat(50))

// ── 1. 根目录配置文件 ──────────────────────────────────────
console.log('\n📦  [1/7] 根目录配置文件')
check('package.json 存在', fileExists('package.json'))
check('package.json 含 tauri 命令', fileContains('package.json', '"tauri"'))
check('index.html 存在', fileExists('index.html'))
check('vite.config.ts 存在', fileExists('vite.config.ts'))
check('tsconfig.json 存在', fileExists('tsconfig.json'))
check('tsconfig.node.json 存在', fileExists('tsconfig.node.json'))
check('tailwind.config.ts 存在', fileExists('tailwind.config.ts'))
check('postcss.config.js 存在', fileExists('postcss.config.js'))

// ── 2. src 前端核心文件 ────────────────────────────────────
console.log('\n⚛️   [2/7] 前端源码（src/）')
const srcFiles = [
  'src/main.tsx',
  'src/App.tsx',
  'src/styles/globals.css',
  'src/types/index.ts',
  'src/lib/utils.ts',
  'src/lib/tauri-bridge.ts',
  'src/router/index.tsx',
]
for (const f of srcFiles) check(f, fileExists(f))

// ── 3. 状态管理 ────────────────────────────────────────────
console.log('\n🗄️   [3/7] 状态管理（stores/）')
check('stores/appStore.ts', fileExists('src/stores/appStore.ts'))
check('stores/uiAtoms.ts', fileExists('src/stores/uiAtoms.ts'))
check('appStore 包含 Zustand create', fileContains('src/stores/appStore.ts', 'create<'))
check('uiAtoms 包含 Jotai atom', fileContains('src/stores/uiAtoms.ts', "from 'jotai'"))

// ── 4. 页面组件 ────────────────────────────────────────────
console.log('\n📄  [4/7] 页面组件（pages/）')
check('LibraryPage.tsx', fileExists('src/pages/LibraryPage.tsx'))
check('EditorPage.tsx', fileExists('src/pages/EditorPage.tsx'))
check('SettingsPage.tsx', fileExists('src/pages/SettingsPage.tsx'))
check('LibraryPage 含路由导入', fileContains('src/pages/LibraryPage.tsx', 'useNavigate'))
check('EditorPage 含 useParams', fileContains('src/pages/EditorPage.tsx', 'useParams'))

// ── 5. 功能组件 ────────────────────────────────────────────
console.log('\n🧩  [5/7] 功能组件（components/）')
const compFiles = [
  'src/components/library/BookCard.tsx',
  'src/components/library/NewBookDialog.tsx',
  'src/components/editor/RichTextEditor.tsx',
  'src/components/editor/EditorToolbar.tsx',
  'src/components/layout/EditorLayout.tsx',
  'src/components/layout/StatusBar.tsx',
  'src/components/outline/OutlinePanel.tsx',
  'src/components/worldbuilding/WorldbuildingPanel.tsx',
  'src/components/worldbuilding/WorldCardEditor.tsx',
  'src/components/ai/AiSidePanel.tsx',
]
for (const f of compFiles) check(f, fileExists(f))
check('RichTextEditor 含 TipTap useEditor', fileContains('src/components/editor/RichTextEditor.tsx', 'useEditor'))
check('RichTextEditor 含 StarterKit', fileContains('src/components/editor/RichTextEditor.tsx', 'StarterKit'))
check('AiSidePanel 含流式 fetch', fileContains('src/components/ai/AiSidePanel.tsx', 'stream: true'))

// ── 6. Tauri Rust 后端 ─────────────────────────────────────
console.log('\n🦀  [6/7] Rust 后端（src-tauri/）')
const rustFiles = [
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/build.rs',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/db/mod.rs',
  'src-tauri/src/models/mod.rs',
  'src-tauri/src/commands/mod.rs',
  'src-tauri/src/commands/book.rs',
  'src-tauri/src/commands/volume.rs',
  'src-tauri/src/commands/chapter.rs',
  'src-tauri/src/commands/snapshot.rs',
  'src-tauri/src/commands/world_card.rs',
  'src-tauri/src/commands/ai.rs',
  'src-tauri/src/commands/io.rs',
]
for (const f of rustFiles) check(f, fileExists(f))

check('Cargo.toml 含 rusqlite', fileContains('src-tauri/Cargo.toml', 'rusqlite'))
check('Cargo.toml 含 uuid', fileContains('src-tauri/Cargo.toml', 'uuid'))
check('Cargo.toml 含 chrono', fileContains('src-tauri/Cargo.toml', 'chrono'))
check('Cargo.toml 含 regex-lite', fileContains('src-tauri/Cargo.toml', 'regex-lite'))
check('lib.rs 注册所有命令', fileContains('src-tauri/src/lib.rs', 'list_books', 'save_chapter', 'rag_search'))
check('db/mod.rs 含 PRAGMA WAL', fileContains('src-tauri/src/db/mod.rs', 'WAL'))
check('db/mod.rs 含完整表结构（books/chapters/snapshots）',
  fileContains('src-tauri/src/db/mod.rs', 'CREATE TABLE IF NOT EXISTS books', 'CREATE TABLE IF NOT EXISTS chapters', 'CREATE TABLE IF NOT EXISTS snapshots'))

// ── 7. 关键依赖一致性检查 ──────────────────────────────────
console.log('\n📐  [7/7] 依赖与类型一致性')
let pkgJson
try {
  pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
} catch { pkgJson = {} }
const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies }

check('@tauri-apps/api 存在于 package.json', !!deps['@tauri-apps/api'])
check('@tiptap/react 存在于 package.json', !!deps['@tiptap/react'])
check('zustand 存在于 package.json', !!deps['zustand'])
check('jotai 存在于 package.json', !!deps['jotai'])
check('react-router-dom 存在于 package.json', !!deps['react-router-dom'])
check('lucide-react 存在于 package.json', !!deps['lucide-react'])

// tauri-bridge 与 appStore 的 IPC 一致性
check(
  'tauri-bridge 导出 bookApi/chapterApi/volumeApi/worldCardApi/aiApi',
  fileContains('src/lib/tauri-bridge.ts', 'bookApi', 'chapterApi', 'volumeApi', 'worldCardApi', 'aiApi')
)
check(
  'AppStore 包含所有关键 action',
  fileContains('src/stores/appStore.ts', 'setBooks', 'setChapters', 'setVolumes', 'setCurrentChapterId', 'setAiConfig')
)

// ── 汇总 ───────────────────────────────────────────────────
console.log('\n' + '='.repeat(50))
console.log(`\n📊  检测结果：${passed + failed} 项检查  ✅ ${passed} 通过  ❌ ${failed} 失败  ⚠️  ${warnings.length} 警告\n`)

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
  console.log('   1. cd TimeWrite && npm install')
  console.log('   2. npm run tauri dev   （需先安装 Rust + Tauri CLI）')
  console.log('   3. 确保 Ollama 运行（AI 功能）: ollama serve')
  console.log()
  process.exit(0)
} else {
  console.log(`\n⚠️   存在 ${failed} 项失败，请检查上述文件。\n`)
  process.exit(1)
}
