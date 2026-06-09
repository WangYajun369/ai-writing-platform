/**
 * 设置页共享常量 —— 服务商默认值、模型列表等
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
