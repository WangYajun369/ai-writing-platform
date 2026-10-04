import { describe, it, expect } from 'vitest';
import {
  WindowEvent,
  ALL_WINDOW_EVENTS,
  isKnownWindowEvent,
} from '@/lib/window-events';

describe('window-events', () => {
  it('WindowEvent 枚举与 ALL_WINDOW_EVENTS 一一对应', () => {
    // 每个枚举成员都应在 ALL_WINDOW_EVENTS 中
    for (const name of Object.values(WindowEvent)) {
      expect(ALL_WINDOW_EVENTS).toContain(name);
    }
    // 数量一致
    expect(ALL_WINDOW_EVENTS.length).toBe(
      Object.values(WindowEvent).length,
    );
  });

  it('ALL_WINDOW_EVENTS 不可变（frozen）', () => {
    expect(Object.isFrozen(ALL_WINDOW_EVENTS)).toBe(true);
  });

  it('isKnownWindowEvent 正确识别已知事件', () => {
    expect(isKnownWindowEvent('scheduler-tick')).toBe(true);
    expect(isKnownWindowEvent('debug-window-closed')).toBe(true);
    expect(isKnownWindowEvent('ai-toolbox-window-closed')).toBe(true);
    expect(isKnownWindowEvent('vocab-due-updated')).toBe(true);
    expect(isKnownWindowEvent('tasks-data-updated')).toBe(true);
    expect(isKnownWindowEvent('agent-status-changed')).toBe(true);
  });

  it('isKnownWindowEvent 拒绝未知事件名', () => {
    expect(isKnownWindowEvent('unknown-event')).toBe(false);
    expect(isKnownWindowEvent('')).toBe(false);
    expect(isKnownWindowEvent('SCHEDULER_TICK')).toBe(false); // 大写不匹配
  });

  it('事件名遵循 kebab-case 命名约定', () => {
    for (const name of ALL_WINDOW_EVENTS) {
      // 全小写 + 连字符，无下划线/驼峰
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(name).not.toContain('_');
    }
  });
});
