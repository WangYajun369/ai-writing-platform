/**
 * 更新检查 API 层 —— GitHub Releases 兜底通道
 *
 * 应用内优先走 Tauri updater 插件（可静默下载安装，见 useUpdateCheck）；
 * 当插件不可用（Web 预览 / 权限缺失 / 签名不匹配）时回退到 GitHub Releases API：
 * 仅提示版本号与说明，并引导用户跳转下载页。
 */

import { isNewerVersion } from './version'

/** GitHub 仓库（owner/repo） */
export const GITHUB_REPO = 'WangYajun369/ai-writing-platform'

/** GitHub 兜底检查结果 */
export interface GithubReleaseInfo {
  /** tag 名称（如 v1.8.2） */
  version: string
  /** Release 页面地址 */
  url: string
  /** Release 说明正文 */
  body: string
}

/**
 * 通过 GitHub Releases API 检查更新
 * @returns 有新版本时返回版本信息；已是最新或无发布时返回 null
 * @throws 网络错误 / 非 2xx 响应（含 403 频率限制、404 无发布）
 */
export async function checkViaGithub(appVersion: string): Promise<GithubReleaseInfo | null> {
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!resp.ok) throw new Error(`GitHub API 返回 ${resp.status}`)
  const data = await resp.json()
  const remoteVer: string = data.tag_name ?? ''
  if (!remoteVer) return null
  if (isNewerVersion(remoteVer, appVersion)) {
    return {
      version: remoteVer,
      url: data.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`,
      body: data.body ?? '',
    }
  }
  return null
}

/** 打开外部链接（Tauri shell 优先，浏览器兜底） */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    window.open(url, '_blank')
  }
}
