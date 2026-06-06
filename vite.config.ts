import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
// @ts-ignore
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri expects a fixed port during development
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    hmr: process.env.TAURI_DEV_HOST
      ? {
          protocol: 'ws',
          host: process.env.TAURI_DEV_HOST,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  // Env variables starting with the item of `envPrefix` will be exposed
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri supports modern browsers
    target: 'esnext',
    // Don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // Produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Code splitting: separate vendor chunks for better caching
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        manualChunks(id) {
          // TipTap editor core (large, changes infrequently)
          if (id.includes('@tiptap')) return 'tiptap'
          // UI icons (large icon set)
          if (id.includes('lucide-react')) return 'icons'
          // State management
          if (id.includes('zustand') || id.includes('jotai')) return 'state'
          // Router
          if (id.includes('react-router')) return 'router'
          // Markdown / HTML processing
          if (id.includes('markdown-it') || id.includes('highlight.js')) return 'markdown'
          // Utilities
          if (id.includes('lodash-es') || id.includes('date-fns') || id.includes('uuid')) return 'utils'
          // Virtualization
          if (id.includes('@tanstack/react-virtual')) return 'virtual'
        },
      },
    },
  },
}))
