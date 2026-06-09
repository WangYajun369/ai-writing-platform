/**
 * @file Vite 构建配置
 * @description TimeWrite 项目的 Vite 构建工具配置，包含 Tauri 桌面应用的
 * 开发服务器、路径别名、环境变量前缀、构建目标及代码分割策略。
 * @see https://vitejs.dev/config/
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(() => ({
  /** 插件列表：React JSX + Tailwind CSS v4 */
  plugins: [react(), tailwindcss()],

  /** 模块解析配置 */
  resolve: {
    /** 路径别名映射，将 `@` 映射到 `src` 目录以便简化导入路径 */
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  /**
   * 开发服务器配置
   * Tauri 在开发阶段需要固定端口以与前端建立通信
   */
  server: {
    /** 开发服务器监听端口 */
    port: 1420,
    /** 端口被占用时直接报错，而非自动尝试下一个端口 */
    strictPort: true,
    /** 监听的主机地址，支持通过环境变量 `TAURI_DEV_HOST` 指定外部设备访问 */
    host: process.env.TAURI_DEV_HOST || false,
    /**
     * 热模块替换（HMR）配置
     * 仅当设置了 TAURI_DEV_HOST 时才启用 WebSocket，用于远程设备的热更新
     */
    hmr: process.env.TAURI_DEV_HOST
      ? {
          /** WebSocket 通信协议 */
          protocol: 'ws',
          /** WebSocket 监听地址 */
          host: process.env.TAURI_DEV_HOST,
          /** WebSocket 监听端口 */
          port: 1421,
        }
      : undefined,
    /** 文件监听配置 */
    watch: {
      /** 忽略 `src-tauri` 目录的文件变更监听，避免触发不必要的重新构建 */
      ignored: ['**/src-tauri/**'],
    },
  },

  /**
   * 环境变量前缀
   * 以指定前缀开头的环境变量会被暴露到客户端代码中
   */
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  /** 生产构建配置 */
  build: {
    /** 构建目标：使用最新的 ES 标准，Tauri 运行于现代浏览器环境 */
    target: 'esnext',
    /**
     * 代码压缩策略
     * 调试模式（TAURI_ENV_DEBUG）下禁用压缩以保留可读性，否则使用 esbuild 压缩
     */
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    /**
     * Source Map 生成
     * 仅在调试模式下生成 Source Map 以辅助定位问题
     */
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    /** Rollup 打包选项，用于精细控制输出格式与代码分割 */
    rollupOptions: {
      output: {
        /** JS 代码块文件命名模板，包含名称哈希以支持长期缓存 */
        chunkFileNames: 'assets/[name]-[hash].js',
        /** 静态资源文件命名模板，包含名称哈希以支持长期缓存 */
        assetFileNames: 'assets/[name]-[hash].[ext]',
        /**
         * 手动代码分割函数
         * 将大型第三方依赖拆分为独立的 chunk，优化缓存命中率与首屏加载速度
         * @param id - 模块的绝对路径标识
         * @returns 分割后的 chunk 名称，未匹配时返回 undefined（交由 Vite 自动处理）
         */
        manualChunks(id) {
          // TipTap 富文本编辑器核心库（体积较大，变更频率低）
          if (id.includes('@tiptap')) return 'tiptap'
          // Lucide 图标库（图标集合较大）
          if (id.includes('lucide-react')) return 'icons'
          // 状态管理库（Zustand / Jotai）
          if (id.includes('zustand') || id.includes('jotai')) return 'state'
          // React Router 路由库
          if (id.includes('react-router')) return 'router'
          // Markdown 渲染（react-markdown + remark-gfm）
          if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown'
          // 工具函数库（date-fns / uuid）
          if (id.includes('date-fns') || id.includes('uuid')) return 'utils'
          // 虚拟滚动库（TanStack Virtual）
          if (id.includes('@tanstack/react-virtual')) return 'virtual'
        },
      },
    },
  },
}))
