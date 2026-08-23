import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLinkedReadTask } from '../src/linked-read-task.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the driver-side linked-read lifetime', () => {
  it('returns a normal response without aborting it', async () => {
    vi.useFakeTimers()
    const task = createLinkedReadTask(async (signal) => {
      expect(signal.aborted).toBe(false)
      return { read: 'done' }
    }, 35_000)

    await expect(task.result).resolves.toEqual({ kind: 'complete', value: { read: 'done' } })
    expect(task.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a transport that never settles and returns a terminal timeout', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const task = createLinkedReadTask(() => pending.promise, 35_000)

    await vi.advanceTimersByTimeAsync(34_999)
    expect(task.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(task.result).resolves.toEqual({ kind: 'timeout' })
    expect(task.signal.aborted).toBe(true)
    expect(task.signal.reason).toBe('timeout')
  })

  it('lets the driver leave the reader immediately and ignores its late response', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    let restored = false
    const task = createLinkedReadTask((signal) => {
      signal.addEventListener('abort', () => {
        restored = true
      })
      return pending.promise
    })

    // Let `run` install the abort listener before the driver presses the fallback action.
    await Promise.resolve()
    expect(task.cancel()).toBe(true)
    expect(restored).toBe(true)
    await expect(task.result).resolves.toEqual({ kind: 'cancelled' })

    pending.resolve('late answer from the replaced request')
    await Promise.resolve()
    await expect(task.result).resolves.toEqual({ kind: 'cancelled' })
    expect(task.cancel()).toBe(false)
  })

  it('normalises a synchronous start failure into a terminal result', async () => {
    vi.useFakeTimers()
    const error = new Error('could not start fetch')
    const task = createLinkedReadTask(() => {
      throw error
    })

    await expect(task.result).resolves.toEqual({ kind: 'failed', error })
    expect(task.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
