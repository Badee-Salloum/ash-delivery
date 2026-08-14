import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,mjs}'],
    environment: 'node',
    testTimeout: 30_000,
    // The conformance suite truncates its disposable database. Keep real-Postgres files serial so
    // this race fixture cannot be removed underneath it by another worker.
    fileParallelism: false,
  },
})
