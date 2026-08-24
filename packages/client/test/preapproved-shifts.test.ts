import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient, type PreapprovedShiftRuleView } from '../src/api.ts'

afterEach(() => vi.unstubAllGlobals())

const rule: PreapprovedShiftRuleView = {
  id: 'rule/one',
  branchId: 'branch-1',
  driverId: 'driver-1',
  businessDate: '2026-08-27',
  windowStart: '08:30',
  windowEnd: '10:00',
  cashFloat: '12500.00',
  walletTopup: '3000.00',
  active: true,
  consumedByShiftId: null,
  consumedAt: null,
  authorizedBy: 'manager-1',
  createdAt: '2026-08-24T10:00:00.000Z',
}

it('lists, creates, and deletes pre-approved rules in the selected branch', async () => {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(json({ rules: [rule] }))
    .mockResolvedValueOnce(json({ rules: [rule] }))
    .mockResolvedValueOnce(json({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)

  const api = new ApiClient('/api')
  api.setBranch('branch-1')
  const body = {
    driverId: 'driver-1',
    dates: ['2026-08-27', '2026-08-29'],
    windowStart: '08:30',
    windowEnd: '10:00',
    cashFloat: '12500.00',
    walletTopup: '3000.00',
  }

  await expect(api.preapprovedShiftRules()).resolves.toEqual({ rules: [rule] })
  await expect(api.createPreapprovedShiftRules(body)).resolves.toEqual({ rules: [rule] })
  await expect(api.deletePreapprovedShiftRule('rule/one')).resolves.toEqual({ ok: true })

  expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/preapproved-shift-rules?branchId=branch-1', {
    method: 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  })
  expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/preapproved-shift-rules', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, branchId: 'branch-1' }),
  })
  expect(fetchMock).toHaveBeenNthCalledWith(
    3,
    '/api/preapproved-shift-rules/rule%2Fone?branchId=branch-1',
    {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    },
  )
})

