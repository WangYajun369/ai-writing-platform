/**
 * 跨窗口事件名常量 + 类型化契约。
 *
 * 现状痛点：事件名硬编码字符串散落在前后端多个文件，无类型约束，
 * 重命名时只能全文搜索，且易遗漏导致静默失效。
 *
 * 收敛策略：所有跨窗口事件名在此单一真源定义，前后端共享字符串字面量。
 * 后端 Rust 用 `app.emit(WindowEvent::SCHEDULER_TICK.as_str(), ...)`
 * 或直接硬编码同名字符串（保持与前端常量一致）。
 *
 * 新增事件时：
 * 1. 在 WindowEvent enum 追加变体
 * 2. 在 EVENT_NAME 映射追加字符串
 * 3. 在 WindowEventPayload 类型追加 payload 类型（若有）
 */

/**
 * 全部跨窗口事件名。
 *
 * 命名约定：kebab-case，动词过去时表示状态变化（closed/updated），
 * 名词表示数据流（tick）。
 */
export enum WindowEvent {
  /** 调度器每轮 tick（service/scheduler.rs emit） */
  SCHEDULER_TICK = 'scheduler-tick',
  /** debug 窗口关闭（commands/window/debug.rs emit） */
  DEBUG_WINDOW_CLOSED = 'debug-window-closed',
  /** AI 工具箱窗口关闭（commands/window/manager.rs close_event） */
  AI_TOOLBOX_WINDOW_CLOSED = 'ai-toolbox-window-closed',
  /** 世界观窗口关闭 */
  WORLD_WINDOW_CLOSED = 'world-window-closed',
  /** 版本历史窗口关闭 */
  HISTORY_WINDOW_CLOSED = 'history-window-closed',
  /** 章节总结窗口关闭 */
  SUMMARY_WINDOW_CLOSED = 'summary-window-closed',
  /** 生词本窗口关闭 */
  VOCAB_WINDOW_CLOSED = 'vocab-window-closed',
  /** 任务卡窗口关闭 */
  TASKS_WINDOW_CLOSED = 'tasks-window-closed',
  /** 生词本到期数据更新（service/vocab_service.rs emit） */
  VOCAB_DUE_UPDATED = 'vocab-due-updated',
  /** 任务卡数据更新（taskCardsStore 变更后广播） */
  TASKS_DATA_UPDATED = 'tasks-data-updated',
  /**
   * Agent 状态变化（lib.rs 主窗口关闭联动用）。
   * @deprecated 命名耦合「关闭」语义，后续应拆为 APP_CLOSING + AGENT_STATUS 两个事件。
   */
  AGENT_STATUS_CHANGED = 'agent-status-changed',
}

/**
 * 事件 payload 类型映射。
 *
 * 未列出的事件 payload 为 `null` 或 `undefined`。
 * 新增事件若有 payload，在此追加映射。
 */
export interface WindowEventPayload {
  [WindowEvent.SCHEDULER_TICK]: {
    job: string;
    ok: boolean;
    failures: number;
    elapsedMs: number;
    error?: string;
  };
  [WindowEvent.DEBUG_WINDOW_CLOSED]: null;
  [WindowEvent.AI_TOOLBOX_WINDOW_CLOSED]: null;
  [WindowEvent.WORLD_WINDOW_CLOSED]: null;
  [WindowEvent.HISTORY_WINDOW_CLOSED]: null;
  [WindowEvent.SUMMARY_WINDOW_CLOSED]: null;
  [WindowEvent.VOCAB_WINDOW_CLOSED]: null;
  [WindowEvent.TASKS_WINDOW_CLOSED]: null;
  [WindowEvent.VOCAB_DUE_UPDATED]: null;
  [WindowEvent.TASKS_DATA_UPDATED]: null;
  [WindowEvent.AGENT_STATUS_CHANGED]: string | null;
}

/**
 * 事件名常量集合（用于迭代或运行时反查）。
 * 与 WindowEvent enum 一一对应，CI 应通过单测强制覆盖。
 */
export const ALL_WINDOW_EVENTS: readonly WindowEvent[] = Object.freeze([
  WindowEvent.SCHEDULER_TICK,
  WindowEvent.DEBUG_WINDOW_CLOSED,
  WindowEvent.AI_TOOLBOX_WINDOW_CLOSED,
  WindowEvent.WORLD_WINDOW_CLOSED,
  WindowEvent.HISTORY_WINDOW_CLOSED,
  WindowEvent.SUMMARY_WINDOW_CLOSED,
  WindowEvent.VOCAB_WINDOW_CLOSED,
  WindowEvent.TASKS_WINDOW_CLOSED,
  WindowEvent.VOCAB_DUE_UPDATED,
  WindowEvent.TASKS_DATA_UPDATED,
  WindowEvent.AGENT_STATUS_CHANGED,
]);

/**
 * 校验事件名是否在已知集合内（防御性编程）。
 * 用于后端 emit 或前端 listen 前的运行时校验。
 */
export function isKnownWindowEvent(name: string): name is WindowEvent {
  return ALL_WINDOW_EVENTS.includes(name as WindowEvent);
}
