/**
 * Agent 插件运行时 —— 类型定义（ADR-006）
 *
 * ## 为什么放在 `src/agent-plugin/` 而不是 `src/plugins/host/`
 *
 * `src/plugins/` 是**内置模块**（编译期硬编码的 UI 扩展点插件）。把本目录塞进它的
 * 子树，会让两套东西在物理上也纠缠在一起。故 Agent 插件占独立顶层目录，
 * 与内置模块平级——划界见 `docs/development/plugin-system.md`。
 *
 * ## 插件能拿到什么
 *
 * 宿主只注入 `PluginHost` 这一个对象。所有可选字段对应一项 `grants`：
 * **未声明的能力一律不在对象上**（访问为 `undefined`），
 * 而不是「在对象上但调用时报错」——后者会让插件在探测能力时误判自己有权限。
 *
 * `log` 是唯一恒定注入的字段：它不读不写数据、无副作用、不构成数据出口。
 */

/**
 * 应用自身的 AI 配置（结构与 `AgentAiConfig` 兼容）
 *
 * 刻意**不**从 `@/lib/tauri-bridge` 导入：本模块是零依赖的类型层，
 * 而 `host.ts` 会反向依赖 bridge 去调 IPC——两侧互相引用会形成循环。
 * 结构兼容即可，无需名义依赖。
 */
export interface PluginAiConfig {
  provider: string
  endpoint: string
  model: string
  apiKey?: string | null
  temperature?: number | null
  maxTokens?: number | null
  thinkingEnabled?: boolean | null
}

/** 宿主注入给插件的能力集合（字段是否存在由 `grants` 决定） */
export interface PluginHost {
  /** 调用 LLM 做一次补全。走**应用自身的 AI 配置**，插件无法传入 endpoint 或 key */
  llm?: {
    complete(prompt: string): Promise<string>
  }
  /** 书籍与章节的**读**能力 */
  book?: {
    listChapters(): Promise<PluginChapterRef[]>
    readChapter(chapterId: string): Promise<string>
  }
  /**
   * 世界观卡片能力
   *
   * `search` 与 `create` **各自独立**受 `card.search` / `card.write` 控制：
   * 只声明了读取权限的插件，不该顺带拿到写权限。
   */
  card?: {
    search?(query: string): Promise<PluginCardRef[]>
    create?(input: PluginCardInput): Promise<{ id: string }>
  }
  /** 日志。恒定注入，无需声明 */
  log: {
    info(message: string): void
    warn(message: string): void
  }
  /** 插件私有键值存储（已按 pluginId 隔离，插件间互不可见） */
  storage?: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set<T = unknown>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
  }
}

/** 插件可见的章节引用（刻意不暴露完整 Chapter 的全部字段） */
export interface PluginChapterRef {
  id: string
  title: string
  wordCount: number
}

/** 插件可见的卡片引用 */
export interface PluginCardRef {
  id: string
  title: string
  cardType: string
  content: string
}

/** 插件创建卡片的入参 */
export interface PluginCardInput {
  title: string
  content: string
  cardType?: string
  tags?: string[]
}

/** 单个编排步骤 */
export interface PlanStep {
  /** 步骤名（会显示在进度里） */
  name: string
  /** 给模型的指令 */
  instruction: string
  /** 本步可用的工具名；**必须被插件的 grants 覆盖**，否则运行时直接拒绝 */
  tools: string[]
  /** 本步最多推理轮数，缺省 4，上限 20 */
  maxRounds?: number
}

/** 插件执行时的上下文 */
export interface PluginContext {
  bookId: string
  /** 用户本轮输入 */
  message: string
}

/** 插件入口模块（`index.js` 需要 `return` 出这个形状） */
export interface PluginModule {
  /**
   * 生成编排计划。返回 `null` / `undefined` 表示本次不接管编排，
   * 由引擎按画像默认方式执行（ReAct 或领域流水线）。
   */
  plan?(ctx: PluginContext): Promise<PlanStep[] | null> | PlanStep[] | null
}

/** 构造宿主注入对象所需的运行期上下文 */
export interface HostContext {
  pluginId: string
  bookId: string
  /** 应用自身的 AI 配置（插件不得覆盖 endpoint / apiKey） */
  aiConfig?: PluginAiConfig | null
}
