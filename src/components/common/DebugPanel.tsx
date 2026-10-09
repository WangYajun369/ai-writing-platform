/**
 * DebugPanel — 调试控制台组件
 *
 * 调试独立窗口（?debugwin=1）的根面板。v1.9 可观测性体系收敛:
 * - 主视图为 `TelemetryExplorer`(统一 4+1 套通道:SQL/Agent/IO/Error/System)
 * - 顶部保留数据库校验入口(校验按钮 + ValidationPanel)
 * - v1.9 Schema 演进工具:SchemaPanel 展示版本/迁移/PRAGMA diff
 *
 * 历史:原 DebugPanel 直接渲染 LogEntry 列表;现统一收口到 telemetry 总线,
 * TelemetryExplorer 负责事件监听 / kind 过滤 / payload 详情展开。
 */
import { useCallback, useState } from 'react'
import { DatabaseIcon, GitBranchIcon, Loader2Icon } from 'lucide-react'
import { debugApi, type ValidationResult } from '@/lib/tauri-bridge'
import { errText } from '@/lib/errors'
import TelemetryExplorer, { ValidationPanel } from './TelemetryExplorer'
import SchemaPanel from './SchemaPanel'

/** 组件:调试控制台根面板(TelemetryExplorer 主视图 + 数据库校验入口 + Schema 演进工具) */
export default function DebugPanel() {
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [showValidation, setShowValidation] = useState(false)
  const [showSchema, setShowSchema] = useState(false)

  const handleValidate = useCallback(async () => {
    setValidating(true)
    setShowValidation(true)
    try {
      const result = await debugApi.validateDatabase()
      console.log('[validate_database] 返回结果:', JSON.stringify(result, null, 2))
      setValidationResult(result)
    } catch (e) {
      console.error('[validate_database] 执行失败', e)
      setValidationResult({
        ok: false,
        tablesCount: 0,
        issues: [{ table: '-', issueType: 'integrity_error', detail: `校验执行失败: ${errText(e)}` }],
      })
    } finally {
      setValidating(false)
    }
  }, [])

  return (
    <div className="relative h-screen flex flex-col bg-background">
      {/* 校验结果面板(显示时覆盖在事件列表上方) */}
      {showValidation && (
        <ValidationPanel
          result={validationResult}
          loading={validating}
          onClose={() => setShowValidation(false)}
        />
      )}

      {/* Schema 演进工具面板(全屏覆盖,显示时遮蔽 TelemetryExplorer) */}
      {showSchema && <SchemaPanel onClose={() => setShowSchema(false)} />}

      {/* 主视图:统一 Telemetry 事件查看器 */}
      {/* Schema / 校验数据库经 toolbar 插槽嵌入顶栏(替代原 absolute 浮层,避免遮挡过滤控件) */}
      <TelemetryExplorer
        toolbar={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowSchema(true)}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:bg-primary/10 text-primary transition-colors bg-card border"
              title="Schema 演进工具:版本/迁移历史/PRAGMA diff"
            >
              <GitBranchIcon className="w-3.5 h-3.5" />
              Schema
            </button>
            <button
              onClick={handleValidate}
              disabled={validating}
              className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50 bg-card border"
              title="校验本地 SQLite 数据库表结构和数据完整性"
            >
              {validating ? (
                <Loader2Icon className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <DatabaseIcon className="w-3.5 h-3.5" />
              )}
              校验数据库
            </button>
          </div>
        }
      />
    </div>
  )
}
