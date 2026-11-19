/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'
import { parseHash } from './route.ts'
import { availableExistingAssetVehicles, existingAssetVehicleAccountHash } from './screens/CompanyExistingAssets.tsx'

const screen = readFileSync(new URL('./screens/CompanyExistingAssets.tsx', import.meta.url), 'utf8')
const shared = readFileSync(new URL('./screens/CompanyFinanceReview.tsx', import.meta.url), 'utf8')

describe('neutral existing motor assets UI', () => {
  it('uses the actual vehicle-account route identity instead of a report filter', () => {
    expect(parseHash(existingAssetVehicleAccountHash('vehicle-1'))).toEqual({ section: 'vehicle', openShift: null, params: { id: 'vehicle-1' } })
    expect(screen).not.toContain('#vehicle?vehicle=')
  })
  it('does not offer already-linked vehicles for a second registration, but retains the edited card vehicle', () => {
    const base = { branchId: 'branch-1', code: '1-1-1-1', groundNo: null, plateNo: null }
    const vehicles = [{ ...base, id: 'vehicle-1', assetId: null }, { ...base, id: 'vehicle-2', assetId: 'asset-2' }]
    expect(availableExistingAssetVehicles(vehicles).map(vehicle => vehicle.id)).toEqual(['vehicle-1'])
    expect(availableExistingAssetVehicles(vehicles, 'vehicle-2').map(vehicle => vehicle.id)).toEqual(['vehicle-1', 'vehicle-2'])
  })
  it('keeps simple registration separate from advanced source links and no actual cash or sale posting', () => {
    const create = screen.slice(screen.indexOf('const fields:'), screen.indexOf('<Card title={t.companyFinance.assetsTitle}'))
    expect(create).not.toContain('journalEntryId')
    expect(create).not.toContain('paidNow')
    expect(create).not.toContain('usefulMonths')
    expect(create).toContain('<MotorRegistration')
    expect(screen).toContain('card.pendingEdit')
    expect(screen).toContain('a.pendingEditHint')
    expect(screen).toContain('r.saleDraftHint')
    expect(screen).toContain('a.confirmSaleHint')
    expect(screen).toContain('key: \'startsOn\', label: r.startsOn, type: \'date\', value: session?.businessDate')
    expect(screen).not.toContain("{ key: 'accumulatedDepreciation'")
    expect(shared).toContain("export { ExistingAssetsPanel } from './CompanyExistingAssets.tsx'")
  })
  it('keeps accounting and disposal limitations in both complete language catalogues', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.existingAssetReview.noAvailable.length).toBeGreaterThan(15)
      expect(catalog.existingAssetReview.recognitionHint.length).toBeGreaterThan(30)
      expect(catalog.existingAssetReview.confirmSaleHint.length).toBeGreaterThan(30)
      expect(catalog.existingAssetReview.pendingEditHint.length).toBeGreaterThan(30)
    }
  })
})
