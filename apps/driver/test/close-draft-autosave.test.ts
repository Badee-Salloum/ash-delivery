import { describe, expect, it, vi } from 'vitest'
import { runCloseDraftSaveWithRetry } from '../src/close-draft-autosave.ts'

describe('close-draft autosave durability', () => {
  it('retries a transient failure with bounded backoff and eventually returns the canonical save', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ revision: 8 })
    const waits: number[] = []
    const failures: number[] = []

    await expect(
      runCloseDraftSaveWithRetry({
        save,
        conflictValue: () => null,
        isCurrent: () => true,
        delaysMs: [10, 20, 40, 80],
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
        onTransientFailure: (_error, attempt) => failures.push(attempt),
      }),
    ).resolves.toEqual({ kind: 'saved', value: { revision: 8 }, attempts: 3 })
    expect(save).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([10, 20, 40])
    expect(failures).toEqual([1, 2])
  })

  it('stops immediately on a revision conflict so the caller can rebase before retrying', async () => {
    const canonical = { revision: 9 }
    const conflict = { error: 'close_draft_revision_conflict', current: canonical }
    const save = vi.fn().mockRejectedValue(conflict)

    await expect(
      runCloseDraftSaveWithRetry({
        save,
        conflictValue: (error) => error === conflict ? canonical : null,
        isCurrent: () => true,
        delaysMs: [0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'conflict', value: canonical, attempts: 1 })
    expect(save).toHaveBeenCalledOnce()
  })

  it('cancels a stale fingerprint during backoff and never sends its payload', async () => {
    const save = vi.fn()
    let current = true

    await expect(
      runCloseDraftSaveWithRetry({
        save,
        conflictValue: () => null,
        isCurrent: () => current,
        delaysMs: [10, 20],
        wait: async () => {
          current = false
        },
      }),
    ).resolves.toEqual({ kind: 'cancelled', attempts: 0 })
    expect(save).not.toHaveBeenCalled()
  })

  it('stops after the bounded retry budget when the network stays unavailable', async () => {
    const offline = new Error('offline')
    const save = vi.fn().mockRejectedValue(offline)

    await expect(
      runCloseDraftSaveWithRetry({
        save,
        conflictValue: () => null,
        isCurrent: () => true,
        delaysMs: [0, 0, 0],
        wait: async () => undefined,
      }),
    ).resolves.toEqual({ kind: 'failed', error: offline, attempts: 3 })
    expect(save).toHaveBeenCalledTimes(3)
  })
})
