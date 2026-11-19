import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPANY_BRANCH, makeHarness, type Harness } from './harness.ts'

let h: Harness
let gm: string
const post = (url: string, payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url,
  headers: { cookie: h.cookie(gm) }, payload })
const key = () => crypto.randomUUID()
beforeEach(async () => { h = await makeHarness({ companyHistoricalPostingEnabled: false }); gm = await h.loginAs('gm') })
afterEach(async () => { await h.app.close() })

describe('normal company entry on its actual financial day', () => {
  it('uses the actual past financial date even when the retired intake is disabled', async () => {
    const receipt = await post('/company/deposits', { idempotencyKey: key(), amount: '100.00', currency: 'SYP_NEW',
      occurredOn: '2025-01-01', reason: 'actual dated company funding' })
    expect(receipt.statusCode, receipt.body).toBe(201)
    expect(receipt.json().command).toMatchObject({ occurredOn: '2025-01-01', businessDate: '2025-01-01' })
    const entry = h.deps.ledger.entries.at(-1)!
    expect(entry).toMatchObject({ businessDate: '2025-01-01', postingDate: '2025-01-01', createdAtMs: h.deps.clock.nowMs() })
    expect(h.deps.ledger.entries.filter(e => e.branchId !== COMPANY_BRANCH)).toHaveLength(0)
  })

  it('requires and freezes the historical USD rate, including exact retry conflicts', async () => {
    const payload = { idempotencyKey: key(), currency: 'USD', amount: '10.00', occurredOn: '2025-01-01', reason: 'source receipt' }
    expect((await post('/company/deposits', payload)).json().error).toBe('historical_rate_required')
    const receipt = await post('/company/deposits', { ...payload, historicalRate: '125.00' })
    expect(receipt.statusCode, receipt.body).toBe(201)
    expect(receipt.json().command.sypMinorPerUsd).toBe('12500')
    expect((await post('/company/deposits', { ...payload, historicalRate: '125.00' })).statusCode).toBe(200)
    expect((await post('/company/deposits', { ...payload, historicalRate: '126.00' })).statusCode).toBe(409)
  })

  it('preserves a historical negative balance without permitting a negative amount', async () => {
    expect((await post('/company/withdrawals', { idempotencyKey: key(), amount: '50.00', occurredOn: '2025-01-01', reason: 'real old payment' })).statusCode).toBe(201)
    expect(await h.deps.ledger.fundBalance(COMPANY_BRANCH, 'company_cash:SYP_NEW')).toBe(-5000n)
    expect((await post('/company/withdrawals', { idempotencyKey: key(), amount: '-1.00', occurredOn: '2025-01-01', reason: 'invalid signed input' })).statusCode).toBe(400)
  })

  it('derives a past exchange rate from both actual amounts, rejects future and invalid dates', async () => {
    const receipt = await post('/company/exchanges', { idempotencyKey: key(), fromCurrency: 'USD', fromAmount: '10.00',
      toCurrency: 'SYP_NEW', toAmount: '1350.00', occurredOn: '2025-01-01', reason: 'actual exchange' })
    expect(receipt.statusCode, receipt.body).toBe(201)
    expect(receipt.json().command).toMatchObject({ businessDate: '2025-01-01', sypMinorPerUsd: '13500' })
    for (const occurredOn of ['1999-12-31', '2026-07-22', '2025-02-30']) {
      const result = await post('/company/deposits', { idempotencyKey: key(), amount: '1.00', occurredOn, reason: 'invalid day' })
      expect(result.statusCode).toBeGreaterThanOrEqual(400)
    }
  })
})
