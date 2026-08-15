import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
const pageGrid = readFileSync(new URL('../src/screens/PageGrid.tsx', import.meta.url), 'utf8')
const cloudStatus = readFileSync(new URL('../src/screens/CloudReadStatus.tsx', import.meta.url), 'utf8')

describe('operations OCR authority guards', () => {
  it('never falls back to local monetary rows for orders or the payments log', () => {
    expect(shift).not.toContain('cloudOrders.length > 0 ? cloudOrders : localRows')
    expect(shift).not.toContain('cloudMovements.length > 0 ? cloudMovements : localRows')
    expect(shift).not.toMatch(/const scanned\s*=\s*[^\n]*localRows/u)
    expect(shift).toContain('const scanned = cloudRowsToScannedOrders(cloud.rows, localOrders, slot)')
    expect(shift).toContain('const reconciledTimes = reconcileUnverifiedOrderTimes(d.orders, scanned)')
    expect(shift).toContain('reconcileRefusedOrderFees(reconciledTimes, scanned)')
    expect(shift).toContain('const scanned = cloudRowsToScannedMovements(cloud.rows)')
    expect(shift).toContain('const nextCashDeductions = reconcileLocalCashDeductions([')
  })

  it('treats transport failure and a zero-money AI answer as explicit failures', () => {
    expect(shift.match(/if \(!cloud\?\.ok\)/gu)).toHaveLength(2)
    expect(shift).toContain(
      "row.cancelled === true || (row.fee !== null && row.fee.trim() !== '')",
    )
    expect(shift).toContain('if (scanned.length === 0)')
  })

  it('binds every result to its page generation and keeps partial-batch failures visible', () => {
    expect(pageGrid).toContain('onImage={(file) => onImage(file, slot)}')
    expect(shift).toContain('dashboardReadFiles.current.get(slot) !== file')
    expect(shift).toContain('logReadFiles.current.get(slot) !== file')
    expect(shift).toContain('state.failures > 0 || failureDetails.length > 0 ? failureNotice : null')
  })

  it('keeps the AI failure reason with each failed image generation and labels its page', () => {
    expect(shift).toContain('Map<string, FailedPageRead>')
    expect(shift.match(/reason: cloud\?\.reason \?\? 'unavailable'/gu)).toHaveLength(2)
    expect(shift.match(/reason: 'no_fields'/gu)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(shift).toContain("t.shift.imageNumber.replace('{n}', String(splitSlot(slot).n))")
    expect(shift).toContain('t.shift.readFailureTimeout')
    expect(shift).toContain('t.shift.readFailureUnavailable')
    expect(shift).toContain('t.shift.readFailureNoFields')
    expect(shift).toContain('t.shift.readFailureRefused')
  })

  it('states that the tile check is upload evidence, separate from AI reading status', () => {
    expect(shift).toContain('t.shift.uploadedEvidenceOnly')
    expect(shift).toContain('t.shift.aiReadStatus')
  })

  it('marks an explicit retry so the server does not replay a cached timeout', () => {
    expect(shift).toContain('if (!failure.canRetry) continue')
    expect(shift).toContain('canRetry: cloud.retryable')
    expect(shift).toContain('dashImage(failure.file, slot, true)')
    expect(shift).toContain('logImage(failure.file, slot, true)')
    expect(shift).toContain("readInCloud(api, shift.id, 'wallet', file, true)")
    expect(shift).toContain("readInCloud(api, shift.id, 'odometer', file, true)")
    expect(cloudStatus).toContain('onRetry && event.retryable')
  })

  it('keeps accepted rows while offering one retry for the refused rows on that page', () => {
    expect(shift).toContain('const hasVisibleRefusal = scanned.some(')
    expect(shift).toContain("reason: 'refused'")
    expect(shift).toContain('discardAiPageRefusals(withoutFailure, failure.refused)')
    expect(shift).toContain('nextCashDeductions.filter(')
    expect(shift).toContain('row.timeReviewRequired === true || row.timeText.trim() ===')
  })

  it('accepts a page made only of structured cancelled cards as a successful AI read', () => {
    expect(shift).toContain(
      "row.cancelled === true || (row.fee !== null && row.fee.trim() !== '')",
    )
  })

  it('hydrates and re-syncs deductions from the canonical server list', () => {
    expect(shift).toContain('cashDeductions: syncRecordedCashDeductions([], st.cashDeductions ?? [])')
    expect(shift).toContain('syncRecordedCashDeductions(d.cashDeductions, operations.cashDeductions)')
  })

  it('does not hydrate an unresolved legacy unknown order into the phone BR1 preview', () => {
    expect(shift).toContain('...resumedOrderWindowState(o)')
    expect(shift).not.toContain('included: o.included,')
  })

  it('labels BR1 as surplus or shortage and displays an absolute amount', () => {
    expect(shift).toContain('br1DifferencePresentation(preview.differenceText)')
    expect(shift).toContain('br1DifferencePresentation(br1.difference)')
    expect(shift).toContain('{t.br1[previewDifference.direction]}')
    expect(shift).toContain('value={previewDifference.amountText}')
    expect(shift).toContain('{t.br1[submittedDifference.direction]}')
    expect(shift).toContain('value={submittedDifference.amountText}')
  })
})
