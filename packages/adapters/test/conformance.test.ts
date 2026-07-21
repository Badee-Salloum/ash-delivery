import { runConformanceSuite } from '@ash/testkit/conformance'
import { createMemoryDeps } from '../src/memory/index.ts'

// The same suite the PostgreSQL adapters must pass. If these two ever disagree, one is wrong.
runConformanceSuite({
  label: 'in-memory',
  makeDeps: () => createMemoryDeps(Date.UTC(2026, 6, 21, 5, 0, 0)),
})
