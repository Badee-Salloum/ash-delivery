import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  groupThousands,
  type ReceivableChannel,
  type ReceivableEventView,
  type ReceivableKind,
  type ReceivablesView,
  type RestorationView,
} from '@ash/client'
import { type RoleKey, can, formatMinor, minor, parseMinor } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { useConfirm, useToast } from '../feedback.tsx'
import { explainError } from '../errors.ts'
import { Button, Card, Field, Money, MoneyInput, Pending, Select, Table, TextInput } from '../ui.tsx'
import { differenceView, summarizeRestoration } from '../treasury-view.ts'
import {
  browserReceivableOperationMutex,
  browserReceivableOperationStorage,
  executeReceivableOperation,
  loadPendingReceivableOperation,
  pendingReceivableOperationMatches,
  receivableDirectoryDrivers,
  receivableDriverMaySubmit,
  receivableOperationReady,
  receivableWriteoffAmountWithinBalance,
  type PendingReceivableOperation,
  type PendingReceivableRecovery,
  type ReceivableOperationPayload,
} from '../receivable-idempotency.ts'

/** The branch-level funds a manual entry can move (the driver/cost-centre ones need an id suffix). */
const MANUAL_FUNDS = ['office_cash', 'office_wallet', 'yalago_share', 'company_revenue', 'yalago_income', 'fee_earned', 'company_box'] as const
interface EntryLine {
  fundCode: string
  side: 'D' | 'C'
  amount: string
}

interface TreasuryDriver {
  id: string
  code: string
  fullNameAr: string
  fullNameEn: string | null
  active: boolean
}

/**
 * Branch treasury management and the Sunday close. The close itself is system-admin-only and its
 * pre-flight blockers are shown before sealing.
 */
export function Treasury(): ReactNode {
  const { api, t, session, branchId } = useApp()
  const toast = useToast()
  const confirm = useConfirm()
  const [closeResult, setCloseResult] = useState<{ error?: string; blockers?: Array<{ kind: string }>; weekStart?: string } | null>(null)
  const [balances, setBalances] = useState<{ cash: string; wallet: string } | null>(null)
  const [depositAmt, setDepositAmt] = useState<{ cash: string; wallet: string }>({ cash: '', wallet: '' })
  const [depositMsg, setDepositMsg] = useState<string | null>(null)
  const [withdrawAmt, setWithdrawAmt] = useState<{ cash: string; wallet: string }>({ cash: '', wallet: '' })
  const [advances, setAdvances] = useState<Awaited<ReturnType<typeof api.advances>> | null>(null)
  const [advancesError, setAdvancesError] = useState<string | null>(null)
  const [advanceRepayAmt, setAdvanceRepayAmt] = useState<Record<string, string>>({})
  const [convertParty, setConvertParty] = useState<Record<string, string>>({})
  const [advanceReason, setAdvanceReason] = useState<Record<string, string>>({})
  const [advanceBusy, setAdvanceBusy] = useState<string | null>(null)
  const [moveDirection, setMoveDirection] = useState<'cash_to_wallet' | 'wallet_to_cash'>('cash_to_wallet')
  const [moveAmt, setMoveAmt] = useState('')
  const [moveReason, setMoveReason] = useState('')

  // ── «صندوق الشركة» ────────────────────────────────────────────────────────────────────────
  const [company, setCompany] = useState<{ total: string; branches: Array<{ branchId: string; nameAr: string; balance: string }> } | null>(null)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [companyAmt, setCompanyAmt] = useState('')
  const [companyReason, setCompanyReason] = useState('')

  // ── «الترميم» ─────────────────────────────────────────────────────────────────────────────
  const [restoration, setRestoration] = useState<RestorationView | null>(null)
  const [restorationError, setRestorationError] = useState<string | null>(null)
  const [capitalTargetsDraft, setCapitalTargetsDraft] = useState({ cash: '', wallet: '' })
  const [capitalTargetReason, setCapitalTargetReason] = useState('')
  const [capitalTargetsBusy, setCapitalTargetsBusy] = useState(false)

  // Outstanding driver balances are branch-scoped office assets, not physical cash in the box.
  const [receivables, setReceivables] = useState<ReceivablesView | null>(null)
  const [receivablesError, setReceivablesError] = useState<string | null>(null)
  const [receivablesBranchId, setReceivablesBranchId] = useState<string | null>(null)
  const [receivableDrivers, setReceivableDrivers] = useState<TreasuryDriver[]>([])
  const [receivableDraft, setReceivableDraft] = useState<ReceivableOperationPayload>({
    driverId: '',
    receivableKind: 'ordinary',
    channel: 'cash',
    direction: 'create',
    amount: '',
    reason: '',
  })
  /*
   * «تعديل الذمم المسجلة» — a restatement, kept beside the command form but deliberately separate.
   *
   * It shares nothing with the command draft on purpose: a command says "move this much", a
   * correction says "the balance should read this". Folding one into the other would produce a form
   * whose «المبلغ» means two different things depending on a dropdown, which is how an operator
   * ends up moving 4,000 when he meant to set the balance TO 4,000.
   */
  const [correctionDriverId, setCorrectionDriverId] = useState('')
  const [correctionKind, setCorrectionKind] = useState<ReceivableKind>('ordinary')
  const [correctionChannel, setCorrectionChannel] = useState<ReceivableChannel>('cash')
  const [correctionTarget, setCorrectionTarget] = useState('')
  const [correctionReason, setCorrectionReason] = useState('')
  const correctionFormRef = useRef<HTMLDivElement | null>(null)
  const [correctionBusy, setCorrectionBusy] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const [receivableEventBusy, setReceivableEventBusy] = useState(false)
  const [receivableEventError, setReceivableEventError] = useState<string | null>(null)
  const [receivableHistory, setReceivableHistory] = useState<ReceivableEventView[] | null>(null)
  const [receivableHistoryError, setReceivableHistoryError] = useState<string | null>(null)
  const [receivableHistoryBranchId, setReceivableHistoryBranchId] = useState<string | null>(null)
  const [receivableOutboxRecovery, setReceivableOutboxRecovery] = useState<PendingReceivableRecovery>({
    status: 'unavailable',
  })

  const [balanceError, setBalanceError] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const restorationLoadVersion = useRef(0)
  const receivablesLoadVersion = useRef(0)
  const receivableHistoryLoadVersion = useRef(0)
  const receivableSubmitVersion = useRef(0)
  const pendingReceivableEvent = useRef<PendingReceivableOperation | null>(null)

  // ── Manual entry + reversal (E-3) ────────────────────────────────────────────────────────
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<EntryLine[]>([
    { fundCode: 'office_cash', side: 'D', amount: '' },
    { fundCode: 'office_wallet', side: 'C', amount: '' },
  ])
  const [manualMsg, setManualMsg] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [revId, setRevId] = useState('')
  const [revReason, setRevReason] = useState('')
  const [revMsg, setRevMsg] = useState<string | null>(null)

  /*
   * ASK THE RULE, do not restate it. This was two hard-coded role names and a comment explaining
   * that the system admin may look but not touch — which owner decision 9 reversed on 2026-08-12,
   * leaving the screen confidently wrong and telling him so in Arabic.
   *
   * `can()` is pure and already exported, so the screen now reads the same table the server checks.
   * (UI hiding is not security — the API enforces this regardless. This only decides whether a
   * control is worth showing.)
   */
  const canDeposit =
    session != null &&
    can({ userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }, 'journal.manual.write', {
      branchId: branchId ?? session.branchId,
    }).allowed

  const canViewCompanyFund =
    session != null &&
    can({ userId: session.userId, roleKey: session.roleKey as RoleKey, branchId: session.branchId }, 'profit.view_total', {}).allowed

  const receivableOutboxActorId = session?.userId ?? null
  const receivableOutboxBranchId = branchId ?? session?.branchId ?? null

  const load = useCallback(() => {
    const version = ++loadVersion.current
    setBalanceError(null)
    setBalances(null)
    void api
      .treasuryBalances()
      .then((next) => {
        if (version === loadVersion.current) setBalances(next)
      })
      .catch((e: { error?: string }) => {
        if (version !== loadVersion.current) return
        setBalances(null)
        setBalanceError(e.error ?? 'error')
      })
  }, [api, branchId])

  const loadRestoration = useCallback(async (): Promise<void> => {
    const version = ++restorationLoadVersion.current
    setRestoration(null)
    try {
      const preview = await api.restorationPreview()
      if (version !== restorationLoadVersion.current) return
      setRestoration(preview)
      setCapitalTargetsDraft({
        cash: preview.legs.find((leg) => leg.fundCode === 'office_cash')?.capitalTarget ?? '',
        wallet: preview.legs.find((leg) => leg.fundCode === 'office_wallet')?.capitalTarget ?? '',
      })
      setRestorationError(null)
    } catch (err) {
      if (version !== restorationLoadVersion.current) return
      setRestoration(null)
      setRestorationError((err as { error?: string }).error ?? 'error')
    }
  }, [api, branchId])

  const loadReceivables = useCallback(async (): Promise<void> => {
    const version = ++receivablesLoadVersion.current
    const requestedBranch = branchId
    setReceivables(null)
    setReceivablesError(null)
    setReceivablesBranchId(requestedBranch)
    try {
      const [next, directory] = await Promise.all([
        api.receivables(),
        api.get<{ drivers: TreasuryDriver[] }>('/drivers'),
      ])
      if (version !== receivablesLoadVersion.current) return
      setReceivables(next)
      const outstandingDriverIds = new Set(next.drivers.map((driver) => driver.driverId))
      // A lost-response create may already have been consumed or collected, leaving no current
      // balance. Keep its driver selectable so the immutable receipt can still be recovered.
      const pendingDriverId = pendingReceivableEvent.current?.payload.driverId
      if (pendingDriverId) outstandingDriverIds.add(pendingDriverId)
      const availableDrivers = receivableDirectoryDrivers(directory.drivers, outstandingDriverIds)
      setReceivableDrivers(availableDrivers)
      setReceivableDraft((current) => {
        const selected = availableDrivers.find((driver) => driver.id === current.driverId)
        const exactRetry = pendingReceivableOperationMatches(pendingReceivableEvent.current, current)
        return {
          ...current,
          driverId: receivableDriverMaySubmit(selected, current.direction) || exactRetry ? current.driverId : '',
        }
      })
    } catch (err) {
      if (version !== receivablesLoadVersion.current) return
      setReceivables(null)
      setReceivablesError((err as { error?: string }).error ?? 'error')
    }
  }, [api, branchId])

  const loadReceivableHistory = useCallback(async (): Promise<void> => {
    const version = ++receivableHistoryLoadVersion.current
    const requestedBranch = branchId
    setReceivableHistory(null)
    setReceivableHistoryError(null)
    setReceivableHistoryBranchId(requestedBranch)
    try {
      const next = await api.receivableEvents()
      if (version !== receivableHistoryLoadVersion.current) return
      setReceivableHistory(next.events)
    } catch (err) {
      if (version !== receivableHistoryLoadVersion.current) return
      setReceivableHistory(null)
      setReceivableHistoryError((err as { error?: string }).error ?? 'error')
    }
  }, [api, branchId])

  // Refetch when an organisation-wide role switches branch — the treasury is per branch, and
  // showing branch A's cash box under branch B's name is the worst kind of wrong.
  useEffect(load, [load, branchId])
  useEffect(() => {
    void loadRestoration()
  }, [loadRestoration])
  useEffect(() => {
    void loadReceivables()
  }, [loadReceivables])
  useEffect(() => {
    receivableSubmitVersion.current += 1
    const recovery: PendingReceivableRecovery = receivableOutboxActorId && receivableOutboxBranchId
      ? loadPendingReceivableOperation(
          browserReceivableOperationStorage(),
          receivableOutboxActorId,
          receivableOutboxBranchId,
        )
      : { status: 'unavailable' }
    const restored = recovery.status === 'pending' ? recovery.operation : null
    pendingReceivableEvent.current = restored
    setReceivableOutboxRecovery(recovery)
    setReceivableEventBusy(false)
    setReceivableDrivers([])
    setReceivableDraft((current) => restored?.payload ?? { ...current, driverId: '' })
    setReceivableEventError(
      recovery.status === 'pending'
        ? 'receivable_pending_retry'
        : recovery.status === 'corrupt'
          ? 'receivable_outbox_corrupt'
          : recovery.status === 'unavailable'
            ? 'receivable_outbox_unavailable'
            : null,
    )
  }, [receivableOutboxActorId, receivableOutboxBranchId])
  useEffect(() => {
    void loadReceivableHistory()
  }, [loadReceivableHistory])

  /** «كييش» — take the day's profit out of the branch box and into صندوق الشركة. */
  async function withdraw(target: 'cash' | 'wallet'): Promise<void> {
    const amount = withdrawAmt[target]
    if (!amount) return
    setDepositMsg(null)
    try {
      const res = await api.treasuryWithdraw(target, amount, t.treasury.kaish)
      setBalances((b) => (b ? { ...b, [target]: res.balance } : b))
      setWithdrawAmt({ ...withdrawAmt, [target]: '' })
      setDepositMsg(t.treasury.withdrawn)
      void refreshCompany()
    } catch (err) {
      setDepositMsg(null)
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  const loadAdvances = useCallback(async (): Promise<void> => {
    try {
      setAdvances(await api.advances())
      setAdvancesError(null)
    } catch (err) {
      setAdvances(null)
      setAdvancesError((err as { error?: string }).error ?? 'error')
    }
  }, [api])

  useEffect(() => {
    void loadAdvances()
  }, [loadAdvances])

  /**
   * «تسجيل إعادة» — money coming back on one advance.
   *
   * Targets the ADVANCE, never the party: the party is free text, and two spellings of one name
   * must never be able to merge or split what is owed.
   */
  async function repayAdvance(advanceId: string): Promise<void> {
    const amount = advanceRepayAmt[advanceId]
    const reason = (advanceReason[advanceId] ?? '').trim()
    if (!amount || !reason) return
    setAdvanceBusy(advanceId)
    try {
      await api.repayAdvance(advanceId, { idempotencyKey: crypto.randomUUID(), amount, reason })
      setAdvanceRepayAmt({ ...advanceRepayAmt, [advanceId]: '' })
      setAdvanceReason({ ...advanceReason, [advanceId]: '' })
      toast.success(t.treasury.advanceRepaidOk)
      await Promise.all([loadAdvances(), load()])
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    } finally {
      setAdvanceBusy(null)
    }
  }

  /** «تحويل إلى صرفية» — the only act in this instrument's life that reduces office capital. */
  async function convertAdvance(advanceId: string): Promise<void> {
    const reason = (advanceReason[advanceId] ?? '').trim()
    if (!reason) return
    if (
      !(await confirm({
        title: t.treasury.advanceConvert,
        body: t.treasury.advanceConvertConfirm,
        confirmLabel: t.treasury.advanceConvert,
        danger: true,
      }))
    ) {
      return
    }
    setAdvanceBusy(advanceId)
    try {
      await api.convertAdvance(advanceId, { idempotencyKey: crypto.randomUUID(), reason })
      setAdvanceReason({ ...advanceReason, [advanceId]: '' })
      toast.success(t.treasury.advanceConvertedOk)
      await Promise.all([loadAdvances(), load()])
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    } finally {
      setAdvanceBusy(null)
    }
  }

  /**
   * «تحويل الذمة إلى سلفة» — the same debt, filed differently (owner request, 2026-09-01).
   *
   * NO MONEY MOVES. One counted asset falls and another rises; no box is touched and office capital
   * is unchanged. It goes through its own route rather than composing collect-then-pay, because
   * that would write a collection into the driver's history for money that never came back.
   */
  async function convertReceivableToAdvance(
    driverId: string,
    driverName: string,
    channel: 'cash' | 'wallet',
    amount: string,
  ): Promise<void> {
    // Whose debt it REALLY is. A ذمة can only name a registered driver, so a debt somebody else
    // owes has always had to sit under whichever driver's row the manager picked; this is the
    // first point at which it can be filed under the right name.
    const partyName = (convertParty[driverId] ?? '').trim() || driverName
    const categories = await api.expenseCategories().catch(() => null)
    const categoryId = categories?.categories[0]?.id
    if (!categoryId) {
      toast.error(explainError('unknown_expense_category', t))
      return
    }
    const confirmed = await confirm({
      title: t.treasury.advanceFromReceivable,
      body: t.treasury.advanceFromReceivableConfirm
        .replace('{driver}', partyName === driverName ? driverName : `${driverName} → ${partyName}`)
        .replace('{amount}', groupThousands(amount)),
      confirmLabel: t.treasury.advanceFromReceivable,
    })
    if (!confirmed) return
    try {
      await api.createAdvance({
        idempotencyKey: crypto.randomUUID(),
        partyName,
        categoryId,
        costCenterKind: 'general',
        vehicleId: null,
        sourceDriverId: driverId,
        // Inherited from the debt, never chosen: a debt owed in cash stays owed in cash.
        channel: channel === 'cash' ? 'office_cash' : 'office_wallet',
        amount,
        description: `${t.treasury.advanceFromReceivable} — ${driverName}`,
      })
      setConvertParty({ ...convertParty, [driverId]: '' })
      toast.success(t.treasury.advanceFromReceivableOk)
      await Promise.all([loadAdvances(), loadReceivables(), load()])
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  const refreshCompany = useCallback(async (): Promise<void> => {
    if (!canViewCompanyFund) {
      setCompany(null)
      setCompanyError(null)
      return
    }
    try {
      setCompany(await api.companyFund())
      setCompanyError(null)
    } catch (err) {
      // `profit.view_total` — the GM and, since decision 9, the system admin. A branch manager
      // gets 403 here, and saying so beats an empty card he reads as broken.
      setCompany(null)
      setCompanyError((err as { error?: string }).error ?? 'error')
    }
  }, [api, canViewCompanyFund])

  // صندوق الشركة is company-wide, so it does NOT depend on the selected branch. Declared after
  // `refreshCompany` because a `const` callback is not hoisted — the effect would read it before
  // assignment.
  useEffect(() => {
    void refreshCompany()
  }, [refreshCompany])

  async function moveCompany(direction: 'deposit' | 'withdraw'): Promise<void> {
    if (!companyAmt || !companyReason.trim()) return
    try {
      if (direction === 'deposit') await api.companyFundDeposit(companyAmt, companyReason.trim())
      else await api.companyFundWithdraw(companyAmt, companyReason.trim())
      setCompanyAmt('')
      setCompanyReason('')
      await refreshCompany()
      void load()
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function deposit(target: 'cash' | 'wallet'): Promise<void> {
    const amount = depositAmt[target]
    if (!amount) return
    setDepositMsg(null)
    try {
      const res = await api.treasuryDeposit(target, amount)
      setBalances((b) => (b ? { ...b, [target]: res.balance } : b))
      setDepositAmt({ ...depositAmt, [target]: '' })
      setDepositMsg(t.treasury.deposited)
    } catch (err) {
      // It used to set the SAME state as success, which renders in emerald — so a rejected
      // deposit printed «forbidden» in green under the cash box and the manager believed the
      // money had gone in.
      setDepositMsg(null)
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  /**
   * «نقل بين الصندوق والمحفظة» — reshape the branch's own money, both directions.
   *
   * Not «كييش»: nothing leaves for صندوق الشركة, so the treasury total, the capital target and
   * الترميم all see exactly what they saw a second ago. Only the two boxes change.
   */
  async function moveBetweenBoxes(): Promise<void> {
    if (!moveAmt || !moveReason.trim()) return
    setDepositMsg(null)
    try {
      const res = await api.treasuryTransfer(moveDirection, moveAmt, moveReason.trim())
      setBalances((b) => (b ? { ...b, cash: res.cash, wallet: res.wallet } : b))
      setMoveAmt('')
      setMoveReason('')
      setDepositMsg(t.treasury.moved)
    } catch (err) {
      setDepositMsg(null)
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  /** Sum one side of the entry in minor units (string math, never Number() on money). */
  const sideTotal = (side: 'D' | 'C'): string => {
    let acc = 0n
    for (const l of lines) {
      if (l.side !== side || l.amount.trim() === '') continue
      try {
        acc += parseMinor(l.amount)
      } catch {
        /* a half-typed amount — skip it in the running total */
      }
    }
    return formatMinor(minor(acc))
  }
  const entryBalanced = sideTotal('D') === sideTotal('C') && lines.some((l) => l.amount.trim() !== '') && reason.trim() !== ''
  const setLine = (i: number, patch: Partial<EntryLine>): void => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLine = (): void => setLines((prev) => [...prev, { fundCode: 'office_cash', side: 'D', amount: '' }])
  const removeLine = (i: number): void => setLines((prev) => prev.filter((_, j) => j !== i))

  async function postManual(): Promise<void> {
    setManualMsg(null)
    setManualError(null)
    try {
      await api.manualEntry({ reason, lines: lines.filter((l) => l.amount.trim() !== '') })
      setManualMsg(t.treasury.posted)
      setReason('')
      setLines([
        { fundCode: 'office_cash', side: 'D', amount: '' },
        { fundCode: 'office_wallet', side: 'C', amount: '' },
      ])
      load()
    } catch (err) {
      setManualError((err as { error?: string }).error ?? 'error')
    }
  }
  async function doReverse(): Promise<void> {
    setRevMsg(null)
    try {
      await api.reverseEntry(Number(revId), revReason)
      setRevMsg(t.treasury.reversed)
      setRevId('')
      setRevReason('')
      load()
    } catch (err) {
      setRevMsg(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function submitReceivableEvent(): Promise<void> {
    const payload: ReceivableOperationPayload = {
      ...receivableDraft,
      amount: receivableDraft.amount.trim(),
      reason: receivableDraft.reason.trim(),
    }
    const outboxActorId = receivableOutboxActorId
    const outboxBranchId = receivableOutboxBranchId
    const storage = browserReceivableOperationStorage()
    if (!outboxActorId || !outboxBranchId) {
      setReceivableOutboxRecovery({ status: 'unavailable' })
      setReceivableEventError('receivable_outbox_unavailable')
      return
    }

    // Re-read immediately before every attempt. localStorage is shared by tabs, so a command
    // created elsewhere must win over this page's older in-memory view and may never be overwritten.
    const durable = loadPendingReceivableOperation(storage, outboxActorId, outboxBranchId)
    if (durable.status === 'unavailable' || durable.status === 'corrupt') {
      setReceivableOutboxRecovery(durable)
      setReceivableEventError(
        durable.status === 'corrupt' ? 'receivable_outbox_corrupt' : 'receivable_outbox_unavailable',
      )
      return
    }
    if (durable.status === 'pending') {
      pendingReceivableEvent.current = durable.operation
      setReceivableOutboxRecovery(durable)
      if (!pendingReceivableOperationMatches(durable.operation, payload)) {
        setReceivableDraft(durable.operation.payload)
        setReceivableEventError('receivable_pending_retry')
        void loadReceivables()
        return
      }
    } else if (
      pendingReceivableEvent.current &&
      !pendingReceivableOperationMatches(pendingReceivableEvent.current, payload)
    ) {
      // A pending command is immutable even if another browser context removed its durable row.
      setReceivableDraft(pendingReceivableEvent.current.payload)
      setReceivableOutboxRecovery({ status: 'pending', operation: pendingReceivableEvent.current })
      setReceivableEventError('receivable_pending_retry')
      return
    }

    if (!receivableOperationReady(payload)) return
    const driver = receivableDrivers.find((candidate) => candidate.id === payload.driverId)
    if (!driver) return
    const exactPendingRetry = pendingReceivableOperationMatches(pendingReceivableEvent.current, payload)
    if (!receivableDriverMaySubmit(driver, payload.direction) && !exactPendingRetry) return

    const actionLabel = t.treasury.receivableDirections[payload.direction]
    const confirmedAgainstVersion = receivableSubmitVersion.current
    const confirmed = await confirm({
      title: t.treasury.receivableEventConfirmTitle,
      body: `${actionLabel} — ${driver.fullNameAr} (${driver.code}) — ${t.treasury.receivableKinds[payload.receivableKind]} — ${t.treasury.receivableChannels[payload.channel]} — ${groupThousands(payload.amount)} — ${payload.reason}${payload.direction === 'writeoff' ? ` — ${t.treasury.receivableWriteoffHint}` : ''}`,
      confirmLabel: actionLabel,
      danger: payload.direction === 'writeoff',
    })
    // A branch/session switch while the modal was open invalidates its captured actor + branch.
    if (!confirmed || confirmedAgainstVersion !== receivableSubmitVersion.current) return

    const mutex = browserReceivableOperationMutex()
    if (!mutex) {
      setReceivableOutboxRecovery({ status: 'unavailable' })
      setReceivableEventError('receivable_outbox_unavailable')
      return
    }

    let submitVersion: number | null = null
    setReceivableEventBusy(true)
    setReceivableEventError(null)
    const outcome = await executeReceivableOperation({
      storage,
      mutex,
      actorId: outboxActorId,
      branchId: outboxBranchId,
      payload,
      current: pendingReceivableEvent.current,
      execute: async (operation) => {
        // The final context check is inside the cross-tab lock and immediately before the POST.
        if (confirmedAgainstVersion !== receivableSubmitVersion.current) {
          throw { status: 400, error: 'receivable_context_changed' }
        }
        pendingReceivableEvent.current = operation
        setReceivableOutboxRecovery({ status: 'pending', operation })
        setReceivableDraft(operation.payload)
        submitVersion = ++receivableSubmitVersion.current
        if (operation.payload.direction === 'writeoff') {
          return api.writeoffReceivable({
            driverId: operation.payload.driverId,
            channel: operation.payload.channel,
            amount: operation.payload.amount,
            reason: operation.payload.reason,
            idempotencyKey: operation.idempotencyKey,
          })
        }
        return api.createReceivableEvent({
          ...operation.payload,
          direction: operation.payload.direction === 'create' ? 'create' : 'collect',
          idempotencyKey: operation.idempotencyKey,
        })
      },
    })

    const activeVersion = submitVersion ?? confirmedAgainstVersion
    if (activeVersion !== receivableSubmitVersion.current) return
    setReceivableEventBusy(false)

    if (outcome.status === 'success' || outcome.status === 'success_clear_failed') {
      if (outcome.status === 'success') {
        if (pendingReceivableEvent.current?.idempotencyKey === outcome.operation.idempotencyKey) {
          pendingReceivableEvent.current = null
        }
        setReceivableOutboxRecovery({ status: 'none' })
        setReceivableDraft((current) => ({ ...current, amount: '', reason: '' }))
      } else {
        // The server result is definitive, but a failed verified clear remains locked for a safe
        // exact replay after reload rather than risking a second independently keyed operation.
        pendingReceivableEvent.current = outcome.operation
        setReceivableOutboxRecovery({ status: 'pending', operation: outcome.operation })
        setReceivableEventError('receivable_outbox_unavailable')
      }
      toast.success(t.treasury.receivableEventSaved)
      await Promise.all([loadReceivables(), loadReceivableHistory()])
      return
    }

    if (outcome.status === 'definitive_rejection') {
      if (pendingReceivableEvent.current?.idempotencyKey === outcome.operation.idempotencyKey) {
        pendingReceivableEvent.current = null
      }
      setReceivableOutboxRecovery({ status: 'none' })
      setReceivableEventError((outcome.error as { error?: string }).error ?? 'error')
      return
    }

    if (outcome.status === 'ambiguous_failure' || outcome.status === 'definitive_rejection_clear_failed') {
      pendingReceivableEvent.current = outcome.operation
      setReceivableOutboxRecovery({ status: 'pending', operation: outcome.operation })
      setReceivableDraft(outcome.operation.payload)
      setReceivableEventError(
        outcome.status === 'ambiguous_failure' ? 'receivable_pending_retry' : 'receivable_outbox_unavailable',
      )
      return
    }

    if (outcome.status === 'pending_conflict') {
      pendingReceivableEvent.current = outcome.operation
      setReceivableOutboxRecovery({ status: 'pending', operation: outcome.operation })
      setReceivableDraft(outcome.operation.payload)
      setReceivableEventError('receivable_pending_retry')
      void loadReceivables()
      return
    }

    if (outcome.status === 'busy') {
      if (outcome.recovery.status === 'pending') {
        pendingReceivableEvent.current = outcome.recovery.operation
        setReceivableDraft(outcome.recovery.operation.payload)
      }
      setReceivableOutboxRecovery(outcome.recovery)
      setReceivableEventError('receivable_outbox_busy')
      return
    }

    setReceivableOutboxRecovery(outcome)
    setReceivableEventError(outcome.status === 'corrupt' ? 'receivable_outbox_corrupt' : 'receivable_outbox_unavailable')
  }

  async function saveCapitalTargets(): Promise<void> {
    const cashTarget = capitalTargetsDraft.cash.trim()
    const walletTarget = capitalTargetsDraft.wallet.trim()
    const reason = capitalTargetReason.trim()
    try {
      if (cashTarget === '' || walletTarget === '' || parseMinor(cashTarget) < 0n || parseMinor(walletTarget) < 0n) {
        toast.error(t.errors.capital_target_negative)
        return
      }
    } catch {
      toast.error(t.errors.invalid_request)
      return
    }
    if (reason === '') {
      toast.error(t.errors.reason_required)
      return
    }

    const ok = await confirm({
      title: t.treasury.confirmCapitalTargets,
      body: `${t.treasury.cashCapitalTarget}: ${groupThousands(cashTarget)} • ${t.treasury.walletCapitalTarget}: ${groupThousands(walletTarget)} • ${reason}`,
      confirmLabel: t.treasury.saveCapitalTargets,
    })
    if (!ok) return

    setCapitalTargetsBusy(true)
    try {
      await api.updateCapitalTargets(cashTarget, walletTarget, reason)
      setCapitalTargetReason('')
      toast.success(t.treasury.capitalTargetsSaved)
      await loadRestoration()
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    } finally {
      setCapitalTargetsBusy(false)
    }
  }

  async function doRestore(): Promise<void> {
    if (!restoration || restoration.source !== 'live_ledger') return
    const legText = restoration.legs.map((leg) => {
      const fund = leg.fundCode === 'office_cash' ? t.treasury.cashBox : t.treasury.wallet
      const action =
        leg.direction === 'to_company'
          ? t.treasury.transferToCompany
          : leg.direction === 'from_company'
            ? t.treasury.transferFromCompany
            : t.treasury.noMovement
      return `${fund}: ${action}${leg.direction ? ` ${groupThousands(leg.amount)}` : ''}`
    })
    const net = differenceView(restoration.netToCompany)
    const netAction =
      net.direction === 'increase'
        ? t.treasury.transferToCompany
        : net.direction === 'shortage'
          ? t.treasury.transferFromCompany
          : t.treasury.noMovement
    const ok = await confirm({
      title: t.treasury.restoration,
      body: `${legText.join(' • ')} • ${t.treasury.netMovement}: ${netAction}${net.direction === 'none' ? '' : ` ${groupThousands(net.amount)}`}`,
      confirmLabel: t.treasury.doRestore,
    })
    if (!ok) return
    try {
      await api.restore(t.treasury.restoration)
      // POST returns the plan that was executed, whose positions are necessarily pre-action. The
      // preview endpoint returns the live post-action position plus `alreadyRestored`; reload it
      // before painting success so the card cannot present the old position as the live balance.
      await loadRestoration()
      void refreshCompany()
      load()
    } catch (err) {
      toast.error(explainError((err as { error?: string }).error ?? 'error', t))
    }
  }

  async function closeWeek(): Promise<void> {
    // The API expects the FOLLOWING Sunday; the server validates it, so send today's next Sunday.
    const closeDate = nextSunday(session?.businessDate ?? new Date().toISOString().slice(0, 10))
    // BR7 seals the week: every entry inside it becomes immutable and corrections after this are
    // dated correction entries only. It was a bare red button with no question asked.
    const ok = await confirm({
      title: t.week.confirmCloseTitle,
      body: `${t.week.closeSunday} ${closeDate} — ${t.week.confirmCloseBody}`,
      confirmLabel: t.week.closeSunday,
      danger: true,
    })
    if (!ok) return
    try {
      const res = await api.closeWeek(closeDate)
      setCloseResult(res)
    } catch (err) {
      setCloseResult(err as { error?: string; blockers?: Array<{ kind: string }> })
    }
  }

  const restorationSummary = restoration ? summarizeRestoration(restoration.legs) : null
  const restorationNet = restoration ? differenceView(restoration.netToCompany) : null
  const capitalTargetsReady = (() => {
    try {
      return capitalTargetsDraft.cash.trim() !== '' &&
        capitalTargetsDraft.wallet.trim() !== '' &&
        capitalTargetReason.trim() !== '' &&
        parseMinor(capitalTargetsDraft.cash) >= 0n &&
        parseMinor(capitalTargetsDraft.wallet) >= 0n
    } catch {
      return false
    }
  })()
  // A branch switch invalidates the painted data immediately, before the effect starts its fetch.
  const selectedReceivables = receivablesBranchId === branchId ? receivables : null
  const selectedReceivablesError = receivablesBranchId === branchId ? receivablesError : null
  /**
   * The balance the correction is about, straight off the loaded view.
   *
   * Shown read-only rather than typed. The whole point of `expectedCurrentBalance` is that it is
   * what the operator was LOOKING AT — letting him type it would turn an optimistic-concurrency
   * check into a second chance to get a number wrong.
   */
  const correctionRow = (receivablesBranchId === branchId ? receivables : null)?.drivers.find(
    (d) => d.driverId === correctionDriverId,
  )
  const correctionCurrent = correctionRow
    ? correctionKind === 'ordinary'
      ? correctionChannel === 'cash'
        ? correctionRow.ordinaryCash
        : correctionRow.ordinaryWallet
      : correctionChannel === 'cash'
        ? correctionRow.shiftFundingCash
        : correctionRow.shiftFundingWallet
    : null

  /**
   * Point the correction form at one specific balance.
   *
   * A driver row carries FOUR balances — ordinary and shift-funding, each in cash and wallet — so a
   * button that only knew the driver would leave the operator to re-pick the pair he had just
   * clicked on, which is how the wrong one gets corrected. Each button therefore carries its own
   * kind and channel.
   *
   * `clear` is the same act with the target already at zero. Nothing is deleted, because nothing in
   * this ledger can be: the balance is restated to zero and both the original and the restatement
   * stay in the history. The reason is still required — it is the only record of WHY the debt
   * should not have been there, and the server refuses without it.
   */
  const aimCorrection = (
    driverId: string,
    kind: ReceivableKind,
    channel: ReceivableChannel,
    clear: boolean,
  ): void => {
    setCorrectionDriverId(driverId)
    setCorrectionKind(kind)
    setCorrectionChannel(channel)
    setCorrectionTarget(clear ? '0.00' : '')
    setCorrectionReason('')
    setCorrectionError(null)
    correctionFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const submitCorrection = async (): Promise<void> => {
    if (!correctionRow || correctionCurrent === null) return
    setCorrectionError(null)
    const confirmed = await confirm({
      title: t.treasury.correctionConfirmTitle,
      body: `${correctionRow.nameAr} (${correctionRow.code}) — ${t.treasury.receivableKinds[correctionKind]} — ${t.treasury.receivableChannels[correctionChannel]} — ${groupThousands(correctionCurrent)} → ${groupThousands(correctionTarget)} — ${correctionReason}`,
    })
    if (!confirmed) return
    setCorrectionBusy(true)
    try {
      await api.correctReceivable({
        driverId: correctionDriverId,
        receivableKind: correctionKind,
        channel: correctionChannel,
        expectedCurrentBalance: correctionCurrent,
        targetBalance: correctionTarget,
        reason: correctionReason.trim(),
        // A fresh key per attempt: the server treats a repeat of the SAME key as a replay, which is
        // what protects a lost response from restating the balance twice.
        idempotencyKey: crypto.randomUUID(),
      })
      setCorrectionTarget('')
      setCorrectionReason('')
      await Promise.all([loadReceivables(), loadReceivableHistory()])
      toast.success(t.treasury.correctionSaved)
    } catch (error) {
      setCorrectionError((error as { error?: string }).error ?? 'error')
    } finally {
      setCorrectionBusy(false)
    }
  }

  const selectedReceivableHistory = receivableHistoryBranchId === branchId ? receivableHistory : null
  const selectedReceivableHistoryError = receivableHistoryBranchId === branchId ? receivableHistoryError : null
  const selectedReceivableRow = selectedReceivables?.drivers.find(
    (driver) => driver.driverId === receivableDraft.driverId,
  )
  const selectedReceivableDriver = receivableDrivers.find(
    (driver) => driver.id === receivableDraft.driverId,
  )
  const selectedReceivableBalance = selectedReceivableRow
    ? receivableDraft.direction === 'writeoff' || receivableDraft.receivableKind === 'ordinary'
      ? receivableDraft.channel === 'cash'
        ? selectedReceivableRow.ordinaryCash
        : selectedReceivableRow.ordinaryWallet
      : receivableDraft.channel === 'cash'
        ? selectedReceivableRow.shiftFundingCash
        : selectedReceivableRow.shiftFundingWallet
    : '0.00'
  const normalizedReceivableDraft: ReceivableOperationPayload = {
    ...receivableDraft,
    amount: receivableDraft.amount.trim(),
    reason: receivableDraft.reason.trim(),
  }
  const exactPendingReceivableRetry = pendingReceivableOperationMatches(
    pendingReceivableEvent.current,
    normalizedReceivableDraft,
  )
  const receivableOutboxBlocked =
    receivableOutboxRecovery.status === 'unavailable' || receivableOutboxRecovery.status === 'corrupt'
  const receivableFingerprintLocked =
    receivableEventBusy || receivableOutboxBlocked || receivableOutboxRecovery.status === 'pending'
  const writeoffAmountWithinBalance = receivableWriteoffAmountWithinBalance(
    normalizedReceivableDraft,
    selectedReceivableBalance,
    exactPendingReceivableRetry,
  )
  const receivableEventReady = !receivableOutboxBlocked && (
    receivableDriverMaySubmit(selectedReceivableDriver, receivableDraft.direction) ||
    exactPendingReceivableRetry
  ) && receivableOperationReady(normalizedReceivableDraft) && writeoffAmountWithinBalance

  const directionLabel = (direction: 'increase' | 'shortage' | 'none', capital = false): string => {
    if (direction === 'increase') return capital ? t.treasury.capitalSurplus : t.treasury.increase
    if (direction === 'shortage') return capital ? t.treasury.capitalShortage : t.treasury.shortage
    return capital ? t.treasury.onTarget : t.treasury.noDifference
  }

  const transferLabel = (direction: 'to_company' | 'from_company' | null): string => {
    if (direction === 'to_company') return t.treasury.transferToCompany
    if (direction === 'from_company') return t.treasury.transferFromCompany
    return t.treasury.noMovement
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={t.treasury.branchTreasury} className="lg:col-span-2">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(['cash', 'wallet'] as const).map((target) => (
            <div key={target} className="rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold text-slate-500">
                {target === 'cash' ? t.treasury.expectedCashBox : t.treasury.expectedWallet}
              </div>
              <div className="mt-1 text-2xl font-bold">
                {balances ? (
                  <Money value={balances[target]} />
                ) : (
                  <span className="text-base font-medium text-red-600">
                    {balanceError ? explainError(balanceError, t) : '—'}
                  </span>
                )}
              </div>
              {canDeposit ? (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <MoneyInput
                      value={depositAmt[target]}
                      onChange={(e) => setDepositAmt({ ...depositAmt, [target]: e.target.value })}
                      className="min-w-0 flex-1"
                      placeholder={t.treasury.depositAmount}
                    />
                    <Button onClick={() => deposit(target)} disabled={!depositAmt[target]}>
                      {t.treasury.ownerFunding}
                    </Button>
                  </div>
                  {/* «كييش» by hand. The owner's book moves money out of the box every day; until
                      now the screen could only put money in. الترميم automates the decision later
                      and posts through the very same recipe, so the two are one thing in the ledger. */}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <MoneyInput
                      value={withdrawAmt[target]}
                      onChange={(e) => setWithdrawAmt({ ...withdrawAmt, [target]: e.target.value })}
                      className="min-w-0 flex-1"
                      placeholder={t.treasury.kaish}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => withdraw(target)}
                      disabled={!withdrawAmt[target]}
                    >
                      {t.treasury.transferToCompanyKaish}
                    </Button>
                  </div>
                </div>
              ) : (
                // Saying why beats an empty card somebody reads as a broken screen.
                <p className="mt-3 text-xs text-slate-600">{t.treasury.depositRoleHint}</p>
              )}
            </div>
          ))}
        </div>
        {canDeposit ? (
          <div className="mt-4 rounded-lg border border-slate-200 p-3">
            <div className="text-xs font-semibold text-slate-500">{t.treasury.moveBetweenBoxes}</div>
            <p className="mt-1 text-xs text-slate-600">{t.treasury.moveBetweenBoxesHint}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <Select
                value={moveDirection}
                onChange={(e) => setMoveDirection(e.target.value as 'cash_to_wallet' | 'wallet_to_cash')}
                className="min-w-0 flex-1"
              >
                <option value="cash_to_wallet">{t.treasury.cashToWallet}</option>
                <option value="wallet_to_cash">{t.treasury.walletToCash}</option>
              </Select>
              <MoneyInput
                value={moveAmt}
                onChange={(e) => setMoveAmt(e.target.value)}
                className="min-w-0 flex-1"
                placeholder={t.treasury.depositAmount}
              />
              <TextInput
                value={moveReason}
                onChange={(e) => setMoveReason(e.target.value)}
                className="min-w-0 flex-1"
                placeholder={t.treasury.moveBetweenBoxesReason}
              />
              <Button variant="ghost" onClick={() => void moveBetweenBoxes()} disabled={!moveAmt || !moveReason.trim()}>
                {t.treasury.moveBetweenBoxes}
              </Button>
            </div>
          </div>
        ) : null}
        {depositMsg ? <p className="mt-3 text-sm font-medium text-emerald-700">{depositMsg}</p> : null}

        {/* «صندوق الشركة» — where «كييش» lands and where «شحن من الصندوق» comes from. Sits inside
            the treasury card because the two are one flow: money leaves the box and arrives here. */}
        {canViewCompanyFund ? <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-slate-500">{t.treasury.companyFund}</span>
            <span className="text-2xl font-bold">
              {company ? (
                <Money value={company.total} />
              ) : (
                <span className="text-base font-medium text-red-600">
                  {companyError ? explainError(companyError, t) : '—'}
                </span>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{t.treasury.companyFundHint}</p>
          {company && company.branches.length > 1 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              {company.branches.map((b) => (
                <li key={b.branchId}>
                  {b.nameAr} <Money value={b.balance} />
                </li>
              ))}
            </ul>
          ) : null}
          {company ? (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex gap-2">
                <MoneyInput
                  value={companyAmt}
                  onChange={(e) => setCompanyAmt(e.target.value)}
                  className="w-full"
                  placeholder={t.treasury.depositAmount}
                />
                <TextInput
                  value={companyReason}
                  onChange={(e) => setCompanyReason(e.target.value)}
                  className="w-full"
                  placeholder={t.treasury.reason}
                />
              </div>
              <div className="flex gap-2">
                {/* A reason is mandatory on both: the database enforces it for these events, so a
                    button that submits without one only ever produces a 400 the operator must decode. */}
                <Button onClick={() => moveCompany('deposit')} disabled={!companyAmt || !companyReason.trim()}>
                  {t.treasury.deposit}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => moveCompany('withdraw')}
                  disabled={!companyAmt || !companyReason.trim()}
                >
                  {t.treasury.withdraw}
                </Button>
              </div>
            </div>
          ) : null}
        </div> : null}
      </Card>

      <Card title={t.treasury.advances} className="lg:col-span-2">
        <p className="text-xs text-slate-600">{t.treasury.advancesHint}</p>
        {advancesError ? (
          <p className="mt-3 text-sm text-red-600">{explainError(advancesError, t)}</p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-slate-600">{t.treasury.advanceOutstandingCash}</dt>
              <dd className="text-end font-semibold">
                <Money value={advances?.outstandingCash ?? '0.00'} />
              </dd>
              <dt className="text-slate-600">{t.treasury.advanceOutstandingWallet}</dt>
              <dd className="text-end font-semibold">
                <Money value={advances?.outstandingWallet ?? '0.00'} />
              </dd>
            </dl>
            <div className="mt-3">
              <Table
                head={[
                  t.treasury.advanceParty,
                  t.expenses.description,
                  t.treasury.withdrawTo,
                  t.treasury.advanceOutstanding,
                  t.treasury.advanceRepaid,
                  t.accounts.actions,
                ]}
                isEmpty={(advances?.outstanding.length ?? 0) === 0}
                empty={t.treasury.advanceNone}
              >
                {(advances?.outstanding ?? []).map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 font-medium text-slate-800">{row.partyName}</td>
                    <td className="px-3 py-2 text-slate-600">{row.description}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {row.channel === 'office_cash' ? t.treasury.cashBox : t.treasury.wallet}
                    </td>
                    <td className="px-3 py-2 font-semibold"><Money value={row.outstanding} /></td>
                    <td className="px-3 py-2 text-slate-600"><Money value={row.repaid} /></td>
                    <td className="px-3 py-2">
                      {canDeposit ? (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <MoneyInput
                            value={advanceRepayAmt[row.id] ?? ''}
                            onChange={(e) => setAdvanceRepayAmt({ ...advanceRepayAmt, [row.id]: e.target.value })}
                            className="w-32"
                            placeholder={t.treasury.advanceOutstanding}
                          />
                          <TextInput
                            value={advanceReason[row.id] ?? ''}
                            onChange={(e) => setAdvanceReason({ ...advanceReason, [row.id]: e.target.value })}
                            className="w-40"
                            placeholder={t.treasury.advanceReason}
                          />
                          <Button
                            onClick={() => void repayAdvance(row.id)}
                            disabled={advanceBusy === row.id || !advanceRepayAmt[row.id] || !(advanceReason[row.id] ?? '').trim()}
                          >
                            {t.treasury.advanceRepay}
                          </Button>
                          {/* Capital drops here and nowhere else, so it asks first and needs a reason. */}
                          <Button
                            variant="ghost"
                            onClick={() => void convertAdvance(row.id)}
                            disabled={advanceBusy === row.id || !(advanceReason[row.id] ?? '').trim()}
                          >
                            {t.treasury.advanceConvert}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
            {canDeposit ? <p className="mt-2 text-xs text-slate-600">{t.treasury.advanceRepayHint}</p> : null}
          </>
        )}
      </Card>

      <Card title={t.treasury.receivables} className="lg:col-span-2">
        <p className="text-xs text-slate-600">{t.treasury.receivablesHint}</p>
        {!selectedReceivables ? (
          <Pending
            error={selectedReceivablesError}
            loadingLabel={t.common.loading}
            errorLabel={explainError(selectedReceivablesError, t)}
            onRetry={() => void loadReceivables()}
            retryLabel={t.common.retry}
          />
        ) : (
          <>
            {canDeposit ? (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <h3 className="text-sm font-bold text-slate-700">{t.treasury.receivableEventTitle}</h3>
                <p className="mt-1 text-xs text-slate-600">{t.treasury.receivableEventHint}</p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Field label={t.treasury.driver}>
                    <Select
                      value={receivableDraft.driverId}
                      disabled={receivableFingerprintLocked}
                      onChange={(event) => setReceivableDraft((current) => ({ ...current, driverId: event.target.value }))}
                    >
                      <option value="">—</option>
                      {receivableDrivers.map((driver) => (
                        <option
                          key={driver.id}
                          value={driver.id}
                          disabled={
                            !receivableDriverMaySubmit(driver, receivableDraft.direction) &&
                            !(exactPendingReceivableRetry && driver.id === receivableDraft.driverId)
                          }
                        >
                          {driver.fullNameAr} ({driver.code})
                          {driver.active ? '' : ` — ${t.accounts.inactive}; ${t.treasury.receivableDirections[receivableDraft.direction === 'create' ? 'collect' : receivableDraft.direction]}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t.treasury.receivableKind}>
                    <Select
                      value={receivableDraft.receivableKind}
                      disabled={receivableFingerprintLocked || receivableDraft.direction === 'writeoff'}
                      onChange={(event) => setReceivableDraft((current) => ({
                        ...current,
                        receivableKind: event.target.value as ReceivableKind,
                      }))}
                    >
                      <option value="ordinary">{t.treasury.receivableKinds.ordinary}</option>
                      <option value="shift_funding">{t.treasury.receivableKinds.shift_funding}</option>
                    </Select>
                  </Field>
                  <Field label={t.treasury.receivableChannel}>
                    <Select
                      value={receivableDraft.channel}
                      disabled={receivableFingerprintLocked}
                      onChange={(event) => setReceivableDraft((current) => ({
                        ...current,
                        channel: event.target.value as ReceivableChannel,
                      }))}
                    >
                      <option value="cash">{t.treasury.receivableChannels.cash}</option>
                      <option value="wallet">{t.treasury.receivableChannels.wallet}</option>
                    </Select>
                  </Field>
                  <Field label={t.treasury.receivableDirection}>
                    <Select
                      value={receivableDraft.direction}
                      disabled={receivableFingerprintLocked}
                      onChange={(event) => {
                        const direction = event.target.value as ReceivableOperationPayload['direction']
                        setReceivableDraft((current) => {
                          const selected = receivableDrivers.find((driver) => driver.id === current.driverId)
                          const changed = {
                            ...current,
                            direction,
                            ...(direction === 'writeoff' ? { receivableKind: 'ordinary' as const } : {}),
                          }
                          const exactRetry = pendingReceivableOperationMatches(
                            pendingReceivableEvent.current,
                            changed,
                          )
                          return {
                            ...changed,
                            driverId: receivableDriverMaySubmit(selected, direction) || exactRetry
                              ? current.driverId
                              : '',
                          }
                        })
                      }}
                    >
                      <option value="create">{t.treasury.receivableDirections.create}</option>
                      <option value="collect">{t.treasury.receivableDirections.collect}</option>
                      <option value="writeoff">{t.treasury.receivableDirections.writeoff}</option>
                    </Select>
                  </Field>
                  <Field label={t.treasury.amount}>
                    <MoneyInput
                      value={receivableDraft.amount}
                      disabled={receivableFingerprintLocked}
                      onChange={(event) => setReceivableDraft((current) => ({ ...current, amount: event.target.value }))}
                    />
                  </Field>
                </div>
                <div className="mt-3 grid grid-cols-1 items-end gap-3 lg:grid-cols-[1fr_auto]">
                  <Field label={t.treasury.receivableReason} hint={t.treasury.receivableReasonHint}>
                    <TextInput
                      value={receivableDraft.reason}
                      disabled={receivableFingerprintLocked}
                      onChange={(event) => setReceivableDraft((current) => ({ ...current, reason: event.target.value }))}
                      maxLength={500}
                    />
                  </Field>
                  <Button
                    variant={receivableDraft.direction === 'writeoff'
                      ? 'danger'
                      : receivableDraft.direction === 'create'
                        ? 'primary'
                        : 'success'}
                    disabled={receivableEventBusy || !receivableEventReady}
                    onClick={() => void submitReceivableEvent()}
                  >
                    {receivableOutboxRecovery.status === 'pending'
                      ? t.common.retry
                      : receivableDraft.direction === 'create'
                      ? t.treasury.receivableDirections.create
                      : receivableDraft.direction === 'collect'
                        ? t.treasury.receivableDirections.collect
                        : t.treasury.receivableDirections.writeoff}
                  </Button>
                </div>
                {receivableDraft.direction === 'writeoff' ? (
                  <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
                    {t.treasury.receivableWriteoffHint}
                  </p>
                ) : null}
                {receivableDraft.driverId ? (
                  <p className="mt-2 text-xs text-slate-600">
                    {t.treasury.currentReceivableBalance}: <Money value={selectedReceivableBalance} className="font-semibold" />
                  </p>
                ) : null}
                {receivableDraft.direction === 'writeoff' && !writeoffAmountWithinBalance ? (
                  <p className="mt-2 text-xs font-medium text-red-700">
                    {t.treasury.receivableWriteoffBalanceHint} <Money value={selectedReceivableBalance} />
                  </p>
                ) : null}
                {receivableEventError ? (
                  <p className="mt-2 text-sm font-medium text-red-600">
                    {receivableEventError === 'receivable_outbox_unavailable'
                      ? t.treasury.receivableOutboxUnavailable
                      : receivableEventError === 'receivable_outbox_corrupt'
                        ? t.treasury.receivableOutboxCorrupt
                        : receivableEventError === 'receivable_outbox_busy'
                          ? t.treasury.receivableOutboxBusy
                        : receivableEventError === 'receivable_pending_retry'
                          ? t.treasury.receivablePendingRetry
                          : receivableEventError === 'idempotency_key_conflict'
                      ? t.treasury.receivableIdempotencyConflict
                      : explainError(receivableEventError, t)}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-600">{t.treasury.receivableWriteRoleHint}</p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-500">{t.treasury.receivablesCashTotal}</div>
                <div className="mt-1 text-lg font-bold"><Money value={selectedReceivables.cashTotal} /></div>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs font-medium text-slate-500">{t.treasury.receivablesWalletTotal}</div>
                <div className="mt-1 text-lg font-bold"><Money value={selectedReceivables.walletTotal} /></div>
              </div>
              <div className="rounded-lg bg-brand/5 p-3 text-brand">
                <div className="text-xs font-medium">{t.treasury.receivablesGrandTotal}</div>
                <div className="mt-1 text-lg font-bold"><Money value={selectedReceivables.grandTotal} /></div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 p-3">
                <h3 className="text-sm font-semibold text-slate-700">{t.treasury.receivableKinds.ordinary}</h3>
                <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-slate-600">{t.treasury.receivableChannels.cash}</dt>
                  <dd className="text-end font-semibold"><Money value={selectedReceivables.ordinaryCashTotal} /></dd>
                  <dt className="text-slate-600">{t.treasury.receivableChannels.wallet}</dt>
                  <dd className="text-end font-semibold"><Money value={selectedReceivables.ordinaryWalletTotal} /></dd>
                </dl>
              </div>
              <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-3">
                <h3 className="text-sm font-semibold text-sky-800">{t.treasury.receivableKinds.shift_funding}</h3>
                <p className="mt-1 text-xs text-sky-700">{t.treasury.shiftFundingHint}</p>
                <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-slate-600">{t.treasury.receivableChannels.cash}</dt>
                  <dd className="text-end font-semibold"><Money value={selectedReceivables.shiftFundingCashTotal} /></dd>
                  <dt className="text-slate-600">{t.treasury.receivableChannels.wallet}</dt>
                  <dd className="text-end font-semibold"><Money value={selectedReceivables.shiftFundingWalletTotal} /></dd>
                </dl>
              </div>
            </div>
            <div className="mt-3">
              <Table
                head={[
                  t.treasury.driver,
                  t.treasury.driverCode,
                  `${t.treasury.receivableKinds.ordinary} / ${t.treasury.receivableChannels.cash}`,
                  `${t.treasury.receivableKinds.ordinary} / ${t.treasury.receivableChannels.wallet}`,
                  `${t.treasury.receivableKinds.shift_funding} / ${t.treasury.receivableChannels.cash}`,
                  `${t.treasury.receivableKinds.shift_funding} / ${t.treasury.receivableChannels.wallet}`,
                  t.treasury.total,
                  t.accounts.actions,
                ]}
                isEmpty={selectedReceivables.drivers.length === 0}
                empty={t.treasury.noReceivables}
              >
                {selectedReceivables.drivers.map((driver) => (
                  <tr key={driver.driverId}>
                    <td className="px-3 py-2 font-medium text-slate-800">{driver.nameAr}</td>
                    <td className="px-3 py-2 text-slate-600" dir="ltr">{driver.code}</td>
                    <td className="px-3 py-2"><Money value={driver.ordinaryCash} /></td>
                    <td className="px-3 py-2"><Money value={driver.ordinaryWallet} /></td>
                    <td className="px-3 py-2"><Money value={driver.shiftFundingCash} /></td>
                    <td className="px-3 py-2"><Money value={driver.shiftFundingWallet} /></td>
                    <td className="px-3 py-2 font-semibold"><Money value={driver.total} /></td>
                    <td className="px-3 py-2">
                      {/*
                        One pair of buttons per balance the driver ACTUALLY has. A driver with a
                        single 5,000 carry gets one pair, not four; a driver with none gets «—»
                        rather than buttons that would correct a zero to a zero.
                      */}
                      <div className="flex flex-col gap-1">
                        {([
                          ['ordinary', 'cash', driver.ordinaryCash],
                          ['ordinary', 'wallet', driver.ordinaryWallet],
                          ['shift_funding', 'cash', driver.shiftFundingCash],
                          ['shift_funding', 'wallet', driver.shiftFundingWallet],
                        ] as const)
                          .filter(([, , value]) => Number(value) !== 0)
                          .map(([kind, channel]) => (
                            <div key={`${kind}-${channel}`} className="flex items-center gap-1">
                              <span className="text-xs text-slate-500">
                                {t.treasury.receivableKinds[kind]} / {t.treasury.receivableChannels[channel]}
                              </span>
                              <Button
                                variant="ghost"
                                className="min-h-8 px-2 text-xs"
                                onClick={() => aimCorrection(driver.driverId, kind, channel, false)}
                              >
                                {t.treasury.correctionEdit}
                              </Button>
                              <Button
                                variant="ghost"
                                className="min-h-8 px-2 text-xs"
                                onClick={() => aimCorrection(driver.driverId, kind, channel, true)}
                              >
                                {t.treasury.correctionClear}
                              </Button>
                              {/*
                                Ordinary debts only. Shift funding is money the driver physically
                                holds for his next shift, not a debt to be re-filed — the same
                                reason the write-off path refuses it.
                              */}
                              {kind === 'ordinary' ? (
                                <>
                                <TextInput
                                  value={convertParty[driver.driverId] ?? ''}
                                  onChange={(e) =>
                                    setConvertParty({ ...convertParty, [driver.driverId]: e.target.value })
                                  }
                                  className="w-32"
                                  placeholder={`${t.treasury.advanceFromReceivableParty} ${driver.nameAr}`}
                                />
                                <Button
                                  variant="ghost"
                                  className="min-h-8 px-2 text-xs"
                                  onClick={() =>
                                    void convertReceivableToAdvance(
                                      driver.driverId,
                                      driver.nameAr,
                                      channel,
                                      channel === 'cash' ? driver.ordinaryCash : driver.ordinaryWallet,
                                    )
                                  }
                                >
                                  {t.treasury.advanceFromReceivable}
                                </Button>
                                </>
                              ) : null}
                            </div>
                          ))}
                        {Number(driver.total) === 0 ? <span className="text-xs text-slate-400">—</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
            <div ref={correctionFormRef} className="mt-5 border-t border-slate-200 pt-3">
              <h3 className="text-sm font-bold text-slate-700">{t.treasury.correctionTitle}</h3>
              <p className="mt-1 text-xs text-slate-600">{t.treasury.correctionHint}</p>
              {correctionTarget.trim() === '0.00' && correctionCurrent !== null ? (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {t.treasury.correctionClearing}
                </p>
              ) : null}
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t.treasury.driver}>
                  <Select value={correctionDriverId} onChange={(e) => setCorrectionDriverId(e.target.value)}>
                    <option value="">—</option>
                    {(receivablesBranchId === branchId ? receivables?.drivers ?? [] : []).map((d) => (
                      <option key={d.driverId} value={d.driverId}>
                        {d.nameAr} ({d.code})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t.treasury.receivableKind}>
                  <Select value={correctionKind} onChange={(e) => setCorrectionKind(e.target.value as ReceivableKind)}>
                    <option value="ordinary">{t.treasury.receivableKinds.ordinary}</option>
                    <option value="shift_funding">{t.treasury.receivableKinds.shift_funding}</option>
                  </Select>
                </Field>
                <Field label={t.treasury.receivableChannel}>
                  <Select
                    value={correctionChannel}
                    onChange={(e) => setCorrectionChannel(e.target.value as ReceivableChannel)}
                  >
                    <option value="cash">{t.treasury.receivableChannels.cash}</option>
                    <option value="wallet">{t.treasury.receivableChannels.wallet}</option>
                  </Select>
                </Field>
                <Field label={t.treasury.correctionCurrent}>
                  {/* Read-only by design — see `correctionCurrent`. */}
                  <div className="num flex min-h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
                    {correctionCurrent === null ? '—' : <Money value={correctionCurrent} />}
                  </div>
                </Field>
                <Field label={t.treasury.correctionTarget}>
                  <MoneyInput value={correctionTarget} onChange={(e) => setCorrectionTarget(e.target.value)} />
                </Field>
                <Field label={t.treasury.receivableReason} hint={t.treasury.receivableReasonHint}>
                  <TextInput value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} />
                </Field>
              </div>
              {correctionError ? (
                <p className="mt-2 text-sm text-red-600">{explainError(correctionError, t)}</p>
              ) : null}
              {correctionCurrent !== null && correctionTarget.trim() === correctionCurrent ? (
                <p className="mt-2 text-sm text-amber-700">{t.treasury.correctionNoChange}</p>
              ) : null}
              <div className="mt-3">
                <Button
                  onClick={() => void submitCorrection()}
                  disabled={
                    correctionBusy ||
                    correctionCurrent === null ||
                    correctionTarget.trim() === '' ||
                    correctionTarget.trim() === correctionCurrent ||
                    correctionReason.trim() === ''
                  }
                >
                  {t.treasury.correctionSave}
                </Button>
              </div>
            </div>

            <div className="mt-5 border-t border-slate-200 pt-3">
              <h3 className="text-sm font-bold text-slate-700">{t.treasury.receivableHistory}</h3>
              {!selectedReceivableHistory ? (
                <Pending
                  error={selectedReceivableHistoryError}
                  loadingLabel={t.common.loading}
                  errorLabel={explainError(selectedReceivableHistoryError, t)}
                  onRetry={() => void loadReceivableHistory()}
                  retryLabel={t.common.retry}
                />
              ) : (
                <Table
                  head={[
                    t.treasury.eventDate,
                    t.treasury.driver,
                    t.treasury.receivableKind,
                    t.treasury.receivableChannel,
                    t.treasury.receivableDirection,
                    t.treasury.amount,
                    t.treasury.receivableReason,
                  ]}
                  isEmpty={selectedReceivableHistory.length === 0}
                  empty={t.treasury.noReceivableHistory}
                >
                  {selectedReceivableHistory.slice(0, 10).map((event) => (
                    <tr key={event.id}>
                      <td className="num px-3 py-2 text-slate-500">{event.businessDate}</td>
                      <td className="px-3 py-2">{event.driverNameAr} ({event.driverCode})</td>
                      <td className="px-3 py-2">{t.treasury.receivableKinds[event.receivableKind]}</td>
                      <td className="px-3 py-2">{t.treasury.receivableChannels[event.channel]}</td>
                      <td className="px-3 py-2">
                        {/*
                          A correction posts as a collection, and rendering it as one would tell the
                          driver his debt was paid when nothing was paid. Name it, and show the
                          restatement it actually was.
                        */}
                        {event.intent === 'writeoff' ? (
                          <span className="text-red-700">{t.treasury.writeoffIntent}</span>
                        ) : event.intent === 'correction' ? (
                          <span className="num text-slate-700">
                            {t.treasury.correctionIntent}: <Money value={event.priorBalance ?? '0.00'} /> →{' '}
                            <Money value={event.targetBalance ?? '0.00'} />
                          </span>
                        ) : (
                          t.treasury.receivableDirections[event.direction]
                        )}
                      </td>
                      <td className="px-3 py-2"><Money value={event.amount} /></td>
                      <td className="px-3 py-2 text-slate-600">{event.reason}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          </>
        )}
      </Card>

      {/*
        «الترميم» — the owner's own end-of-day process, in his own words.

        It reads the ledger-backed office balance and shows the two boxes side by side: what the
        system says is in each box, what is out on ذمم, and how far that stands from رأس مال المكتب.
      */}
      <Card title={t.treasury.restoration} className="lg:col-span-2">
        <p className="text-xs text-slate-600">{t.treasury.restorationHint}</p>
        {!restoration ? (
          <Pending
            error={restorationError}
            loadingLabel={t.common.loading}
            errorLabel={explainError(restorationError, t)}
            onRetry={() => void loadRestoration()}
            retryLabel={t.common.retry}
          />
        ) : restoration.source !== 'live_ledger' ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            {t.treasury.restorationServerUpdateRequired}
          </div>
        ) : (
          <>
            {canDeposit ? (
              <section className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">{t.treasury.editCapitalTargets}</h3>
                    <p className="mt-0.5 text-xs text-slate-600">{t.treasury.capitalTargetsHint}</p>
                  </div>
                  {restoration.alreadyRestored === true ? (
                    <span className="text-xs font-semibold text-amber-700">{t.treasury.capitalTargetsLocked}</span>
                  ) : null}
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="text-xs font-medium text-slate-600">
                    {t.treasury.cashCapitalTarget}
                    <MoneyInput
                      className="mt-1 w-full"
                      value={capitalTargetsDraft.cash}
                      disabled={capitalTargetsBusy || restoration.alreadyRestored === true}
                      onChange={(event) => setCapitalTargetsDraft((current) => ({ ...current, cash: event.target.value }))}
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {t.treasury.walletCapitalTarget}
                    <MoneyInput
                      className="mt-1 w-full"
                      value={capitalTargetsDraft.wallet}
                      disabled={capitalTargetsBusy || restoration.alreadyRestored === true}
                      onChange={(event) => setCapitalTargetsDraft((current) => ({ ...current, wallet: event.target.value }))}
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-600">
                    {t.treasury.capitalTargetReason}
                    <TextInput
                      className="mt-1 w-full"
                      value={capitalTargetReason}
                      placeholder={t.treasury.capitalTargetReasonPlaceholder}
                      disabled={capitalTargetsBusy || restoration.alreadyRestored === true}
                      onChange={(event) => setCapitalTargetReason(event.target.value)}
                    />
                  </label>
                  <Button
                    className="self-end"
                    disabled={capitalTargetsBusy || restoration.alreadyRestored === true || !capitalTargetsReady}
                    onClick={() => void saveCapitalTargets()}
                  >
                    {t.treasury.saveCapitalTargets}
                  </Button>
                </div>
              </section>
            ) : null}
            {restorationSummary ? (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-medium text-slate-500">{t.treasury.currentPosition}</div>
                  <div className="mt-1 text-lg font-bold"><Money value={restorationSummary.position} /></div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs font-medium text-slate-500">{t.treasury.capitalTarget}</div>
                  <div className="mt-1 text-lg font-bold"><Money value={restorationSummary.target} /></div>
                </div>
                <div
                  className={`rounded-lg p-3 ${
                    restorationSummary.delta.direction === 'increase'
                      ? 'bg-emerald-50 text-emerald-800'
                      : restorationSummary.delta.direction === 'shortage'
                        ? 'bg-amber-50 text-amber-800'
                        : 'bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="text-xs font-medium">{directionLabel(restorationSummary.delta.direction, true)}</div>
                  <div className="mt-1 text-lg font-bold"><Money value={restorationSummary.delta.amount} /></div>
                </div>
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {restoration.legs.map((leg) => {
                const delta = differenceView(leg.delta)
                return (
                  <div key={leg.fundCode} className="rounded-lg border border-slate-200 p-3">
                    <div className="text-xs font-semibold text-slate-500">
                      {leg.fundCode === 'office_cash' ? t.treasury.cashBox : t.treasury.wallet}
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
                      <div className="col-span-2 rounded-lg bg-slate-50 px-2 py-1.5">
                        <dt className="text-xs text-slate-500">{t.treasury.positionFormula}</dt>
                        <dd className="mt-1 flex flex-wrap items-center justify-end gap-1 font-semibold" dir="ltr">
                          <Money value={leg.officeBalance} />
                          <span>+</span>
                          <Money value={leg.receivables} />
                          <span>=</span>
                          <Money value={leg.position} />
                        </dd>
                      </div>
                      <dt className="text-slate-600">{t.treasury.capitalTarget}</dt>
                      <dd className="text-end">
                        <Money value={leg.capitalTarget} />
                      </dd>
                    </dl>
                    <div
                      className={`mt-2 border-t border-slate-100 pt-2 text-sm font-semibold ${
                        delta.direction === 'increase'
                          ? 'text-emerald-700'
                          : delta.direction === 'shortage'
                            ? 'text-amber-700'
                            : 'text-slate-600'
                      }`}
                    >
                      <div>
                        {directionLabel(delta.direction, true)}
                        {delta.direction === 'none' ? null : <>: <Money value={delta.amount} /></>}
                      </div>
                      <div className="mt-1">
                        {transferLabel(leg.direction)}
                        {leg.direction ? <>: <Money value={leg.amount} /></> : null}
                      </div>
                    </div>
                    {leg.refusals.map((code) => (
                      <p key={code} className="mt-2 text-xs text-red-700">
                        {t.treasury.restorationRefusal[code]}
                      </p>
                    ))}
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              {restorationNet ? (
                <span
                  className={`text-sm font-semibold ${
                    restorationNet.direction === 'increase'
                      ? 'text-emerald-700'
                      : restorationNet.direction === 'shortage'
                        ? 'text-amber-700'
                        : 'text-slate-600'
                  }`}
                >
                  {t.treasury.netMovement}: {' '}
                  {restorationNet.direction === 'increase'
                    ? t.treasury.transferToCompany
                    : restorationNet.direction === 'shortage'
                      ? t.treasury.transferFromCompany
                      : t.treasury.noMovement}
                  {restorationNet.direction === 'none' ? null : <> — <Money value={restorationNet.amount} /></>}
                </span>
              ) : null}
              {restoration.alreadyRestored === true ? (
                <span className="text-sm font-semibold text-emerald-700">{t.treasury.restored} ✓</span>
              ) : (
                <Button onClick={doRestore} disabled={!restoration.feasible}>
                  {t.treasury.doRestore}
                </Button>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title={t.week.close}>
        {session?.roleKey === 'system_admin' ? (
          <>
            <Button variant="danger" onClick={closeWeek}>
              {t.week.closeSunday}
            </Button>
            {closeResult?.weekStart ? (
              <p className="mt-2 text-sm text-emerald-700">
                {t.week.sealed}: {closeResult.weekStart}
              </p>
            ) : closeResult?.blockers ? (
              <ul className="mt-2 text-sm text-red-600">
                {closeResult.blockers.map((b, i) => (
                  <li key={i}>• {t.treasury.closeBlockers[b.kind as keyof typeof t.treasury.closeBlockers] ?? b.kind}</li>
                ))}
              </ul>
            ) : closeResult?.error ? (
              // A refusal carrying neither a weekStart nor blockers used to fall through to null:
              // the sysadmin pressed «إقفال الأحد», nothing changed on screen, and the reason
              // (branch_required) was never shown. Silence is the worst failure mode for the one
              // action that makes a week immutable.
              <p className="mt-2 text-sm font-medium text-red-600">{explainError(closeResult.error, t)}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-600">{t.week.closeSunday} — {t.common.no}</p>
        )}
      </Card>

      {/* E-3: controlled manual entry + the BR7 visible dated reversal (branch manager + GM). */}
      {canDeposit ? (
        <Card title={t.treasury.manualEntry} className="lg:col-span-2">
          <div className="flex flex-col gap-3">
            <Field label={t.treasury.reason}>
              <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Table head={[t.treasury.fund, t.treasury.side, t.treasury.amount, '']}>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    <Select value={l.fundCode} onChange={(e) => setLine(i, { fundCode: e.target.value })} aria-label={t.treasury.fund}>
                      {MANUAL_FUNDS.map((f) => (
                        <option key={f} value={f}>
                          {t.treasury.fundCodes[f as keyof typeof t.treasury.fundCodes] ?? f}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <Select value={l.side} onChange={(e) => setLine(i, { side: e.target.value as 'D' | 'C' })} aria-label={t.treasury.side}>
                      <option value="D">{t.treasury.debit}</option>
                      <option value="C">{t.treasury.credit}</option>
                    </Select>
                  </td>
                  <td className="px-2 py-1">
                    <MoneyInput value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} className="w-32" aria-label={t.treasury.amount} />
                  </td>
                  <td className="px-2 py-1">
                    {lines.length > 2 ? (
                      <Button variant="ghost" onClick={() => removeLine(i)} aria-label={t.common.remove}>
                        ×
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
            <div className="flex items-center gap-3">
              <Button variant="ghost" onClick={addLine}>
                + {t.treasury.addLine}
              </Button>
              <span className="num ms-auto text-xs text-slate-500" dir="ltr">
                D <Money value={sideTotal('D')} /> · C <Money value={sideTotal('C')} />
                {entryBalanced ? '' : ` · ${t.treasury.unbalanced}`}
              </span>
            </div>
            {manualError ? <p className="text-sm text-red-600">{explainError(manualError, t)}</p> : null}
            {manualMsg ? <p className="text-sm font-medium text-emerald-700">{manualMsg}</p> : null}
            <Button variant="primary" className="self-start" disabled={!entryBalanced} onClick={postManual}>
              {t.treasury.post}
            </Button>

            <div className="mt-1 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <Field label={t.treasury.entryId}>
                <TextInput inputMode="numeric" value={revId} onChange={(e) => setRevId(e.target.value)} className="w-24" />
              </Field>
              <Field label={t.treasury.reason} className="min-w-48 flex-1">
                <TextInput value={revReason} onChange={(e) => setRevReason(e.target.value)} />
              </Field>
              <Button variant="danger" disabled={revId.trim() === '' || revReason.trim() === ''} onClick={doReverse}>
                {t.treasury.reverse}
              </Button>
            </div>
            {revMsg ? <p className="text-sm text-slate-600">{revMsg}</p> : null}
          </div>
        </Card>
      ) : null}
    </div>
  )
}

/** The Sunday on or after `date`, matching the API's "close on the following Sunday". */
function nextSunday(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(y, m - 1, d)
  const dow = new Date(ms).getUTCDay()
  const add = dow === 0 ? 7 : 7 - dow
  const next = new Date(ms + add * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}
