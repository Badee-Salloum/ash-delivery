import { readFileSync } from 'node:fs'
import { slotLabel } from '@ash/client'
import { ar, en } from '@ash/client/i18n'
import { describe, expect, it } from 'vitest'
import { describeEndSubmitFailure } from '../src/end-submit-error.ts'

const inArabic = (error: unknown) =>
  describeEndSubmitFailure(
    error,
    ar.shift.closeFailure,
    (slot) => slotLabel(slot, ar.shift.slotNames, 'ar'),
  )

const inEnglish = (error: unknown) =>
  describeEndSubmitFailure(
    error,
    en.shift.closeFailure,
    (slot) => slotLabel(slot, en.shift.slotNames, 'en'),
  )

describe('driver end-shift failure copy', () => {
  it('names every incomplete-package gap in Arabic, including its evidence and battery number', () => {
    expect(
      inArabic({
        error: 'end_package_incomplete',
        detail: [
          { kind: 'missing_photo', slot: 'bms_2' },
          { kind: 'missing_value', field: 'cashDeclared' },
          { kind: 'missing_battery_reading', slotNo: 1 },
          { kind: 'awaiting_manager_reading', slotNo: 2 },
          { kind: 'unconfirmed_orders' },
        ],
      }),
    ).toEqual({
      code: 'end_package_incomplete',
      title: 'تعذّر تسليم النوبة',
      lines: [
        'أكمل العناصر التالية ثم أعد التسليم:',
        'الصورة الناقصة: البطارية ٢',
        'القيمة الناقصة: النقد المسلَّم',
        'قراءة البطارية ١ ناقصة',
        'قراءة البطارية ٢ بانتظار مدير الفرع',
        'راجع صفوف الطلبات وأكّدها قبل التسليم',
      ],
    })
  })

  it('names the no-orders gap in English instead of showing the raw API code', () => {
    expect(
      inEnglish({ error: 'end_package_incomplete', detail: [{ kind: 'no_orders' }] }).lines,
    ).toEqual([
      'Complete these items, then submit again:',
      'No orders are recorded — add at least one order',
    ])
  })

  it('explains stale evidence, operation-window review, and an anomalous odometer', () => {
    expect(
      inArabic({
        error: 'stale_evidence_confirmation_required',
        detail: { slots: ['wallet', 'bms_2'] },
      }).lines,
    ).toEqual(['أكّد أن الصور القديمة أو المعاد استخدامها تخص هذه النوبة: المحفظة · البطارية ٢'])

    expect(
      inEnglish({
        error: 'operation_window_unresolved',
        detail: { orders: [{}, {}], deductions: [{}] },
      }).lines,
    ).toEqual(['3 operation(s) have an unresolved time — check them or ask the manager to decide'])

    expect(
      inArabic({
        error: 'odometer_anomaly_confirmation_required',
        detail: { start: 6030, end: 6029 },
      }).lines,
    ).toEqual(['قراءة الإغلاق (6029) أقل من قراءة البداية (6030) — أكّد أنها صحيحة ثم أعد التسليم'])
  })

  it('turns concurrent, state, and unknown failures into actionable persistent copy', () => {
    expect(inEnglish({ error: 'operations_changed_concurrently' }).lines[0]).toContain('try again')
    expect(inArabic({ error: 'shift_not_open' }).lines[0]).toContain('حدّث الصفحة')
    expect(inEnglish({ error: 'future_close_failure' }).lines[0]).toContain('(future_close_failure)')
    expect(inEnglish(new TypeError('offline')).lines[0]).toContain('check the connection')
  })
})

const shiftSource = readFileSync(new URL('../src/screens/Shift.tsx', import.meta.url), 'utf8')

describe('end-shift failure and optional-log source guards', () => {
  it('keeps the payment log out of the close gate and labels it archive-only', () => {
    const endStart = shiftSource.indexOf('function EndPackage(')
    const missingStart = shiftSource.indexOf('const missing: string[]', endStart)
    const missingEnd = shiftSource.indexOf('const odometerQuestion', missingStart)
    const closeGate = shiftSource.slice(missingStart, missingEnd)

    expect(closeGate).not.toContain("draft.log.kind === 'reading'")
    expect(closeGate).toContain('readingAttachment')
    expect(shiftSource).toContain("attachment.read.field !== 'payments_log'")
    expect(shiftSource).toContain('t.shift.paymentsLogArchiveHint')
    expect(ar.shift.paymentsLogArchiveHint).toBe('اختياري للأرشفة فقط — لا يغيّر قيمة الطلبات أو فرق النوبة')
    expect(en.shift.paymentsLogArchiveHint).toContain('Optional archive only')
    expect(ar.orders.movementsLegend).toBe('أرشيف اختياري فقط — لا تغيّر هذه الحركات قيمة الطلبات أو فرق النوبة.')
    expect(en.orders.movementsLegend).toContain('do not change order values or the shift difference')
  })

  it('keeps the detailed server refusal by the close button and also raises a toast', () => {
    expect(shiftSource).toContain('setCloseFailure(notice)')
    expect(shiftSource).toContain('aria-live="assertive"')
    expect(shiftSource).toContain('closeFailure.lines.map')
    expect(shiftSource).toContain('toast.error(`${notice.title}:')
  })
})
