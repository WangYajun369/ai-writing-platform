/**
 * Tailwind CSS 配置文件
 *
 * 项目：MirageInk —— 基于海市蜃楼概念的小说创作工具
 * 本文件通过 CSS 变量 + HSL 色彩空间实现主题定制，
 * 并扩展了字体、动画、圆角等设计令牌，统一视觉风格。
 *
 * @see https://tailwindcss.com/docs/configuration
 */

/** @type {import('tailwindcss').Config} */
export default {
  // =========================================================================
  // 暗色模式策略
  // 'class' 策略：通过在 <html> 标签上切换 'dark' 类名来启用暗色模式，
  // 而非依赖系统偏好（prefers-color-scheme）。
  // =========================================================================
  darkMode: ['class'],

  // =========================================================================
  // 内容扫描路径
  // Tailwind 会扫描以下 glob 匹配的文件，提取其中使用的工具类名，
  // 从而生成最终的生产 CSS（Tree-shaking）。
  // =========================================================================
  content: [
    './index.html',                  // 应用入口 HTML
    './src/**/*.{ts,tsx,js,jsx}',   // src 目录下所有 TS/JS 文件
  ],

  // =========================================================================
  // 主题扩展
  // 在 Tailwind 默认主题基础上，额外添加自定义设计令牌。
  // 所有颜色值均使用 hsl(var(--xxx)) 引用 CSS 变量，
  // 以便在 :root / .dark 选择器中灵活切换亮/暗主题。
  // =========================================================================
  theme: {
    extend: {
      // -------------------------------------------------------------------
      // 颜色体系（语义化命名，兼容 shadcn/ui 规范）
      // -------------------------------------------------------------------
      colors: {
        /** 边框颜色，用于分隔线、输入框边框等 */
        border: 'hsl(var(--border))',
        /** 输入框背景色 */
        input: 'hsl(var(--input))',
        /** 焦点环（focus ring）颜色 */
        ring: 'hsl(var(--ring))',
        /** 页面/组件整体背景色 */
        background: 'hsl(var(--background))',
        /** 页面/组件整体前景文字色 */
        foreground: 'hsl(var(--foreground))',

        /** 主要操作色（按钮、链接等） */
        primary: {
          /** 主色 */
          DEFAULT: 'hsl(var(--primary))',
          /** 主色上的文字/图标色 */
          foreground: 'hsl(var(--primary-foreground))',
        },

        /** 次要操作色（辅助按钮、标签等） */
        secondary: {
          /** 次要色 */
          DEFAULT: 'hsl(var(--secondary))',
          /** 次要色上的文字/图标色 */
          foreground: 'hsl(var(--secondary-foreground))',
        },

        /** 危险/警告色（删除、错误提示等） */
        destructive: {
          /** 危险色 */
          DEFAULT: 'hsl(var(--destructive))',
          /** 危险色上的文字/图标色 */
          foreground: 'hsl(var(--destructive-foreground))',
        },

        /** 柔和色（弱化背景、占位文字等） */
        muted: {
          /** 柔和背景色 */
          DEFAULT: 'hsl(var(--muted))',
          /** 柔和色上的文字色 */
          foreground: 'hsl(var(--muted-foreground))',
        },

        /** 强调色（悬停态、选中态等） */
        accent: {
          /** 强调背景色 */
          DEFAULT: 'hsl(var(--accent))',
          /** 强调色上的文字/图标色 */
          foreground: 'hsl(var(--accent-foreground))',
        },

        /** 弹出层（Popover / Tooltip / Dropdown） */
        popover: {
          /** 弹出层背景色 */
          DEFAULT: 'hsl(var(--popover))',
          /** 弹出层内文字色 */
          foreground: 'hsl(var(--popover-foreground))',
        },

        /** 卡片容器 */
        card: {
          /** 卡片背景色 */
          DEFAULT: 'hsl(var(--card))',
          /** 卡片内文字色 */
          foreground: 'hsl(var(--card-foreground))',
        },
      },

      // -------------------------------------------------------------------
      // 圆角半径
      // 基于 CSS 变量 --radius 统一管理，方便全局调整。
      // -------------------------------------------------------------------
      borderRadius: {
        /** 大圆角，直接使用全局半径变量 */
        lg: 'var(--radius)',
        /** 中圆角，比全局半径小 2px */
        md: 'calc(var(--radius) - 2px)',
        /** 小圆角，比全局半径小 4px */
        sm: 'calc(var(--radius) - 4px)',
      },

      // -------------------------------------------------------------------
      // 字体族
      // 优先使用 Google Fonts / 系统字体，兼顾中英文显示。
      // -------------------------------------------------------------------
      fontFamily: {
        /** 无衬线字体：英文 Inter + 中文 Noto Sans SC + 系统回退 */
        sans: ['Inter', 'Noto Sans SC', 'system-ui', 'sans-serif'],
        /** 衬线字体：英文 Georgia + 中文 Noto Serif SC + 系统回退 */
        serif: ['Georgia', 'Noto Serif SC', 'serif'],
        /** 等宽字体：JetBrains Mono + Consolas + 系统回退 */
        mono: ['JetBrains Mono', 'Consolas', 'monospace'],
      },

      // -------------------------------------------------------------------
      // 动画定义
      // 通过 utility class（如 animate-fade-in）直接使用。
      // -------------------------------------------------------------------
      animation: {
        /** 淡入动画，0.2s ease-out */
        'fade-in': 'fade-in 0.2s ease-out',
        /** 从左滑入动画，0.2s ease-out */
        'slide-in': 'slide-in 0.2s ease-out',
      },

      // -------------------------------------------------------------------
      // 关键帧
      // 与上方 animation 配合使用，定义动画的实际关键帧。
      // -------------------------------------------------------------------
      keyframes: {
        /** 淡入关键帧：透明度 0 → 1 */
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        /** 从左滑入关键帧：左移 8px + 透明 → 归位 + 不透明 */
        'slide-in': {
          from: { transform: 'translateX(-8px)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
      },
    },
  },

  // =========================================================================
  // 插件
  // =========================================================================
  plugins: [
    // @tailwindcss/typography —— 为 prose 容器提供排版样式，
    // 常用于富文本编辑器预览、Markdown 渲染等场景。
    require('@tailwindcss/typography'),
  ],
}
