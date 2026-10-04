/**
 * Plugin Manifest Schema 校验
 *
 * 在 register 前校验 manifest 字段,畸形插件直接拒绝注册,
 * 避免后续调用时静默失败或污染扩展点枚举。
 *
 * 错误码:E_PLUGIN_MANIFEST(纯前端,不上 Rust)
 */
import type { PluginManifest, ExtensionPoint } from './types'

/** 合法扩展点白名单(与 types.ts ExtensionPoint 联合类型保持一致) */
export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  'editor-toolbar',
  'editor-sidebar',
  'library-card',
  'export-format',
  'ai-prompt',
  'command-palette',
  'home-header',
]

/** id 规则:小写字母/数字/连字符,2-64 字符,首字符为字母或数字 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

/** semver 简化校验(支持 prerelease/build) */
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 校验结果 */
export interface ManifestValidation {
  ok: boolean
  /** 字段级错误清单(空数组表示通过) */
  errors: string[]
}

/** 单字段校验规则 */
type Rule = (m: PluginManifest) => string | null

const rules: Rule[] = [
  (m) =>
    typeof m.id === 'string' && ID_PATTERN.test(m.id)
      ? null
      : `id 必须为 3-64 字符的小写字母/数字/连字符,且以字母或数字开头`,
  (m) =>
    typeof m.name === 'string' && m.name.trim().length >= 1 && m.name.length <= 100
      ? null
      : `name 必须为 1-100 字符`,
  (m) =>
    typeof m.version === 'string' && SEMVER_PATTERN.test(m.version)
      ? null
      : `version 必须为合法 semver (如 1.0.0)`,
  (m) =>
    typeof m.description === 'string' &&
    m.description.trim().length >= 1 &&
    m.description.length <= 500
      ? null
      : `description 必须为 1-500 字符`,
  (m) => {
    if (!Array.isArray(m.extensionPoints) || m.extensionPoints.length === 0) {
      return `extensionPoints 必须为非空数组`
    }
    const invalid = m.extensionPoints.filter(
      (p) => !EXTENSION_POINTS.includes(p),
    )
    return invalid.length > 0
      ? `extensionPoints 含未知值: ${invalid.join(', ')}`
      : null
  },
  (m) => {
    if (m.minAppVersion === undefined) return null
    return typeof m.minAppVersion === 'string' &&
      SEMVER_PATTERN.test(m.minAppVersion)
      ? null
      : `minAppVersion 必须为合法 semver`
  },
  (m) => {
    if (m.author === undefined) return null
    return typeof m.author === 'string' && m.author.length <= 100
      ? null
      : `author 必须为 ≤100 字符的字符串`
  },
  (m) => {
    if (m.homepage === undefined) return null
    try {
      // eslint-disable-next-line no-new
      new URL(m.homepage)
      return null
    } catch {
      return `homepage 必须为合法 URL`
    }
  },
]

/** 校验 manifest;返回 { ok, errors } */
export function validateManifest(
  manifest: Partial<PluginManifest>,
): ManifestValidation {
  const errors: string[] = []
  for (const rule of rules) {
    const err = rule(manifest as PluginManifest)
    if (err) errors.push(err)
  }
  return { ok: errors.length === 0, errors }
}
