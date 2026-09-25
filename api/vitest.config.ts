import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // the fake database is a module-level singleton, so files must not share a
    // process and race each other through it
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
})
