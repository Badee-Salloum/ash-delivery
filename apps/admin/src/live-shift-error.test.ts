import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { explainLiveShiftActionError } from './live-shift-error.ts'

describe('live-shift action errors', () => {
  it('names a protected open-approval refusal instead of showing the generic failure', () => {
    const message = explainLiveShiftActionError(
      { status: 409, error: 'shift_open_approval_immutable' },
      'void',
      'ar',
      ar,
    )
    expect(message).toContain('بيانات اعتماد فتحها محمية')
    expect(message).not.toBe(ar.common.actionFailed)
  })

  it('tells the manager how many ambiguous operation rows block force-close', () => {
    const message = explainLiveShiftActionError(
      { error: 'operation_window_unresolved', detail: { orders: [{}, {}], deductions: [{}] } },
      'forceClose',
      'ar',
      ar,
    )
    expect(message).toContain('عدد العمليات: 3')
    expect(message).toContain('افتح النوبة')
  })

  it('turns the API internal_error into an explicit server failure for the attempted void', () => {
    const message = explainLiveShiftActionError({ status: 500, error: 'internal_error' }, 'void', 'ar', ar)
    expect(message).toContain('خطأ في الخادم')
    expect(message).not.toBe(ar.common.actionFailed)
  })

  it('preserves an unexpected API code in both languages for a support report', () => {
    expect(explainLiveShiftActionError({ error: 'new_server_refusal' }, 'void', 'ar', ar)).toContain(
      'new_server_refusal',
    )
    expect(explainLiveShiftActionError({ error: 'new_server_refusal' }, 'forceClose', 'en', en)).toContain(
      'new_server_refusal',
    )
  })

  it('tells a stale admin to refresh instead of retrying an unsafe tranche request', () => {
    const message = explainLiveShiftActionError(
      { status: 428, error: 'admin_update_required' },
      'tranche',
      'en',
      en,
    )
    expect(message).toContain('outdated')
    expect(message).toContain('refresh')
  })

  it('warns that a conflicting event key must not be resent', () => {
    const message = explainLiveShiftActionError(
      { status: 409, error: 'idempotency_key_conflict' },
      'tranche',
      'ar',
      ar,
    )
    expect(message).toContain('مفتاح')
    expect(message).toContain('نوع العهدة أو المبلغ')
    expect(message).toContain('لا تعِد الإرسال')
  })
})
