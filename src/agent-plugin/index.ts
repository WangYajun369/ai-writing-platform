/**
 * Agent 插件运行时（ADR-006）
 *
 * 与 `src/plugins/`（内置模块）是两套东西——本目录是**运行时从磁盘装卸、
 * 带 `grants` 权限、贡献 Agent 画像**的那套。划界见
 * `docs/development/plugin-system.md`。
 */

export { buildHost } from './host'
export { buildPlan, type BuildPlanOptions } from './runtime'
export { executeSkillWithPluginPlan, resolvePluginPlan } from './execute'
export type {
  HostContext,
  PlanStep,
  PluginCardInput,
  PluginCardRef,
  PluginChapterRef,
  PluginContext,
  PluginHost,
  PluginModule,
} from './types'
