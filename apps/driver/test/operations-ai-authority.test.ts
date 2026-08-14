import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shift = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')
const pageGrid = readFileSync(new URL('../src/screens/PageGrid.tsx', import.meta.url), 'utf8')

describe('operations OCR authority guards', () => {
  it('never falls back to local monetary rows for orders or the payments log', () => {
    expect(shift).not.toContain('cloudOrders.length > 0 ? cloudOrders : localRows')
    expect(shift).not.toContain('cloudMovements.length > 0 ? cloudMovements : localRows')
    expect(shift).not.toMatch(/const scanned\s*=\s*[^\n]*localRows/u)
    expect(shift).toContain('const scanned = cloudRowsToScannedOrders(cloud.rows, localOrders)')
    expect(shift).toContain('const scanned = cloudRowsToScannedMovements(cloud.rows)')
    expect(shift).toContain('const nextCashDeductions = reconcileLocalCashDeductions([')
  })

  it('treats transport failure and a zero-money AI answer as explicit failures', () => {
    expect(shift.match(/if \(!cloud\?\.ok\)/gu)).toHaveLength(2)
    expect(shift).toContain("if (!scanned.some((row) => row.fee !== null && row.fee.trim() !== ''))")
    expect(shift).toContain('if (scanned.length === 0)')
  })

  it('binds every result to its page generation and keeps partial-batch failures visible', () => {
    expect(pageGrid).toContain('onImage={(file) => onImage(file, slot)}')
    expect(shift).toContain('dashboardReadFiles.current.get(slot) !== file')
    expect(shift).toContain('logReadFiles.current.get(slot) !== file')
    expect(shift).toContain('state.failures > 0 ? failureNotice : null')
  })

  it('hydrates and re-syncs deductions from the canonical server list', () => {
    expect(shift).toContain('cashDeductions: syncRecordedCashDeductions([], st.cashDeductions ?? [])')
    expect(shift).toContain('syncRecordedCashDeductions(d.cashDeductions, operations.cashDeductions)')
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
