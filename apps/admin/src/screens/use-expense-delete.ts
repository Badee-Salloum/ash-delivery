import { useRef } from 'react'
import { useApp } from '../app-context.tsx'
import { useConfirm } from '../feedback.tsx'
import { uncertainMoneyMoveOutcome } from '../money-move-idempotency.ts'
import { expenseDeleteRequest, type ExpenseDeleteTarget } from '../company-expense-list.ts'
import type { Mutate } from './CompanyFund.tsx'

/** One confirmation. Keep the exact request after an uncertain response, even across tab changes. */
export function useExpenseDelete(mutate: Mutate): (target: ExpenseDeleteTarget) => Promise<void> {
  const { api, session, branchId, t } = useApp(), confirm = useConfirm()
  const pending = useRef(new Map<string, ReturnType<typeof expenseDeleteRequest>>())
  const running = useRef(false)
  const scope = `${session?.userId ?? ''}:${branchId ?? ''}`
  const liveScope = useRef(scope); liveScope.current = scope
  return async target => {
    if (running.current) return
    running.current = true
    try {
      const accepted = await confirm({ title: t.financeReview.deleteExpenseTitle,
        body: `${target.description}\n${t.financeReview.deleteExpenseHint}\n${t.financeReview.paymentLinksChangeHint}`, confirmLabel: t.financeReview.deleteExpense, danger: true })
      if (!accepted || liveScope.current !== scope) return
      const identity = `${scope}:${target.kind}:${target.kind === 'command' ? target.id : target.reference}`
      await mutate(async () => {
        let request = pending.current.get(identity)
        if (!request) {
          let version: number | undefined
          if (target.kind === 'source') {
            const review = await api.get<{ effective: { movementType: string; excluded: boolean }; version: number;
              capabilities: { financialCorrectionSupported: boolean } }>(`/company/historical-imports/${encodeURIComponent(target.reference)}/review`)
            if (review.effective.excluded) return
            if (review.effective.movementType !== 'expense' || !review.capabilities.financialCorrectionSupported)
              throw { error: 'historical_source_financial_correction_required', status: 422 }
            version = review.version
          }
          if (liveScope.current !== scope) throw { error: 'forbidden', status: 403 }
          request = expenseDeleteRequest(target, crypto.randomUUID(), version)
          pending.current.set(identity, request)
        }
        return api.post(request.path, request.body)
      }, t.financeReview.expenseDeleted, outcome => {
        if (outcome.ok || !uncertainMoneyMoveOutcome(outcome)) pending.current.delete(identity)
      })
    } finally { running.current = false }
  }
}
