/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const treasurySource = readFileSync(new URL('./screens/Treasury.tsx', import.meta.url), 'utf8')
const dashboardSource = readFileSync(new URL('./screens/dashboard/CapitalSection.tsx', import.meta.url), 'utf8')

describe('branch treasury screen contract', () => {
  it('uses unambiguous funding and directional transfer copy in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.ownerFunding).not.toBe(catalog.treasury.deposit)
      expect(catalog.treasury.transferToCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.transferFromCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.noMovement.length).toBeGreaterThan(3)
      expect(catalog.dashboard.companyProfitLabel).not.toBe('Company profit')
      expect(catalog.dashboard.companyProfitLabel).not.toBe('ربح الشركة')
    }
  })

  it('shows only the expected office balances and omits the daily cash-count form', () => {
    expect(treasurySource).toContain('.treasuryBalances()')
    expect(treasurySource).toContain("target === 'cash' ? t.treasury.expectedCashBox : t.treasury.expectedWallet")
    expect(treasurySource).not.toContain('<Card title={t.treasury.cashCount}>')
    expect(treasurySource).not.toContain('/cash-counts')
    expect(ar.treasury.expectedCashBox).toContain('يجب')
    expect(ar.treasury.expectedWallet).toContain('يجب')
    expect(en.treasury.expectedCashBox.toLowerCase()).toContain('expected')
    expect(en.treasury.expectedWallet.toLowerCase()).toContain('expected')
  })

  // Was `profit.view_total` for the card while the writes needed only `journal.manual.write`; since
  // 2026-09-17 one key, `company_fund.manage`, gates the read and both writes on the server.
  it('does not fetch or render the company fund without company_fund.manage (was profit.view_total)', () => {
    expect(treasurySource).toContain("'company_fund.manage'")
    expect(treasurySource).not.toContain("'profit.view_total'")
    expect(treasurySource).toContain('if (!canManageCompanyFund)')
    expect(treasurySource).toContain('{canManageCompanyFund ? <div')
  })

  it('never offers صندوق الشركة as a manual-entry fund', () => {
    const manualFunds = /const MANUAL_FUNDS = \[([^\]]*)\]/.exec(treasurySource)?.[1]
    expect(manualFunds).toBeDefined()
    expect(manualFunds).toContain("'office_cash'")
    expect(manualFunds).not.toContain('company_box')
  })

  // The hand «كييش» row used to render for anyone with `journal.manual.write`, the branch manager
  // included; it moves صندوق الشركة, so it now renders only under `company_fund.manage`.
  it('renders the hand «كييش» only for company_fund.manage and sends it with a held key', () => {
    const kaishButton = treasurySource.indexOf('{t.treasury.transferToCompanyKaish}')
    expect(kaishButton).toBeGreaterThan(-1)
    expect(treasurySource.indexOf('{t.treasury.transferToCompanyKaish}', kaishButton + 1)).toBe(-1)
    const guard = treasurySource.lastIndexOf('{canManageCompanyFund ? (', kaishButton)
    expect(guard).toBeGreaterThan(-1)
    // Nothing closes that guard between it and the button.
    expect(treasurySource.slice(guard, kaishButton)).not.toContain(') : null}')

    const kaish = treasurySource.slice(
      treasurySource.indexOf('async function withdraw('),
      treasurySource.indexOf('const loadAdvances'),
    )
    expect(kaish).toContain('pendingMoneyMove(pendingKaish.current[target], {')
    expect(kaish).toContain(
      "api.treasuryWithdraw(target, amount, t.treasury.kaish, 'company_box', operation.idempotencyKey)",
    )
    expect(kaish).toContain('pendingAfterAttempt(operation, { ok: false, error: code })')
    expect(treasurySource).not.toMatch(/treasuryWithdraw\([^)]*randomUUID/)
    for (const catalog of [ar, en]) {
      expect(catalog.errors.company_fund_forbidden.length).toBeGreaterThan(20)
    }
  })

  it('sends one held idempotency key per company-fund move and treasury deposit', () => {
    const company = treasurySource.slice(
      treasurySource.indexOf('async function moveCompany'),
      treasurySource.indexOf('async function deposit('),
    )
    expect(company).toContain('pendingMoneyMove(pendingCompanyMove.current[direction], {')
    expect(company).toContain('command: `company_${direction}`')
    expect(company).toContain('api.companyFundDeposit(companyAmt, reasonText, operation.idempotencyKey)')
    expect(company).toContain('api.companyFundWithdraw(companyAmt, reasonText, operation.idempotencyKey)')
    expect(company).toContain('pendingAfterAttempt(operation, { ok: false, error: code })')

    const deposit = treasurySource.slice(
      treasurySource.indexOf('async function deposit('),
      treasurySource.indexOf('async function moveBetweenBoxes'),
    )
    expect(deposit).toContain('pendingMoneyMove(pendingDeposit.current[target], {')
    expect(deposit).toContain('api.treasuryDeposit(target, amount, operation.idempotencyKey)')
    expect(deposit).toContain('pendingAfterAttempt(operation, { ok: false, error: code })')
    // A fresh key per press is exactly the double-deposit this replaces.
    expect(treasurySource).not.toMatch(/companyFund(Deposit|Withdraw)\([^)]*randomUUID/)
    expect(treasurySource).not.toMatch(/treasuryDeposit\([^)]*randomUUID/)
  })

  it('keeps both restoration legs in the confirmation and displays the dashboard capital delta', () => {
    expect(treasurySource).toContain('restoration.legs.map((leg) =>')
    expect(treasurySource).toContain("legText.join(' • ')")
    expect(dashboardSource).toContain('differenceView(data.capital.delta)')
    expect(dashboardSource).toContain('capitalDelta.amount')
  })

  it('keeps open-shift custody inside working capital while showing it separately from the office position', () => {
    expect(dashboardSource).toContain('value={<Money value={data.capital.total} />}')
    expect(dashboardSource).toContain('data.capital.officePosition')
    expect(dashboardSource).toContain('data.capital.activeCustodyTotal')
    expect(dashboardSource).toContain('data.capital.activeCustodyCash')
    expect(dashboardSource).toContain('data.capital.activeCustodyWallet')
    expect(dashboardSource).toContain('data.capital.activeShiftCount')
    for (const catalog of [ar, en]) {
      expect(catalog.dashboard.officePosition.length).toBeGreaterThan(10)
      expect(catalog.dashboard.activeShiftCustody).toContain('{n}')
    }
  })

  it('shows the restoration position as system balance plus receivables without count semantics', () => {
    expect(treasurySource).toContain('<Money value={leg.officeBalance} />')
    expect(treasurySource).toContain('<Money value={leg.receivables} />')
    expect(treasurySource).toContain('<Money value={leg.position} />')
    expect(treasurySource).toContain("<span>=</span>")
    expect(treasurySource).not.toContain('leg.counted')
    expect(treasurySource).not.toContain('restoration.counted')
    expect(treasurySource).not.toContain('t.treasury.countFirst')
    expect(ar.treasury.positionFormula).toBe('رصيد النظام + الذمم')
    expect(ar.treasury.restorationHint).not.toMatch(/جرد|مجرود/)
    expect(en.treasury.positionFormula).toBe('system balance + receivables')
    expect(en.treasury.restorationHint.toLowerCase()).not.toContain('count')
  })

  it('gates restoration on a ledger-backed response, feasibility, and the persisted completed state', () => {
    expect(treasurySource).toContain("restoration.source !== 'live_ledger'")
    expect(treasurySource).toContain("if (!restoration || restoration.source !== 'live_ledger') return")
    expect(treasurySource).toContain('restoration.alreadyRestored === true ? (')
    expect(treasurySource).toContain('<Button onClick={doRestore} disabled={!restoration.feasible}>')
    expect(treasurySource).not.toContain('restoreDone')
  })

  it('lets an authorised manager edit both effective restoration targets with confirmation', () => {
    expect(treasurySource).toContain('async function saveCapitalTargets()')
    expect(treasurySource).toContain('await api.updateCapitalTargets(cashTarget, walletTarget, reason)')
    expect(treasurySource).toContain('t.treasury.confirmCapitalTargets')
    expect(treasurySource).toContain('restoration.alreadyRestored === true')
    expect(treasurySource).toContain('await loadRestoration()')
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.cashCapitalTarget.length).toBeGreaterThan(5)
      expect(catalog.treasury.walletCapitalTarget.length).toBeGreaterThan(5)
      expect(catalog.treasury.capitalTargetsHint.length).toBeGreaterThan(20)
    }
  })

  it('loads a branch-scoped receivables table with totals, retry and stale-response protection', () => {
    expect(treasurySource).toContain('const receivablesLoadVersion = useRef(0)')
    expect(treasurySource).toContain('const version = ++receivablesLoadVersion.current')
    expect(treasurySource).toContain('if (version !== receivablesLoadVersion.current) return')
    expect(treasurySource).toContain('receivablesBranchId === branchId')
    expect(treasurySource).toContain('api.receivables(),')
    expect(treasurySource).toContain('onRetry={() => void loadReceivables()}')
    expect(treasurySource).toContain('selectedReceivables.cashTotal')
    expect(treasurySource).toContain('selectedReceivables.walletTotal')
    expect(treasurySource).toContain('selectedReceivables.grandTotal')
    expect(treasurySource).toContain('selectedReceivables.ordinaryCashTotal')
    expect(treasurySource).toContain('selectedReceivables.ordinaryWalletTotal')
    expect(treasurySource).toContain('selectedReceivables.shiftFundingCashTotal')
    expect(treasurySource).toContain('selectedReceivables.shiftFundingWalletTotal')
    expect(treasurySource).toContain('driver.ordinaryCash')
    expect(treasurySource).toContain('driver.ordinaryWallet')
    expect(treasurySource).toContain('driver.shiftFundingCash')
    expect(treasurySource).toContain('driver.shiftFundingWallet')
    expect(treasurySource).toContain('selectedReceivables.drivers.map((driver) =>')
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.receivables.length).toBeGreaterThan(3)
      expect(catalog.treasury.receivablesHint.length).toBeGreaterThan(20)
      expect(catalog.treasury.noReceivables.length).toBeGreaterThan(5)
    }
  })

  it('provides an audited direct receivable form with safe retries and compact history', () => {
    const submit = treasurySource.slice(
      treasurySource.indexOf('async function submitReceivableEvent'),
      treasurySource.indexOf('async function saveCapitalTargets'),
    )
    expect(treasurySource).toContain('const mutex = browserReceivableOperationMutex()')
    expect(treasurySource).toContain('const outcome = await executeReceivableOperation({')
    expect(treasurySource).toContain('idempotencyKey: operation.idempotencyKey')
    expect(treasurySource).toContain('return api.createReceivableEvent')
    expect(treasurySource).toContain('return api.writeoffReceivable')
    expect(treasurySource).toContain("receivableKind: 'ordinary'")
    expect(treasurySource).toContain("direction: 'create'")
    expect(treasurySource).toContain('receivableOperationReady(payload)')
    expect(treasurySource).toContain('pendingReceivableEvent.current = null')
    expect(treasurySource).toContain('const receivableSubmitVersion = useRef(0)')
    expect(treasurySource).toContain('if (activeVersion !== receivableSubmitVersion.current) return')
    expect(treasurySource).toContain('await api.receivableEvents()')
    expect(treasurySource).toContain('const receivableHistoryLoadVersion = useRef(0)')
    expect(treasurySource).toContain('if (version !== receivableHistoryLoadVersion.current) return')
    expect(treasurySource).toContain('selectedReceivableHistory.slice(0, 10)')
    expect(treasurySource).toContain('receivableEventConfirmTitle')
    expect(treasurySource).toContain('receivableDirectoryDrivers(directory.drivers, outstandingDriverIds)')
    expect(treasurySource).toContain('pendingDriverId = pendingReceivableEvent.current?.payload.driverId')
    expect(treasurySource).toContain('loadPendingReceivableOperation(')
    expect(treasurySource).toContain('idempotencyKey: operation.idempotencyKey')
    expect(treasurySource).toContain('exactPendingReceivableRetry && driver.id === receivableDraft.driverId')
    expect(submit.indexOf('executeReceivableOperation({')).toBeLessThan(
      submit.indexOf('api.createReceivableEvent'),
    )
    expect(submit).toContain("setReceivableEventError('receivable_outbox_busy')")
    expect(submit).toContain("setReceivableEventError('receivable_pending_retry')")
    expect(submit).toContain('confirmedAgainstVersion !== receivableSubmitVersion.current')
    expect((treasurySource.match(/receivableFingerprintLocked/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(treasurySource).toContain("receivableOutboxRecovery.status === 'pending'")
    expect(treasurySource).toContain("direction === 'writeoff'")
    expect(treasurySource).toContain('receivableWriteoffHint')
    expect(treasurySource).toContain("event.intent === 'writeoff'")
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.receivableKinds.ordinary).not.toBe(catalog.treasury.receivableKinds.shift_funding)
      expect(catalog.treasury.receivableDirections.create).not.toBe(catalog.treasury.receivableDirections.collect)
      expect(catalog.treasury.receivableDirections.writeoff).not.toBe(catalog.treasury.receivableDirections.collect)
      expect(catalog.treasury.receivableWriteoffHint.length).toBeGreaterThan(40)
      expect(catalog.treasury.receivableReasonHint.length).toBeGreaterThan(20)
      expect(catalog.treasury.shiftFundingHint.length).toBeGreaterThan(20)
      expect(catalog.treasury.receivablePendingRetry.length).toBeGreaterThan(40)
      expect(catalog.treasury.receivableOutboxUnavailable.length).toBeGreaterThan(40)
      expect(catalog.treasury.receivableOutboxCorrupt.length).toBeGreaterThan(40)
      expect(catalog.treasury.receivableOutboxBusy.length).toBeGreaterThan(40)
    }
  })

  it('reloads the persisted preview after restoration instead of pinning the pre-action POST plan', () => {
    const action = treasurySource.slice(treasurySource.indexOf('async function doRestore'), treasurySource.indexOf('async function closeWeek'))
    expect(action).toMatch(/await api\.restore\([^\n]+\)[\s\S]*?await loadRestoration\(\)/)
    expect(action).not.toContain('setRestoration({ ...done')
    expect(action).not.toContain('setRestoreDone(true)')
  })
})
