/**
 * Agent 插件管理区块（ADR-006）
 *
 * ## 安装为什么分两步
 *
 * 插件是本应用里唯一的第三方可执行代码。安装流程刻意拆成
 * 「装进来（默认未启用）→ 展示源码与 grants → 用户确认后才启用」，
 * 这是 ADR-006 决策 4 三条缓解措施在 UI 上的落点：
 *
 * 1. **纯文本可读** —— 插件是 `.js` 源码而非二进制，这里原样展示供人工审核；
 * 2. **显式确认** —— `grants` 逐项列出，用户逐项过目后点确认；
 * 3. **能力最小化** —— 只注入声明过的项（由后端保证，界面如实展示声明内容）。
 *
 * 装完不自动启用是有意的：未经阅读就启用，等于把「确认」退化成走过场。
 */
import { useCallback, useEffect, useState } from 'react'
import { open, confirm } from '@tauri-apps/plugin-dialog'
import {
  PackageIcon,
  PlusIcon,
  Trash2Icon,
  CodeIcon,
  ShieldCheckIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from 'lucide-react'
import { errText } from '@/lib/errors'
import { toast } from '@/lib/toast'
import {
  pluginApi,
  PLUGIN_GRANT_LABELS,
  type InstalledPlugin,
  type PluginGrant,
} from '@/lib/tauri-bridge'
import { Toggle } from './shared'

/** 刚装好、等待用户审核的插件（未启用） */
interface PendingInstall {
  plugin: InstalledPlugin
  source: string
}

export function PluginSection() {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [listError, setListError] = useState('')
  const [pending, setPending] = useState<PendingInstall | null>(null)
  /** 已展开源码的插件 id */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sources, setSources] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setPlugins(await pluginApi.list())
      setListError('')
    } catch (err) {
      setListError(errText(err, '加载插件列表失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** 安装：选目录 → 装进来（未启用）→ 拉取源码进入审核态 */
  const handleInstall = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: '选择插件目录（需包含 manifest.json）',
    })
    if (!picked || Array.isArray(picked)) return

    setBusy(true)
    try {
      const plugin = await pluginApi.install(picked)
      let source = ''
      try {
        source = await pluginApi.source(plugin.manifest.id)
      } catch {
        source = '（源码读取失败，无法审核，建议直接卸载）'
      }
      setPending({ plugin, source })
      await refresh()
    } catch (err) {
      toast.error(errText(err, '安装失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 确认启用（审核通过） */
  const handleConfirmEnable = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await pluginApi.setEnabled(pending.plugin.manifest.id, true)
      toast.success(`已启用插件「${pending.plugin.manifest.name}」`)
      setPending(null)
      await refresh()
    } catch (err) {
      toast.error(errText(err, '启用失败'))
    } finally {
      setBusy(false)
    }
  }

  /** 审核未通过：直接卸载，不留一个装了又不启用的可疑目录 */
  const handleReject = async () => {
    if (!pending) return
    setBusy(true)
    try {
      await pluginApi.uninstall(pending.plugin.manifest.id)
      toast.success('已取消安装')
      setPending(null)
      await refresh()
    } catch (err) {
      toast.error(errText(err, '卸载失败'))
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = async (p: InstalledPlugin, enabled: boolean) => {
    try {
      await pluginApi.setEnabled(p.manifest.id, enabled)
      await refresh()
    } catch (err) {
      toast.error(errText(err, enabled ? '启用失败' : '停用失败'))
    }
  }

  const handleUninstall = async (p: InstalledPlugin) => {
    const ok = await confirm(`确定卸载插件「${p.manifest.name}」？`, {
      title: '卸载插件',
      kind: 'warning',
    })
    if (!ok) return
    try {
      await pluginApi.uninstall(p.manifest.id)
      toast.success('已卸载')
      await refresh()
    } catch (err) {
      toast.error(errText(err, '卸载失败'))
    }
  }

  /** 展开时按需拉取源码，避免列表加载时为所有插件都读一遍文件 */
  const toggleSource = async (id: string) => {
    if (expanded === id) {
      setExpanded(null)
      return
    }
    setExpanded(id)
    if (!sources[id]) {
      try {
        const src = await pluginApi.source(id)
        setSources((prev) => ({ ...prev, [id]: src }))
      } catch (err) {
        setSources((prev) => ({ ...prev, [id]: errText(err, '源码读取失败') }))
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Agent 插件</h2>
          <p className="text-sm text-muted-foreground mt-1">
            插件可贡献自定义 Agent 画像。它是第三方代码，安装后请先阅读源码与权限声明，再决定是否启用。
          </p>
        </div>
        <button
          onClick={handleInstall}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm shrink-0 disabled:opacity-50"
        >
          <PlusIcon className="w-4 h-4" />
          安装插件
        </button>
      </div>

      {listError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 text-sm">
          <AlertTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{listError}</span>
        </div>
      )}

      {/* 安装确认面板：源码 + 逐项 grants */}
      {pending && (
        <InstallConfirmCard
          pending={pending}
          busy={busy}
          onConfirm={handleConfirmEnable}
          onReject={handleReject}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : plugins.length === 0 ? (
        <div className="p-4 bg-muted rounded-lg text-sm text-muted-foreground">
          尚未安装任何插件。
        </div>
      ) : (
        <div className="space-y-3">
          {plugins.map((p) => (
            <PluginCard
              key={p.manifest.id}
              plugin={p}
              source={expanded === p.manifest.id ? sources[p.manifest.id] : undefined}
              onToggle={(enabled) => handleToggle(p, enabled)}
              onUninstall={() => handleUninstall(p)}
              onToggleSource={() => toggleSource(p.manifest.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ──────────────── 安装确认卡片 ────────────────

interface InstallConfirmCardProps {
  pending: PendingInstall
  busy: boolean
  onConfirm: () => void
  onReject: () => void
}

function InstallConfirmCard({ pending, busy, onConfirm, onReject }: InstallConfirmCardProps) {
  const { plugin, source } = pending
  const m = plugin.manifest
  return (
    <div className="border-2 border-primary/40 rounded-xl p-4 space-y-3 bg-primary/5">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="w-4 h-4 text-primary shrink-0" />
        <h3 className="text-sm font-semibold">安装确认：{m.name}</h3>
        <span className="text-xs text-muted-foreground">v{m.version}</span>
      </div>

      {m.description && <p className="text-sm text-muted-foreground">{m.description}</p>}

      <div>
        <p className="text-xs font-medium mb-1.5">该插件将获得以下能力：</p>
        {m.grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">（未声明任何权限，仅提供画像配置）</p>
        ) : (
          <ul className="space-y-1">
            {m.grants.map((g) => (
              <li key={g} className="flex items-start gap-2 text-sm">
                <span className="text-primary mt-0.5">•</span>
                <span>
                  <code className="bg-muted px-1 rounded text-xs">{g}</code>
                  {' — '}
                  {PLUGIN_GRANT_LABELS[g as PluginGrant] ?? g}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {m.profiles.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1.5">将新增 {m.profiles.length} 个 Agent 画像：</p>
          <ul className="space-y-1">
            {m.profiles.map((p) => (
              <li key={p.id} className="text-sm flex items-center gap-2">
                <span className="text-muted-foreground">·</span>
                <span className="font-medium">{p.label}</span>
                <code className="bg-muted px-1 rounded text-xs text-muted-foreground">{p.id}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-xs font-medium mb-1.5">
          源码（{m.entry}）——请确认其中没有可疑行为：
        </p>
        <pre className="bg-muted rounded-lg p-3 text-xs overflow-auto max-h-64 font-mono whitespace-pre-wrap break-all">
          {source || '（空文件）'}
        </pre>
      </div>

      <div className="flex gap-2 pt-1">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm disabled:opacity-50"
        >
          我已阅读，确认启用
        </button>
        <button
          onClick={onReject}
          disabled={busy}
          className="px-3 py-2 rounded-lg bg-muted text-sm hover:bg-muted/80 disabled:opacity-50"
        >
          不信任，移除
        </button>
      </div>
    </div>
  )
}

// ──────────────── 单个插件卡片 ────────────────

interface PluginCardProps {
  plugin: InstalledPlugin
  source?: string
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  onToggleSource: () => void
}

function PluginCard({ plugin, source, onToggle, onUninstall, onToggleSource }: PluginCardProps) {
  const m = plugin.manifest
  const broken = plugin.status === 'error'
  const isOpen = source !== undefined

  return (
    <div className="border rounded-xl p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <PackageIcon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm">{m.name || m.id}</span>
              {m.version && (
                <span className="text-xs text-muted-foreground">v{m.version}</span>
              )}
              <code className="bg-muted px-1 rounded text-xs text-muted-foreground">{m.id}</code>
            </div>
            {m.author && <p className="text-xs text-muted-foreground">作者：{m.author}</p>}
            {m.description && (
              <p className="text-sm text-muted-foreground mt-0.5">{m.description}</p>
            )}
            {broken && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-start gap-1">
                <AlertTriangleIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {plugin.error ?? '清单校验失败'}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Toggle enabled={plugin.enabled} onChange={onToggle} />
          <button
            onClick={onUninstall}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-red-600 transition-colors"
            title="卸载插件"
          >
            <Trash2Icon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {m.grants.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {m.grants.map((g) => (
            <span
              key={g}
              className="text-xs bg-muted px-1.5 py-0.5 rounded"
              title={PLUGIN_GRANT_LABELS[g as PluginGrant] ?? g}
            >
              {g}
            </span>
          ))}
        </div>
      )}

      <button
        onClick={onToggleSource}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {isOpen ? (
          <ChevronDownIcon className="w-3.5 h-3.5" />
        ) : (
          <ChevronRightIcon className="w-3.5 h-3.5" />
        )}
        <CodeIcon className="w-3.5 h-3.5" />
        查看源码
      </button>

      {isOpen && (
        <pre className="bg-muted rounded-lg p-3 text-xs overflow-auto max-h-64 font-mono whitespace-pre-wrap break-all">
          {source || '加载中…'}
        </pre>
      )}
    </div>
  )
}
