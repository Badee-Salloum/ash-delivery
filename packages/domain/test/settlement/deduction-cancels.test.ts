import { describe, expect, it } from 'vitest'
import { minor, parseMinor } from '../../src/index.ts'

/**
 * WHY A CASH DEDUCTION CANNOT CHARGE A DRIVER AFTER THE CASH HAS BEEN COUNTED.
 *
 * This is a scar, not a feature test. On 2026-09-08 an «إضافة حسم» button shipped to production
 * that let a branch manager deduct an amount from a driver during close review — damage, a fine, an
 * item not returned. It was live for about an hour and it charged nobody anything.
 *
 * The reason is CLAUDE.md money rule 6, which is correct and must not be changed:
 *
 *     expectedTotal      = float + topup + residual − cashDeductions
 *     baseShare          = grossShare − cashDeductions
 *     variance           = actualCash + actualWallet − expectedTotal
 *     employeeSettlement = baseShare + variance
 *
 * A deduction appears exactly ONCE in the expected total and exactly ONCE in the base share. Expand
 * the settlement with a deduction D and an un-deducted expectation E₀:
 *
 *     variance           = actual − (E₀ − D)      = V₀ + D
 *     employeeSettlement = (gross − D) + (V₀ + D) = gross + V₀
 *
 * D CANCELS. It is absent from the employee's figure and absent from `cashToOffice` with it.
 *
 * That is not a bug in the equation — it is the equation being right about what a cash deduction
 * MEANS. A scanned negative dashboard row asserts that cash physically left the driver's hands
 * during the shift, so his declared cash is ALREADY lower by D. There, V₀ = −D, the deduction
 * converts an unexplained shortage into a balanced close, and the driver bears D through the
 * reduced share. The instrument names an outflow that happened.
 *
 * A charge invented AFTER the count has no such outflow behind it. Nothing offsets the deduction,
 * so the base share falls by D and the variance rises by D and — under decision 13, where a surplus
 * belongs to the employee — the money is handed straight back to him. The only lasting effect is a
 * fabricated surplus of D frozen into the immutable close snapshot, dragging a BR5 variance reason
 * with it for a discrepancy that never occurred.
 *
 * To charge a driver after the count, the amount must reduce the SHARE WITHOUT reducing the
 * expected total — a different instrument from `cash_deductions` — or be recorded as an ordinary
 * receivable (ذمة) outside the settlement entirely. Both are open decisions for the owner; neither
 * is this table.
 */

/** CLAUDE.md rule 6, transcribed. Minor units, exactly as the settlement computes them. */
function settle(input: {
  grossShare: bigint
  cashDeductions: bigint
  undeductedExpected: bigint
  actualCash: bigint
  actualWallet: bigint
}): { expectedTotal: bigint; variance: bigint; baseShare: bigint; employee: bigint; toOffice: bigint } {
  const expectedTotal = input.undeductedExpected - input.cashDeductions
  const variance = input.actualCash + input.actualWallet - expectedTotal
  const baseShare = input.grossShare - input.cashDeductions
  const employee = baseShare + variance
  return { expectedTotal, variance, baseShare, employee, toOffice: input.actualCash - employee }
}

const syp = (decimal: string): bigint => parseMinor(decimal)

describe('a deduction invented after the cash count changes nothing', () => {
  /** The exact production shape the broken button was measured on. */
  const base = {
    grossShare: syp('40.00'),
    undeductedExpected: syp('200.00'),
    actualCash: syp('200.00'),
    actualWallet: minor(0n),
  }

  it('leaves the employee and the office untouched, at every amount', () => {
    const without = settle({ ...base, cashDeductions: minor(0n) })
    expect(without.employee).toBe(syp('40.00'))
    expect(without.toOffice).toBe(syp('160.00'))
    expect(without.variance).toBe(minor(0n))

    // The measured case: the manager charges 30 for a broken phone mount.
    const with30 = settle({ ...base, cashDeductions: syp('30.00') })
    expect(with30.baseShare).toBe(syp('10.00')) // he SEES the share fall…
    expect(with30.employee).toBe(syp('40.00')) // …and the driver is paid in full anyway
    expect(with30.toOffice).toBe(syp('160.00')) // …and the office collects not one lira more
    // The only thing that actually changed, and it is a lie about the shift:
    expect(with30.variance).toBe(syp('30.00'))

    // It is not a rounding artefact or a small-number coincidence — it holds everywhere.
    for (const amount of ['0.01', '5.00', '39.99', '40.00', '250.75', '9999.99']) {
      const charged = settle({ ...base, cashDeductions: syp(amount) })
      expect(charged.employee, amount).toBe(without.employee)
      expect(charged.toOffice, amount).toBe(without.toOffice)
      expect(charged.variance, amount).toBe(syp(amount))
    }
  })

  it('does not even stop when the charge exceeds the driver’s whole share', () => {
    // A 60 charge against a 40 share drives the base share negative and STILL refunds itself.
    const over = settle({ ...base, cashDeductions: syp('60.00') })
    expect(over.baseShare).toBe(syp('-20.00'))
    expect(over.employee).toBe(syp('40.00'))
    expect(over.toOffice).toBe(syp('160.00'))
  })
})

describe('…but the same deduction is exactly right when the cash really left', () => {
  it('converts an unexplained shortage into a named, balanced close the driver bears', () => {
    /*
     * The scanned negative row: the driver spent 30 during the shift, so he hands back 170, not 200.
     * THIS is what `cash_deductions` was built for, and here every figure moves the way a manager
     * would expect.
     */
    const unexplained = settle({
      grossShare: syp('40.00'),
      cashDeductions: minor(0n),
      undeductedExpected: syp('200.00'),
      actualCash: syp('170.00'),
      actualWallet: minor(0n),
    })
    expect(unexplained.variance).toBe(syp('-30.00')) // an alarming shortage, unexplained
    expect(unexplained.employee).toBe(syp('10.00')) // the driver already bears it, blindly

    const named = settle({
      grossShare: syp('40.00'),
      cashDeductions: syp('30.00'),
      undeductedExpected: syp('200.00'),
      actualCash: syp('170.00'),
      actualWallet: minor(0n),
    })
    expect(named.variance).toBe(minor(0n)) // the shift balances…
    expect(named.baseShare).toBe(syp('10.00')) // …and the same 10 is reached with a REASON
    expect(named.employee).toBe(syp('10.00'))
    expect(named.toOffice).toBe(syp('160.00'))
    // The office is whole either way; what the deduction bought was the explanation.
    expect(named.toOffice).toBe(unexplained.toOffice)
  })

  it('is the physical outflow, not the row, that makes it work', () => {
    // Same deduction, same driver, same amount — the ONLY difference is whether the cash is gone.
    const cashGone = settle({
      grossShare: syp('40.00'), cashDeductions: syp('30.00'),
      undeductedExpected: syp('200.00'), actualCash: syp('170.00'), actualWallet: minor(0n),
    })
    const cashStillThere = settle({
      grossShare: syp('40.00'), cashDeductions: syp('30.00'),
      undeductedExpected: syp('200.00'), actualCash: syp('200.00'), actualWallet: minor(0n),
    })
    expect(cashGone.employee).toBe(syp('10.00'))
    expect(cashStillThere.employee).toBe(syp('40.00'))
    // Thirty lira of difference, decided entirely by the cash count and not at all by the deduction.
    expect(cashStillThere.employee - cashGone.employee).toBe(syp('30.00'))
  })
})
