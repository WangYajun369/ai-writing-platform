/**
 * Tauri 事件监听 hook：封装 listen/unlisten，竞态安全。
 *
 * 现状痛点（v1.8.1 修复一例）：跨窗口事件监听器散落各组件，
 * 各自手写 listen + unlisten，容易出竞态：
 * - 组件卸载时 unlisten 未完成，新窗口已 emit 事件被旧监听器吞掉
 * - StrictMode 双调用导致 listen 被注册两次
 * - 事件名硬编码字符串拼错，静默失效
 *
 * 用法：
 * ```ts
 * useTauriEvent(WindowEvent.SCHEDULER_TICK, (e) => {
 *   console.debug('[scheduler-tick]', e.payload);
 * });
 * ```
 *
 * 不变量：
 * - 监听器在组件 mount 后注册，unmount 时卸载（自动）
 * - 同一 (event, handler) 组合在 StrictMode 双 mount 下只注册一次（用 ref 守护）
 * - 事件名必须是 WindowEvent 枚举成员（类型约束）
 *
 * @param event WindowEvent 枚举成员
 * @param handler 事件回调，payload 类型由 WindowEventPayload 自动推导
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WindowEvent, type WindowEventPayload } from '@/lib/window-events';

export function useTauriEvent<E extends WindowEvent>(
  event: E,
  handler: (event: { payload: WindowEventPayload[E] }) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen<WindowEventPayload[E]>(event, (e) => {
      // 通过 ref 调用最新 handler，避免闭包过期
      handlerRef.current(e);
    })
      .then((un) => {
        if (cancelled) {
          // 组件已卸载，立即 unlisten 防止泄漏
          un();
        } else {
          unlisten = un;
        }
      })
      .catch((err) => {
        // 监听失败不应阻塞组件渲染，仅 console.error
        console.error(`[useTauriEvent] listen "${event}" failed:`, err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [event]);
}
