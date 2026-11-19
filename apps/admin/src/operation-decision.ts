import { formatMinor, hasVisibleText, minor, parseMinor } from '@ash/domain'

export interface OperationDecisionRow {
  key: string
  kind: 'order' | 'cash_deduction'
  amount: string
  included: boolean
  proposedIncluded: boolean
  /** Confirming an existing amount is an audited decision even when its cash delta is zero. */
  requiresReview?: boolean | undefined
  date: string | null
  minute: string | null
  route?: string | undefined
}

/** Preview gross order fees and deductions separately, not a guessed driver settlement. */
export function operationDecisionPreview(rows: readonly OperationDecisionRow[]) {
  let orderDelta = 0n
  let deductionDelta = 0n
  for (const row of rows) {
    const amount = parseMinor(row.amount)
    if (amount < 0n) throw new Error('Decision amount must be nonnegative')
    // The API excludes unresolved reader rows from money even if a legacy included flag is true.
    const countedBefore = row.included && row.requiresReview !== true
    const change = (row.proposedIncluded ? 1n : 0n) - (countedBefore ? 1n : 0n)
    if (row.kind === 'order') orderDelta += amount * change
    else deductionDelta += amount * change
  }
  return {
    orderDelta: formatMinor(minor(orderDelta)),
    deductionDelta: formatMinor(minor(deductionDelta)),
    unknownIncluded: rows.some((row) => row.proposedIncluded && (!row.date || !row.minute)),
    changed: rows.some((row) => row.included !== row.proposedIncluded || row.requiresReview === true),
  }
}

export function decisionReasonReady(reason: string): boolean {
  return hasVisibleText(reason)
}

export function operationDecisionCopy(lang: 'ar' | 'en') {
  return lang === 'ar' ? {
    title: 'راجع أثر القرار قبل الحفظ',
    included: 'سيُحتسب', excluded: 'سيُستبعد',
    order: 'طلب', deduction: 'حسم نقدي', currency: 'ل.س',
    unknown: 'غير موثق', reason: 'سبب القرار',
    reasonRequired: 'اكتب سبباً واضحاً في حقل السبب المدقّق أعلاه.',
    orderDelta: 'التغيير في إجمالي أجور الطلبات',
    deductionDelta: 'التغيير في إجمالي الحسميات النقدية',
    unknownWarning: 'تضمين استثنائي مع وقت أو تاريخ غير موثق. لا يُنشئ هذا القرار وقتاً مقروءاً ولا يثبت أن الطلب داخل النوبة.',
    recalculation: 'هذه ليست حصة السائق النهائية. يعيد النظام حساب الحصص والمعادلة بعد الحفظ. الصفوف تبقى في سجل التدقيق.',
    apply: 'تأكيد القرار وحفظه', cancel: 'إلغاء',
    draftWarning: 'احفظ تعديل الوقت أو ألغِه قبل اتخاذ قرار الاحتساب أو التكرار.',
  } : {
    title: 'Review the effect before saving',
    included: 'Will be counted', excluded: 'Will be excluded',
    order: 'Order', deduction: 'Cash deduction', currency: 'SYP',
    unknown: 'Not documented', reason: 'Decision reason',
    reasonRequired: 'Enter a clear reason in the audited reason field above.',
    orderDelta: 'Change in gross order fees',
    deductionDelta: 'Change in cash deductions',
    unknownWarning: 'Exceptional inclusion with an undocumented time or date. This decision does not create a read clock or prove the order is inside the shift.',
    recalculation: 'This is not the final driver share. Shares and balance are recalculated after saving. Rows remain in the audit record.',
    apply: 'Confirm and save decision', cancel: 'Cancel',
    draftWarning: 'Save or discard the time edit before deciding inclusion or duplication.',
  }
}
