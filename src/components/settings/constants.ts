/**
 * 设置页共享常量 —— 可选模型列表等
 *
 * - 服务商端点 / 模型默认值的**单一真源在后端** `src-tauri/src/config/defaults.rs`
 *   （三层加载：默认值 → 持久化值 → env），前端不再硬编码，避免前后端双写漂移
 * - 本文件仅维护「可选模型列表」，供设置区块渲染下拉项
 * - DeepSeek 不提供 Embeddings API，因此 RAG 侧仅维护 bigmodel（智谱）可选项
 * - GITHUB_REPO 的真源在 lib/updateApi.ts（更新检查链路），此处 re-export 保持旧引用可用
 */

export { GITHUB_REPO } from '@/lib/updateApi.ts'

/**
 * DeepSeek 内置可选项（fallback）
 *
 * 仅在「获取全部模型」尚未拉取成功、或拉取失败时作为下拉兜底。
 * 当前在售模型（据 DeepSeek 价目表）：`deepseek-flash`（V4.1-Flash）、
 * `deepseek-v4-pro`（V4-Pro）。旧名 `deepseek-v4-flash` 仍可被路由到 Flash，
 * 但属弃用别名，故此处不再列入。
 */
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

/** RAG Embedding 可选模型（智谱） */
export const RAG_BIGMODEL_MODELS = ['embedding-3'] as const
