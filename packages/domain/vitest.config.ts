import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Property tests get a fixed seed on PRs and a randomised seed nightly.
    // See TESTS.md — every shrunk counterexample is frozen as a named regression test.
    environment: 'node',
  },
})
