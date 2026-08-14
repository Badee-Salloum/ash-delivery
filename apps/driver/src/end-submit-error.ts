/** A stable, user-facing description of a failed end-shift submission. */
export interface EndSubmitFailureNotice {
  code: string
  title: string
  lines: string[]
}

/** Localized leaves used by the pure formatter. */
export interface EndSubmitFailureCopy {
  title: string
  incomplete: string
  missingPhoto: string
  missingValue: string
  missingBatteryReading: string
  awaitingManagerReading: string
  noOrders: string
  unconfirmedOrders: string
  valueOdometer: string
  valueCash: string
  valueWallet: string
  valuePackage: string
  staleEvidence: string
  operationWindow: string
  odometerAnomaly: string
  operationsChanged: string
  shiftChanged: string
  shiftMissing: string
  otherShiftOrder: string
  invalidRequest: string
  unknown: string
}

type UnknownRecord = Record<string, unknown>

const recordOf = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null

const stringOf = (value: unknown): string | null => typeof value === 'string' ? value : null
const numberOf = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : null

const fill = (template: string, values: Record<string, string>): string => {
  let out = template
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, value)
  return out
}

function valueLabel(field: string, copy: EndSubmitFailureCopy): string {
  if (field === 'odometerKm') return copy.valueOdometer
  if (field === 'cashDeclared') return copy.valueCash
  if (field === 'walletDeclared') return copy.valueWallet
  if (field === 'endPackage') return copy.valuePackage
  return field
}

function gapLines(
  detail: unknown,
  copy: EndSubmitFailureCopy,
  evidenceLabel: (slot: string) => string,
): string[] {
  if (!Array.isArray(detail)) return [copy.incomplete]

  const lines = detail.flatMap((raw): string[] => {
    const gap = recordOf(raw)
    const kind = stringOf(gap?.kind)
    if (kind === 'missing_photo') {
      const slot = stringOf(gap?.slot)
      return slot === null ? [] : [fill(copy.missingPhoto, { item: evidenceLabel(slot) })]
    }
    if (kind === 'missing_value') {
      const field = stringOf(gap?.field)
      return field === null ? [] : [fill(copy.missingValue, { item: valueLabel(field, copy) })]
    }
    if (kind === 'missing_battery_reading') {
      const slotNo = numberOf(gap?.slotNo)
      return slotNo === null ? [] : [fill(copy.missingBatteryReading, { item: evidenceLabel(`bms_${slotNo}`) })]
    }
    if (kind === 'awaiting_manager_reading') {
      const slotNo = numberOf(gap?.slotNo)
      return slotNo === null ? [] : [fill(copy.awaitingManagerReading, { item: evidenceLabel(`bms_${slotNo}`) })]
    }
    if (kind === 'no_orders') return [copy.noOrders]
    if (kind === 'unconfirmed_orders') return [copy.unconfirmedOrders]
    return []
  })

  return [copy.incomplete, ...new Set(lines)]
}

function slotsIn(detail: unknown): string[] {
  const value = recordOf(detail)?.slots
  return Array.isArray(value) ? value.filter((slot): slot is string => typeof slot === 'string') : []
}

function unresolvedCount(detail: unknown): number {
  const value = recordOf(detail)
  if (value === null) return 0
  const orders = Array.isArray(value.orders) ? value.orders.length : 0
  const deductions = Array.isArray(value.deductions) ? value.deductions.length : 0
  return orders + deductions
}

/**
 * Turn every close-path API refusal into something the driver can act on.
 *
 * The API's `detail` is deliberately treated as untrusted input: a rolling deployment can pair a
 * newer server with an older PWA, and an incomplete or unfamiliar detail must still produce one
 * visible, localized line rather than crashing the close screen.
 */
export function describeEndSubmitFailure(
  error: unknown,
  copy: EndSubmitFailureCopy,
  evidenceLabel: (slot: string) => string,
): EndSubmitFailureNotice {
  const apiError = recordOf(error)
  const code = stringOf(apiError?.error) ?? 'unknown'
  const detail = apiError?.detail
  let lines: string[]

  if (code === 'end_package_incomplete') {
    lines = gapLines(detail, copy, evidenceLabel)
  } else if (code === 'stale_evidence_confirmation_required') {
    const slots = slotsIn(detail).map(evidenceLabel)
    lines = [fill(copy.staleEvidence, { items: slots.length > 0 ? slots.join(' · ') : '—' })]
  } else if (code === 'operation_window_unresolved') {
    lines = [fill(copy.operationWindow, { n: String(unresolvedCount(detail)) })]
  } else if (code === 'odometer_anomaly_confirmation_required') {
    const anomaly = recordOf(detail)
    lines = [
      fill(copy.odometerAnomaly, {
        start: numberOf(anomaly?.start) ?? '—',
        end: numberOf(anomaly?.end) ?? '—',
      }),
    ]
  } else if (code === 'operations_changed_concurrently') {
    lines = [copy.operationsChanged]
  } else if (code === 'shift_not_open' || code === 'illegal_transition') {
    lines = [copy.shiftChanged]
  } else if (code === 'shift_not_found') {
    lines = [copy.shiftMissing]
  } else if (code === 'order_belongs_to_other_shift') {
    lines = [copy.otherShiftOrder]
  } else if (code === 'invalid_request' || code === 'operations_batch_shift_mismatch') {
    lines = [copy.invalidRequest]
  } else {
    lines = [fill(copy.unknown, { code })]
  }

  return { code, title: copy.title, lines }
}
