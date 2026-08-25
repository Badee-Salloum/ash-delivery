import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const batteryPanel = readFileSync(new URL('../src/screens/BatteryPanel.tsx', import.meta.url), 'utf8')
const readingLock = readFileSync(new URL('../src/screens/ReadingLock.tsx', import.meta.url), 'utf8')
const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

describe('end-BMS slow-reader escape wiring', () => {
  it('bounds the whole linked read and forwards cancellation through both network writes', () => {
    expect(batteryPanel).toContain('createLinkedReadTask<LinkedBmsReadOutcome>(async (signal) =>')
    expect(batteryPanel).toContain('onLinkedRead(slot, retryFailed, upload, signal)')
    expect(batteryPanel).toContain('push(battery.id, applied.state, signal)')
    expect(shift).toContain('api.readCloseDraftAttachment(shift.id, slot, {')
    expect(shift).toContain("}, effectiveSignal ? { signal: effectiveSignal } : {})")
  })

  it('gives only the end-package battery reader a manual escape without deleting its photo', () => {
    expect(batteryPanel).toContain("pkg === 'end' && cloudEvent?.status === 'reading'")
    expect(batteryPanel).toContain('onContinueManually: () => cancelLinkedRead(battery.id)')
    expect(readingLock).toContain('data-reading-lock-action')
    expect(readingLock).toContain('onClick={onContinueManually}')

    // Cancelling owns the reader lifecycle only. The accepted attachment remains the evidence the
    // manager can inspect; replacement/deletion continues through PhotoSlot's explicit controls.
    const cancelStart = batteryPanel.indexOf('const cancelLinkedRead = useCallback')
    const cancelEnd = batteryPanel.indexOf('/**', cancelStart + 1)
    const cancellation = batteryPanel.slice(cancelStart, cancelEnd)
    expect(cancellation).toContain('linkedReadTasks.current[batteryId]?.cancel()')
    expect(cancellation).not.toMatch(/delete|onSlotUploaded|onMediaIdChanged/u)
  })

  it('restores only the pending marker owned by the cancelled request', () => {
    expect(shift).toContain('const pendingReadId = `pending-${attachment.attachmentToken}-${clientUuid()}`')
    expect(shift).toContain('ownsPendingCloseDraftRead(')
    expect(shift).toContain('attachment.attachmentToken,')
    expect(shift).toContain('pendingReadId,')
    expect(shift).toContain('[slot]: attachment')
    expect(shift).toContain("effectiveSignal?.addEventListener('abort', onAbort, { once: true })")
    expect(shift).toContain("effectiveSignal?.removeEventListener('abort', onAbort)")

    // The task identity is a second fence: even the same pack/slot cannot let an older late answer
    // clear or replace the visible outcome of a newer retry.
    expect(batteryPanel).toContain('if (linkedReadTasks.current[battery.id] !== task) return')
  })

  /**
   * The BMS read was the ONLY one with a browser-side lifetime. Orders, payments-log, wallet and
   * odometer ran bare, so a fetch whose connection never settled left the `running` marker in place
   * forever — and a running read is a hard close blocker whose retry button is hidden. Unrecoverable
   * without closing the app, at the end of a shift, at the branch.
   */
  it('bounds a read even when the caller brings no lifetime of its own', () => {
    expect(shift).toContain('const ownDeadline = signal ? null : new AbortController()')
    expect(shift).toContain("ownDeadline.abort('timeout')")
    expect(shift).toContain('LINKED_READ_UI_TIMEOUT_MS')
    expect(shift).toContain('const effectiveSignal = signal ?? ownDeadline?.signal')
    // The caller's own signal still wins when there is one — cancellation must not be weakened.
    expect(shift).toContain('if (deadlineTimer !== null) clearTimeout(deadlineTimer)')
  })
})
