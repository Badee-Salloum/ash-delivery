/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const treasurySource = readFileSync(new URL('./screens/Treasury.tsx', import.meta.url), 'utf8')
const dashboardSource = readFileSync(new URL('./screens/Dashboard.tsx', import.meta.url), 'utf8')

describe('branch treasury screen contract', () => {
  it('uses unambiguous funding, count and directional transfer copy in both languages', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.treasury.ownerFunding).not.toBe(catalog.treasury.deposit)
      expect(catalog.treasury.transferToCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.transferFromCompany.length).toBeGreaterThan(10)
      expect(catalog.treasury.noMovement.length).toBeGreaterThan(3)
      expect(catalog.dashboard.companyProfitLabel).not.toBe('Company profit')
      expect(catalog.dashboard.companyProfitLabel).not.toBe('ربح الشركة')
    }
  })

  it('reloads the sealed count instead of replacing its details with a check mark', () => {
    expect(treasurySource).toContain("api.get<CashCountView>(`/cash-counts/${d.businessDate}`)")
    expect(treasurySource).toContain('restoreCountDraft(saved.lines)')
    expect(treasurySource).toContain('savedCountDetails')
  })

  it('does not fetch or render the company fund for a branch-only role', () => {
    expect(treasurySource).toContain("'profit.view_total'")
    expect(treasurySource).toContain('if (!canViewCompanyFund)')
    expect(treasurySource).toContain('{canViewCompanyFund ? <div')
  })

  it('keeps both restoration legs in the confirmation and displays the dashboard capital delta', () => {
    expect(treasurySource).toContain('restoration.legs.map((leg) =>')
    expect(treasurySource).toContain("legText.join(' • ')")
    expect(dashboardSource).toContain('differenceView(treasury.capital.delta)')
    expect(dashboardSource).toContain('capitalDelta.amount')
  })

  it('keeps open-shift custody inside working capital while showing it separately from the office position', () => {
    expect(dashboardSource).toContain('value={<Money value={treasury.capital.total} />}')
    expect(dashboardSource).toContain('treasury.capital.officePosition')
    expect(dashboardSource).toContain('treasury.capital.activeCustodyTotal')
    expect(dashboardSource).toContain('treasury.capital.activeCustodyCash')
    expect(dashboardSource).toContain('treasury.capital.activeCustodyWallet')
    expect(dashboardSource).toContain('treasury.capital.activeShiftCount')
    for (const catalog of [ar, en]) {
      expect(catalog.dashboard.officePosition.length).toBeGreaterThan(10)
      expect(catalog.dashboard.activeShiftCustody).toContain('{n}')
    }
  })

  it('shows the restoration position as the exact counted plus receivables equation', () => {
    expect(treasurySource).toContain('<Money value={leg.counted} />')
    expect(treasurySource).toContain('<Money value={leg.receivables} />')
    expect(treasurySource).toContain('<Money value={leg.position} />')
    expect(treasurySource).toContain("<span>=</span>")
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
