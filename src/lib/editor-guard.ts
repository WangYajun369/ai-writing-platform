/**
 * Editor 可用性防护工具
 *
 * TipTap 在 React StrictMode（开发模式）下会创建/销毁多个编辑器实例，
 * `Editor.destroy()` 会将 `commandManager` 等内部字段置为 null。
 * 业务代码若持有已销毁实例并调用 `editor.can()` / `editor.chain()` /
 * `editor.isActive()` 等方法，会抛出
 * `null is not an object (evaluating 'this.commandManager.can')`。
 *
 * 所有从 atom / 异步回调 / 事件回调中访问 editor 的代码，
 * 都应先通过本工具确认实例可用。
 */
import type { Editor } from '@tiptap/react'

/**
 * 判断编辑器实例是否仍然可用（存在且未被销毁）。
 */
export function isEditorUsable(editor: Editor | null | undefined): editor is Editor {
  return !!editor && !editor.isDestroyed
}
