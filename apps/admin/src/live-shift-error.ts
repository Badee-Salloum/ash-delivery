import type { Catalog, Lang } from '@ash/client/i18n'
import { explainError } from './errors.ts'

export interface LiveShiftApiError {
  status?: number
  error?: string
  detail?: unknown
}

type LiveShiftAction = 'void' | 'forceClose' | 'suspend' | 'tranche'

const copy: Record<Lang, Record<string, string>> = {
  ar: {
    week_locked: 'لا يمكن تعديل هذه النوبة لأن أسبوعها المالي مقفل. يلزم إجراء تصحيح مالي مؤرّخ من شاشة الخزينة.',
    shift_not_found: 'لم تعد النوبة موجودة. حدّث قائمة النوبات الجارية.',
    illegal_transition: 'تغيّرت حالة النوبة ولم يعد هذا الإجراء مسموحاً. حدّث القائمة وتحقق من حالتها الحالية.',
    operation_window_unresolved:
      'لا يمكن الإغلاق القسري قبل حسم العمليات ذات التوقيت الملتبس. افتح النوبة وراجع حالة نافذة العمليات أولاً.',
    shift_open_approval_immutable:
      'رفضت قاعدة البيانات تعديل النوبة لأن بيانات اعتماد فتحها محمية. حدّث الصفحة وحاول مرة أخرى؛ وإن تكرر الخطأ بلّغ مسؤول النظام.',
    record_immutable:
      'لا يمكن تغيير هذا السجل بعد تثبيته. حدّث الصفحة وتحقق من حالة النوبة قبل إعادة المحاولة.',
    database_write_refused:
      'رفضت قاعدة البيانات تعديل سجل محمي. حدّث الصفحة وتحقق من حالة النوبة؛ وإن تكرر الخطأ بلّغ مسؤول النظام.',
    internal_error: 'فشل الإجراء بسبب خطأ في الخادم. حاول مرة أخرى؛ وإن تكرر الخطأ بلّغ مسؤول النظام باسم السائق.',
  },
  en: {
    week_locked: 'This shift belongs to a locked financial week. Post a dated correction from Treasury instead.',
    shift_not_found: 'This shift no longer exists. Refresh the live-shifts list.',
    illegal_transition: 'The shift state changed and this action is no longer allowed. Refresh the list and check its current state.',
    operation_window_unresolved:
      'Force-close is blocked until every operation with an unclear time is decided. Open the shift and review its operation window first.',
    shift_open_approval_immutable:
      'The database protected the original open approval from this update. Refresh and retry; contact the system administrator if it repeats.',
    record_immutable: 'This record cannot change after it is fixed. Refresh and check the shift state before retrying.',
    database_write_refused:
      'The database refused an update to a protected record. Refresh and check the shift state; contact the system administrator if it repeats.',
    internal_error: 'The server failed this action. Retry; if it repeats, report it with the driver name to the system administrator.',
  },
}

function errorShape(value: unknown): LiveShiftApiError {
  return typeof value === 'object' && value !== null ? (value as LiveShiftApiError) : {}
}

/**
 * Live-shift overrides move both shift state and money, so a neutral «failed» is not enough.
 * Name every refusal the override endpoints deliberately expose, and retain the raw API code for
 * an unexpected one so support can distinguish it without asking the manager to inspect devtools.
 */
export function explainLiveShiftActionError(
  value: unknown,
  action: LiveShiftAction,
  lang: Lang,
  t: Catalog,
): string {
  const apiError = errorShape(value)
  const code = apiError.error ?? 'unknown'
  const specific = copy[lang][code]
  if (specific) {
    if (code !== 'operation_window_unresolved') return specific

    const detail = errorShape(apiError.detail)
    const orders = Array.isArray((detail as { orders?: unknown }).orders) ? (detail as { orders: unknown[] }).orders.length : 0
    const deductions = Array.isArray((detail as { deductions?: unknown }).deductions)
      ? (detail as { deductions: unknown[] }).deductions.length
      : 0
    const count = orders + deductions
    return count > 0 ? `${specific} (${lang === 'ar' ? 'عدد العمليات' : 'operations'}: ${count})` : specific
  }

  const shared = explainError(code, t)
  if (shared !== t.common.actionFailed) return shared

  // The code is intentionally visible for an unexpected server refusal. This is still friendly
  // copy, but unlike the old generic line it gives the manager something concrete to report.
  const actionName =
    lang === 'ar'
      ? action === 'void'
        ? 'إلغاء النوبة'
        : action === 'forceClose'
          ? 'الإغلاق القسري'
          : action === 'suspend'
            ? 'تعليق النوبة'
            : 'إضافة العهدة/الشحن'
      : action === 'void'
        ? 'voiding the shift'
        : action === 'forceClose'
          ? 'force-closing the shift'
          : action === 'suspend'
            ? 'suspending the shift'
            : 'adding the float/top-up'
  return lang === 'ar'
    ? `تعذّر ${actionName}. رمز الخطأ: ${code}`
    : `Could not complete ${actionName}. Error code: ${code}`
}
