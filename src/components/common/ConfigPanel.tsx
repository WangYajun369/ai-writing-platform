/**
 * ConfigPanel — 应用配置元信息调试面板
 *
 * 调试控制台（?debugwin=1）的子面板，展示 app_config 持久化状态：
 * - 当前应用支持的配置版本（CONFIG_VERSION）
 * - 各段配置的持久化版本与最近更新时间；未持久化的段标注「使用默认值」
 *
 * 与 SchemaPanel 互补：后者看的是 SQLite 库结构，本面板看的是统一配置模块
 * （app_config 表）的落库情况，用于排查「设置改了没存 / 段版本回退」类问题。
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2Icon, RefreshCwIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react'
import { configApi, type ConfigMeta, type ConfigSectionName } from '@/lib/tauri-bridge'
import { errText } from '@/lib/errors'

/** 全部配置段（含未被持久化的段，便于一眼看出哪些段仍是默认值） */
const ALL_SECTIONS: { key: ConfigSectionName; label: string; desc: string }[] = [
  { key: 'ai', label: 'AI 配置', desc: '对话 / RAG 服务商与密钥' },
  { key: 'tts', label: '语音朗读', desc: '豆包语音合成（音色 / API Key）' },
  { key: 'preferences', label: '偏好设置', desc: '主题 / 字体 / 网格 / 编辑器宽度' },
  { key: 'ai_tool_categories', label: 'AI 工具箱分类', desc: '用户自定义提示词分类' },
]

/** 组件:配置元信息调试面板 */
export default function ConfigPanel({ onClose }: { onClose: () => void }) {
  const [meta, setMeta] = useState<ConfigMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setMeta(await configApi.getMeta())
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const metaOf = (section: string) => meta?.sections.find((s) => s.section === section)

  return (
    <div className="absolute inset-0 z-20 bg-background flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-card shrink-0">
        <SlidersHorizontalIcon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">应用配置</span>
        <div className="flex-1" />
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors disabled:opacity-50"
          title="刷新"
        >
          {loading ? <Loader2Icon className="w-3.5 h-3.5 animate-spin" /> : <RefreshCwIcon className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground transition-colors"
          title="关闭配置面板"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {error ? (
          <div className="text-sm text-red-600 dark:text-red-400 py-2">加载失败: {error}</div>
        ) : !meta ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2Icon className="w-4 h-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-md bg-primary/10 text-primary">
              <span>当前应用支持的配置版本：v{meta.currentVersion}</span>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-muted-foreground mb-1.5 px-1">
                持久化状态（{meta.sections.length} / {ALL_SECTIONS.length} 段已落库）
              </h3>
              <div className="space-y-1 border rounded-md overflow-hidden">
                {ALL_SECTIONS.map(({ key, label, desc }) => {
                  const m = metaOf(key)
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-2 text-xs px-3 py-2 bg-card odd:bg-muted/20"
                    >
                      <span className="shrink-0 w-32">
                        <span className="font-medium text-foreground">{label}</span>
                        <span className="block text-[10px] text-muted-foreground/70">{desc}</span>
                      </span>
                      <span className="flex-1" />
                      {m ? (
                        <>
                          <span className="shrink-0 font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            v{m.version}
                          </span>
                          <span className="shrink-0 font-mono text-muted-foreground/70 text-[10px]">
                            {m.updatedAt ?? '—'}
                          </span>
                        </>
                      ) : (
                        <span className="shrink-0 text-[10px] text-muted-foreground/60">
                          未持久化 · 使用内置默认值
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="text-[10px] text-muted-foreground/60 px-1 leading-relaxed">
              配置存于 SQLite <code className="font-mono">app_config</code> 表（section 为主键）。
              读取时按「默认值 → 持久化值 → env 覆盖」三层合并；段版本高于应用支持版本时
              启动会拒绝（<code className="font-mono">E_CONFIG_VERSION</code>），防止降级误写。
            </div>
          </>
        )}
      </div>
    </div>
  )
}
