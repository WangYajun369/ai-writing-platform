/// Vitest 配置：jsdom 环境 + @ 别名 + 全局断言 API
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // threads 池：forks 池在部分沙箱环境下子进程 IPC 超时，threads 更稳
    pool: 'threads',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/stores/**', 'src/lib/**'],
    },
  },
})
