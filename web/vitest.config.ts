import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the dev server pulls in the
// tailwind plugin, which has nothing to do with the tests and makes them slower
// to start for no benefit.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    globals: false,
  },
})
