# 编辑器新增数学公式输入功能

## Context

TimeWrite 编辑器基于 TipTap v3.26，当前已集成 StarterKit / CodeBlock / Color / Image / Table 等扩展，但**不支持数学公式**。小说创作场景中，部分作者（科幻、学术类）需要在正文中插入公式，目前只能截图插入图片，无法编辑、排版受限。

项目 `package.json` 已经声明 `katex ^0.17.0` 依赖（在 vite chunk 中已配置），但**源代码从未使用**——属于历史预留。本任务通过引入官方 `@tiptap/extension-mathematics`，把 katex 真正用起来，为编辑器补齐公式能力。

## 需求（用户已确认）

| 维度 | 选择 |
|------|------|
| 实现方案 | 官方扩展 `@tiptap/extension-mathematics` |
| 公式类型 | 行内公式 `$...$` + 块级公式 `$$...$$` |
| 输入方式 | ① 工具栏按钮 + 弹窗 ② `$...$` 自动识别 ③ 双击已插入公式编辑 |

## 技术要点

`@tiptap/extension-mathematics` 自带：
- **InputRule**：输入 `$x^2$` 后空格 / 输入 `$$...$$` 自动转为公式节点（满足需求 ②）
- **NodeView 双击编辑**：双击渲染后的公式节点弹出 inline 编辑器修改 LaTeX（满足需求 ③）
- **KaTeX 渲染**：行内节点 `<span class="tiptap-mathematics-render">`、块级节点 `<div class="tiptap-mathematics-render">`
- **命令**：`insertInlineMath({ latex })` / `insertBlockMath({ latex })` 供工具栏调用（满足需求 ①）

序列化为 HTML 时输出 `<span data-type="inline-math" data-latex="...">` / `<div data-type="block-math" data-latex="...">`，与项目现有 HTML 存储链路完全兼容。

## 实施步骤

### 1. 安装依赖

```bash
pnpm add @tiptap/extension-mathematics@^3.26.0
```

注意锁定到与现有 `@tiptap/*` 相同的 3.26.x 版本，避免 TipTap v2/v3 混用。

### 2. 注册扩展到编辑器

修改 [RichTextEditor.tsx](file:///Users/wangyajun/Code/obj/MirageInk/src/components/editor/RichTextEditor.tsx)：

- 顶部 import：
  ```ts
  import Mathematics from '@tiptap/extension-mathematics'
  import 'katex/dist/katex.min.css'
  ```
- 在 `useEditor` 的 `extensions` 数组（L178-197）中加入：
  ```ts
  Mathematics.configure({
    inlineOptions: {
      // 点击行内公式即选中（不进入编辑），双击进入编辑
      onClick: (node, pos) => { /* 默认行为即可，可省略 */ },
    },
    blockOptions: { /* 同上 */ },
    katexOptions: {
      throwOnError: false,   // 非法 LaTeX 不抛异常，红色回显源码
      macros: {},            // 预留自定义宏
    },
  }),
  ```

### 3. 工具栏新增「数学公式」按钮 + 弹窗

修改 [EditorToolbar.tsx](file:///Users/wangyajun/Code/obj/MirageInk/src/components/editor/EditorToolbar.tsx)：

- 在「代码块」按钮（L405-410）之后插入新按钮，icon 用 `lucide-react` 的 `Sigma`：
  ```tsx
  <ToolbarBtn
    active={mathDialogOpen}
    onClick={() => setMathDialogOpen(true)}
    title="数学公式"
    icon={<SigmaIcon className="w-4 h-4" />}
  />
  ```
- 新增子组件 [toolbar/MathDialog.tsx](file:///Users/wangyajun/Code/obj/MirageInk/src/components/editor/toolbar/MathDialog.tsx)（参考现有 [toolbar/TablePopover.tsx](file:///Users/wangyajun/Code/obj/MirageInk/src/components/editor/toolbar/TablePopover.tsx) 的弹层模式）：
  - 单选切换「行内 / 块级」
  - `<textarea>` 输入 LaTeX 源码
  - **实时预览区**：用 `katex.renderToString(latex, { displayMode: isBlock, throwOnError: false })` 渲染
  - 「插入」按钮调用：
    - 行内：`editor.chain().focus().insertInlineMath({ latex }).run()`
    - 块级：`editor.chain().focus().insertBlockMath({ latex }).run()`
  - 「取消」按钮关闭弹层

### 4. 样式补充

在 [src/styles/theme.css](file:///Users/wangyajun/Code/obj/MirageInk/src/styles/theme.css)（或编辑器专用样式文件）补充：

```css
/* 行内公式 */
.tiptap-mathematics-render {
  padding: 0 0.15em;
  border-radius: 0.25rem;
  cursor: pointer;
}
.tiptap-mathematics-render:hover {
  background: hsl(var(--muted));
}
/* 块级公式 */
.tiptap-mathematics-render[data-type="block-math"] {
  display: block;
  padding: 0.75rem 1rem;
  margin: 0.5rem 0;
  text-align: center;
  background: hsl(var(--muted) / 0.4);
  border-radius: 0.5rem;
}
/* LaTeX 语法错误时红色提示 */
.tiptap-mathematics-render--error {
  color: hsl(var(--destructive));
  background: hsl(var(--destructive) / 0.1);
}
```

### 5. 字数统计兼容

检查 [lib/utils.ts](file:///Users/wangyajun/Code/obj/MirageInk/src/lib/utils.ts) 中 `countWordsFromHtml` 是否会被公式 HTML 干扰。`data-latex` 属性中的 LaTeX 源码不应计入字数。如有需要，在统计前先用 DOMParser 移除 `[data-type$="-math"]` 节点的文本，或只统计可见文本。

## 关键文件

| 文件 | 变更类型 |
|------|---------|
| `package.json` | 新增 `@tiptap/extension-mathematics` 依赖 |
| `src/components/editor/RichTextEditor.tsx` | 注册 Mathematics 扩展 + 引入 katex CSS |
| `src/components/editor/EditorToolbar.tsx` | 新增按钮 + 弹窗开关状态 |
| `src/components/editor/toolbar/MathDialog.tsx` | **新增** 公式输入弹窗 |
| `src/styles/theme.css` | 公式节点样式 |
| `src/lib/utils.ts` | （视情况）字数统计排除公式 |

## 验证方式

1. `pnpm dev` 启动，进入任一章节
2. **自动识别**：输入 `$E=mc^2$` 后敲空格 → 应转为行内公式；输入 `$$\int_0^1 x\,dx$$` 回车 → 应转为块级公式
3. **工具栏**：点击 ∑ 按钮 → 弹窗中输入 `\frac{a}{b}`，切换行内/块级，实时预览正确，插入成功
4. **双击编辑**：双击已插入公式 → 出现 inline 编辑器可改 LaTeX，失焦后重新渲染
5. **语法错误**：输入 `\frac{a}{` 不应让编辑器崩溃，公式区域红色回显源码
6. **持久化**：刷新 / 切换章节后公式仍在，HTML 中保留 `data-latex` 属性
7. **导出**：通过导出 TXT/MD/HTML 检查公式节点的序列化输出是否合理（MD 应保留 `$...$`，TXT 至少保留源码）
8. `pnpm test` 通过，`pnpm build` 通过
