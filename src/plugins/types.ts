/**
 * TimeWrite Plugin System - Type Definitions
 *
 * 插件系统核心类型定义，所有插件必须遵循此接口规范。
 */

/** 插件可注册的扩展点 */
export type ExtensionPoint =
  | 'editor-toolbar'    // 编辑器工具栏按钮
  | 'editor-sidebar'    // 编辑器侧边栏面板
  | 'library-card'      // 书库卡片自定义操作
  | 'export-format'     // 导出格式扩展
  | 'ai-prompt'         // AI 提示词模板
  | 'command-palette'   // 命令面板条目

/** 插件注册的命令/操作 */
export interface PluginCommand {
  /** 命令唯一标识 (e.g. "my-plugin.format-text") */
  id: string
  /** 命令显示名称 */
  label: string
  /** 快捷键 (可选，e.g. "Ctrl+Shift+F") */
  shortcut?: string
  /** 命令所属扩展点 */
  extensionPoint: ExtensionPoint
  /** 命令图标名称 (lucide-react icon name) */
  icon?: string
  /** 命令执行处理函数 */
  handler: (context: CommandContext) => Promise<void> | void
}

/** 命令执行上下文 */
export interface CommandContext {
  /** 当前活跃书籍 ID */
  bookId?: string
  /** 当前活跃章节 ID */
  chapterId?: string
  /** 当前编辑器选中文本 */
  selectedText?: string
  /** 当前编辑器内容 */
  editorContent?: string
  /** 应用级通知函数 */
  notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void
}

/** 插件元信息 */
export interface PluginManifest {
  /** 插件唯一标识 */
  id: string
  /** 插件显示名称 */
  name: string
  /** 版本号 (semver) */
  version: string
  /** 插件描述 */
  description: string
  /** 作者 */
  author?: string
  /** 主页/仓库地址 */
  homepage?: string
  /** 插件图标 (lucide-react icon name) */
  icon?: string
  /** 该插件使用的扩展点列表 */
  extensionPoints: ExtensionPoint[]
  /** 最低兼容版本 */
  minAppVersion?: string
}

/** 插件生命周期接口 */
export interface Plugin {
  /** 插件元信息 */
  manifest: PluginManifest
  /** 插件初始化 (在应用启动时调用) */
  init?(context: PluginContext): Promise<void> | void
  /** 获取插件提供的命令列表 */
  getCommands?(): PluginCommand[]
  /** 插件销毁 (在插件卸载时调用) */
  destroy?(): void
}

/** 插件运行时上下文 (由 PluginManager 提供) */
export interface PluginContext {
  /** 应用状态 API */
  app: {
    /** 获取当前活跃书籍 ID */
    getActiveBookId(): string | undefined
    /** 获取当前活跃章节 ID */
    getActiveChapterId(): string | undefined
    /** 显示通知 */
    notify(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void
  }
  /** 编辑器 API */
  editor: {
    /** 获取编辑器选中文本 */
    getSelectedText(): string
    /** 替换选中文本 */
    replaceSelection(text: string): void
    /** 在光标处插入文本 */
    insertText(text: string): void
    /** 获取完整编辑器内容 (HTML) */
    getContent(): string
  }
  /** 存储API - 每个插件独立的 key-value 存储 */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set<T = unknown>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
    keys(): Promise<string[]>
  }
}

/** 插件状态 */
export type PluginStatus = 'installed' | 'active' | 'disabled' | 'error'

/** 已安装插件的信息 */
export interface InstalledPlugin {
  manifest: PluginManifest
  status: PluginStatus
  error?: string
  enabledAt?: number  // timestamp
}
