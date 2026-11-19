import { describe, expect, it } from 'vitest'
import { createMemoryDeps } from '../src/memory/index.ts'

describe('memory close scope matches PostgreSQL', () => {
  it('accepts evidence scope without changing its callback result', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 9, 17))
    await expect(deps.closeUnitOfWork.run(
      { shiftId: 'test-shift', actorId: null, scope: 'evidence' }, async () => 'done',
    )).resolves.toBe('done')
  })
  it('refuses evidence scope combined with a financial day-level approval', async () => {
    const deps = createMemoryDeps(Date.UTC(2026, 9, 17))
    let called = false
    await expect(deps.closeUnitOfWork.run(
      { shiftId: 'test-shift', actorId: null, scope: 'evidence', serializeDriverDay: true },
      async () => { called = true },
    )).rejects.toThrow('evidence commits cannot serialize financial driver/day approvals')
    expect(called).toBe(false)
  })
})
