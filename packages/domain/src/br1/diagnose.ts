import { type Minor, abs, formatMinor, isZero, minor } from '../money/minor.ts'
import { type Rounding, orderBlock, yalagoCut } from '../money/allocate.ts'
import type { Br1Result, ShiftOrder } from './equation.ts'

/**
 * Machine-readable cause codes. The UI resolves `br1.cause.<code>` to Arabic (default) or
 * English — no human-facing strings live in the domain.
 */
export type Br1CauseCode =
  | 'balanced'
  | 'pay_mode_misclassified'
  | 'missing_order'
  | 'extra_order'
  | 'unrecorded_float_tranche'
  | 'unrecorded_topup_tranche'
  | 'cash_handover_mismatch'
  | 'wallet_reading_mismatch'
  | 'unexplained'

export interface Br1Cause {
  readonly code: Br1CauseCode
  readonly confidence: 'high' | 'medium' | 'low'
  /** The magnitude this hypothesis would explain. */
  readonly amount: Minor
  /** Orders the manager should look at first. May be empty. */
  readonly candidateOrderNos: readonly string[]
  /** Pre-formatted decimal strings for interpolation into the translated message. */
  readonly detail: Readonly<Record<string, string>>
}

/** The most common fee in the shift — real shifts are near-uniform, which makes this useful. */
function modalFee(orders: readonly ShiftOrder[]): Minor | undefined {
  const counts = new Map<bigint, number>()
  for (const o of orders) counts.set(o.fee, (counts.get(o.fee) ?? 0) + 1)
  let best: bigint | undefined
  let bestCount = 0
  for (const [fee, count] of counts) {
    if (count > bestCount) {
      best = fee
      bestCount = count
    }
  }
  return best === undefined ? undefined : minor(best)
}

/**
 * Rank the plausible explanations for a non-zero BR1.
 *
 * The arithmetic signatures are genuinely distinguishable, which is what makes this more
 * than a guess. For a shift where the truth is one unrecorded event:
 *
 *   | truth                          | cashDiff | walletDiff  | scalarDiff |
 *   |--------------------------------|----------|-------------|------------|
 *   | missing CASH order (fee f)     | +f       | −cut(f)     | +block(f)  |
 *   | missing ELECTRONIC/FREE order  |  0       | +block(f)   | +block(f)  |
 *   | unrecorded float tranche (t)   | +t       |  0          | +t         |
 *   | unrecorded top-up tranche (t)  |  0       | +t          | +t         |
 *   | pay-mode flip cash→electronic  | +f       | −f          |  0         |
 *   | miscounted cash                | ±x       |  0          | ±x         |
 *
 * The only genuinely ambiguous pair is "missing electronic order" vs "unrecorded top-up" —
 * both are (0, +x, +x). We report both and let the fee coincidence break the tie.
 */
export function diagnoseBr1(result: Br1Result, orders: readonly ShiftOrder[], rounding: Rounding = 'floor'): Br1Cause[] {
  const { scalarDiff, cashDiff, walletDiff } = result

  if (isZero(scalarDiff) && isZero(cashDiff) && isZero(walletDiff)) {
    return [{ code: 'balanced', confidence: 'high', amount: minor(0n), candidateOrderNos: [], detail: {} }]
  }

  const causes: Br1Cause[] = []
  const fee = modalFee(orders)
  const usualBlock = fee === undefined ? undefined : orderBlock(fee, rounding)

  // ── Case 1: the scalar closes but the components do not. Only a pay-mode error does this.
  if (isZero(scalarDiff) && !isZero(cashDiff)) {
    // cashDiff > 0 → real cash exceeds the model → an order recorded as electronic/free was
    // actually cash. cashDiff < 0 → the reverse.
    const lookingFor = abs(cashDiff)
    const suspects = orders.filter((o) =>
      cashDiff > 0n ? o.payMode !== 'cash' && o.fee === lookingFor : o.payMode === 'cash' && o.fee === lookingFor,
    )
    causes.push({
      code: 'pay_mode_misclassified',
      confidence: suspects.length > 0 ? 'high' : 'medium',
      amount: lookingFor,
      candidateOrderNos: suspects.map((o) => o.orderNo),
      detail: {
        amount: formatMinor(lookingFor),
        direction: cashDiff > 0n ? 'recorded_electronic_actually_cash' : 'recorded_cash_actually_electronic',
        cashDiff: formatMinor(cashDiff),
        walletDiff: formatMinor(walletDiff),
      },
    })
    return causes
  }

  // ── Case 2: cash is off, wallet is clean.
  if (!isZero(cashDiff) && isZero(walletDiff)) {
    causes.push({
      code: cashDiff > 0n ? 'unrecorded_float_tranche' : 'cash_handover_mismatch',
      confidence: 'medium',
      amount: abs(cashDiff),
      candidateOrderNos: [],
      detail: { amount: formatMinor(abs(cashDiff)), cashDiff: formatMinor(cashDiff) },
    })
    causes.push({
      code: 'cash_handover_mismatch',
      confidence: 'low',
      amount: abs(cashDiff),
      candidateOrderNos: [],
      detail: { amount: formatMinor(abs(cashDiff)) },
    })
    return dedupe(causes)
  }

  // ── Case 3: wallet is off, cash is clean. Ambiguous by construction — report both.
  if (isZero(cashDiff) && !isZero(walletDiff)) {
    const magnitude = abs(walletDiff)
    const looksLikeWholeOrders =
      usualBlock !== undefined && usualBlock > 0n && magnitude % usualBlock === 0n
    if (walletDiff > 0n) {
      if (looksLikeWholeOrders && usualBlock !== undefined) {
        causes.push({
          code: 'missing_order',
          confidence: 'high',
          amount: magnitude,
          candidateOrderNos: [],
          detail: {
            amount: formatMinor(magnitude),
            orderCount: (magnitude / usualBlock).toString(),
            payMode: 'electronic_or_free',
            usualFee: fee === undefined ? '' : formatMinor(fee),
          },
        })
      }
      causes.push({
        code: 'unrecorded_topup_tranche',
        confidence: looksLikeWholeOrders ? 'low' : 'medium',
        amount: magnitude,
        candidateOrderNos: [],
        detail: { amount: formatMinor(magnitude) },
      })
    } else {
      causes.push({
        code: 'wallet_reading_mismatch',
        confidence: 'medium',
        amount: magnitude,
        candidateOrderNos: [],
        detail: { amount: formatMinor(magnitude), walletDiff: formatMinor(walletDiff) },
      })
      if (looksLikeWholeOrders && usualBlock !== undefined) {
        causes.push({
          code: 'extra_order',
          confidence: 'low',
          amount: magnitude,
          candidateOrderNos: [],
          detail: { amount: formatMinor(magnitude), orderCount: (magnitude / usualBlock).toString() },
        })
      }
    }
    return dedupe(causes)
  }

  // ── Case 4: both components off. The classic signature of a missing/extra CASH order is
  //    cashDiff = +f and walletDiff = −cut(f), i.e. opposite signs with a 4:1 magnitude ratio.
  if (!isZero(cashDiff) && !isZero(walletDiff)) {
    if (fee !== undefined && cashDiff > 0n && walletDiff < 0n) {
      const cut = yalagoCut(fee, rounding)
      if (cut > 0n && cashDiff % fee === 0n && abs(walletDiff) === (cashDiff / fee) * cut) {
        causes.push({
          code: 'missing_order',
          confidence: 'high',
          amount: abs(scalarDiff),
          candidateOrderNos: [],
          detail: {
            amount: formatMinor(abs(scalarDiff)),
            orderCount: (cashDiff / fee).toString(),
            payMode: 'cash',
            usualFee: formatMinor(fee),
          },
        })
      }
    }
    if (fee !== undefined && cashDiff < 0n && walletDiff > 0n) {
      const cut = yalagoCut(fee, rounding)
      const count = abs(cashDiff) / fee
      if (cut > 0n && abs(cashDiff) % fee === 0n && walletDiff === minor(count * cut)) {
        causes.push({
          code: 'extra_order',
          confidence: 'high',
          amount: abs(scalarDiff),
          candidateOrderNos: [],
          detail: { amount: formatMinor(abs(scalarDiff)), orderCount: count.toString(), payMode: 'cash' },
        })
      }
    }
    causes.push({
      code: 'cash_handover_mismatch',
      confidence: 'low',
      amount: abs(cashDiff),
      candidateOrderNos: [],
      detail: { amount: formatMinor(abs(cashDiff)) },
    })
    causes.push({
      code: 'wallet_reading_mismatch',
      confidence: 'low',
      amount: abs(walletDiff),
      candidateOrderNos: [],
      detail: { amount: formatMinor(abs(walletDiff)) },
    })
    return dedupe(causes)
  }

  causes.push({
    code: 'unexplained',
    confidence: 'low',
    amount: abs(scalarDiff),
    candidateOrderNos: [],
    detail: {
      scalarDiff: formatMinor(scalarDiff),
      cashDiff: formatMinor(cashDiff),
      walletDiff: formatMinor(walletDiff),
    },
  })
  return causes
}

const RANK: Record<Br1Cause['confidence'], number> = { high: 0, medium: 1, low: 2 }

function dedupe(causes: readonly Br1Cause[]): Br1Cause[] {
  const seen = new Set<string>()
  const out: Br1Cause[] = []
  for (const c of [...causes].sort((a, b) => RANK[a.confidence] - RANK[b.confidence])) {
    const key = `${c.code}:${c.amount}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}
