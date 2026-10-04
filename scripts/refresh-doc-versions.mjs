#!/usr/bin/env node
/**
 * 文档版本标记批量刷新脚本
 *
 * 背景：docs/ 下的专题文档头部带有版本快照标记：
 *   > **适用版本**：`1.7.0`　|　**最后核对**：2026-09-05
 * 语义是「该文档核对/撰写时的基线版本」，**不是**「当前应用版本」——
 * 因此默认只刷新「最后核对」日期（表示你确实重新核对过），
 * 仅在显式传 --version 时才改动「适用版本」（表示该文档已按新版本重新验证）。
 *
 * 用法:
 *   node scripts/refresh-doc-versions.mjs                       # 预览（不改文件）
 *   node scripts/refresh-doc-versions.mjs --write               # 仅刷新「最后核对」为今天
 *   node scripts/refresh-doc-versions.mjs --write --version 1.8.1  # 同时把「适用版本」设为 1.8.1
 *   node scripts/refresh-doc-versions.mjs --only architecture   # 仅处理路径含该子串的文档
 *   node scripts/refresh-doc-versions.mjs --stale               # 只列出未跟到当前应用版本的文档
 *
 * 注意：本项目「当前版本」的权威展示位在 README.md / docs/Home.md /
 * product/landing-page.html（由 bump 脚本与 check.mjs 一致性断言守护），
 * 本脚本不处理这三处。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), '..')
const DOCS_DIR = join(ROOT, 'docs')

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagValue = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

const WRITE = hasFlag('--write')
const STALE_ONLY = hasFlag('--stale')
const TARGET_VERSION = flagValue('--version')
const ONLY = flagValue('--only')

// 头部标记：> **适用版本**：`X.Y.Z`　|　**最后核对**：YYYY-MM-DD
const MARKER_RE = /> \*\*适用版本\*\*：`([^`]+)`(.*?)\*\*最后核对\*\*：(\d{4}-\d{2}-\d{2})/
const DATE_ONLY_RE = /\*\*最后核对\*\*：(\d{4}-\d{2}-\d{2})/

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function currentAppVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
  } catch { return '0.0.0' }
}

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkMarkdown(full, acc)
    else if (entry.endsWith('.md')) acc.push(full)
  }
  return acc
}

const appVersion = currentAppVersion()
const TODAY = today()

// CHANGELOG.md（版本流水）与 Home.md（入口文档，版本由 bump 脚本守护）不参与快照刷新
const files = walkMarkdown(DOCS_DIR)
  .filter((f) => !f.endsWith('/CHANGELOG.md') && !f.endsWith('/Home.md'))
  .filter((f) => (ONLY ? f.includes(ONLY) : true))

const rows = []
let changed = 0

for (const file of files) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf-8')

  const marker = text.match(MARKER_RE)
  if (!marker) {
    // 兼容只带「最后核对」的文档
    if (DATE_ONLY_RE.test(text)) {
      rows.push({ rel, docVersion: '—', date: text.match(DATE_ONLY_RE)[1], status: 'date-only' })
    }
    continue
  }

  const [, docVersion, , lastChecked] = marker
  const stale = docVersion !== appVersion
  // 仅当「适用版本」是纯 semver 时才允许改写；带注解的（如「1.7.0（本规范已于 v1.7.0 落地）」）保持原样
  const isPlainSemver = /^\d+\.\d+\.\d+$/.test(docVersion)
  const newVersion = TARGET_VERSION && isPlainSemver ? TARGET_VERSION : docVersion
  const newDate = TODAY
  const needsChange = newDate !== lastChecked || newVersion !== docVersion

  rows.push({
    rel,
    docVersion,
    date: lastChecked,
    status: stale ? 'stale' : 'current',
    willChange: needsChange ? `${newVersion} @ ${newDate}` : '',
  })

  if (STALE_ONLY || !WRITE || !needsChange) continue

  const newMarker = marker[0]
    .replace(`\`${docVersion}\``, `\`${newVersion}\``)
    .replace(lastChecked, newDate)

  writeFileSync(file, text.replace(marker[0], newMarker), 'utf-8')
  changed++
}

// ── 输出 ────────────────────────────────────────────────
console.log('\n' + '='.repeat(72))
console.log(`📄 文档版本标记${STALE_ONLY ? '（仅陈旧项）' : ''}　当前应用版本：${appVersion}　今天：${TODAY}`)
console.log('='.repeat(72))

const shown = STALE_ONLY ? rows.filter((r) => r.status === 'stale') : rows

if (shown.length === 0) {
  console.log('  ✅ 无需处理的文档')
} else {
  const w = Math.max(...shown.map((r) => r.rel.length), 20)
  console.log(`  ${'文档'.padEnd(w)}  ${'适用版本'.padEnd(10)} 最后核对      状态`)
  console.log('  ' + '-'.repeat(w + 32))
  for (const r of shown) {
    const mark = r.status === 'stale' ? '⚠️  落后' : '✅ 同步'
    console.log(`  ${r.rel.padEnd(w)}  ${String(r.docVersion).padEnd(10)} ${r.date}  ${mark}`)
  }
}

const staleCount = rows.filter((r) => r.status === 'stale').length
console.log('\n' + '-'.repeat(72))
console.log(`  文档总数：${rows.length}　落后于当前版本：${staleCount}　本次${WRITE ? '已写入' : '待写入'}：${WRITE ? changed : shown.filter((r) => r.willChange).length}`)

if (!WRITE) {
  console.log('\n  ℹ️  预览模式（未改动任何文件）。确认无误后加 --write 执行。')
  console.log('  ℹ️  默认只更新「最后核对」日期；如该文档已按新版本重新验证，追加 --version <版本号>。')
  console.log('  ℹ️  「适用版本」是核对基线快照，不强制跟随应用版本——陈旧项不代表文档有误。\n')
} else {
  console.log(`\n  ✅ 已更新 ${changed} 个文档的「最后核对」日期${TARGET_VERSION ? ` 并将适用版本设为 ${TARGET_VERSION}` : ''}。\n`)
}

if (STALE_ONLY && staleCount === 0) {
  console.log('  ✅ 所有文档均标记为当前应用版本\n')
}
