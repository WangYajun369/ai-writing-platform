/**
 * 设置页共享常量 —— 服务商默认值、模型列表等
 *
 * - provider key（bigmodel / deepseek）与 types.ts 中 Provider/RagProvider 一致，
 *   设置区块按 key 读取对应默认值并随服务商切换整体套用
 * - DeepSeek 不提供 Embeddings API，因此 RAG 侧仅维护 bigmodel（智谱）默认项
 * - GITHUB_REPO 供「版本更新」区块通过 GitHub Releases API 做兜底检查
 */

/** 智谱 BigModel 可选模型 */
export const BIGMODEL_MODELS = ['glm-5.1'] as const

/** DeepSeek 可选模型 */
export const DEEPSEEK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const

/** RAG Embedding 可选模型（智谱） */
export const RAG_BIGMODEL_MODELS = ['embedding-3'] as const

/** 服务商默认配置 */
export const PROVIDER_DEFAULTS: Record<string, { endpoint: string; model: string }> = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.1' },
  deepseek: { endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
}

/** RAG 服务商默认配置 */
export const RAG_PROVIDER_DEFAULTS: Record<string, { endpoint: string; embeddingModel: string }> = {
  bigmodel: { endpoint: 'https://open.bigmodel.cn/api/paas/v4', embeddingModel: 'embedding-3' },
}

/** GitHub 仓库地址（版本更新检查用） */
export const GITHUB_REPO = 'WangYajun369/ai-writing-platform'
