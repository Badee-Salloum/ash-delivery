/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ar, en } from '@ash/client/i18n'

const screen = readFileSync(new URL('./screens/CompanyFund.tsx', import.meta.url), 'utf8')
const client = readFileSync(new URL('../../../packages/client/src/api.ts', import.meta.url), 'utf8')

describe('vehicle creation from company assets', () => {
  it('offers the compact creator only inside the vehicle asset choice', () => {
    expect(screen).toContain("kind === 'vehicle' ? (")
    expect(screen).toContain('t.companyFinance.addNewVehicle')
    expect(screen).toContain('showVehicleCreator ? <AssetVehicleCreator')
    expect(screen).toContain('t.companyFinance.vehicleOnlyHint')
  })

  it('loads active types, previews the server number, and creates no batteries', () => {
    expect(screen).toContain('api.vehicleTypes()')
    expect(screen).toContain('vehicleTypes.filter((type) => type.active)')
    expect(screen).toContain('api.nextVehicleNumber(typeId)')
    expect(screen).toContain('api.createVehicle({')
    expect(screen).not.toContain('api.createBattery(')
  })

  it('selects the created vehicle without automatically recording the asset', () => {
    expect(screen).toContain('onCreated({ id: vehicle.id, code: vehicle.code, groundNo: vehicle.groundNo })')
    expect(screen).toContain('setVehicleId(vehicle.id)')
    expect(screen).toContain("api.post('/company/assets'")
    expect(screen.indexOf('api.createVehicle({')).toBeLessThan(screen.indexOf("api.post('/company/assets'"))
    expect(client).toContain('groundNo: string | null')
  })

  it('clears branch-specific vehicle state and reloads the picker when the branch changes', () => {
    expect(screen).toContain('}, [api, branchId, month, today])')
    expect(screen).toContain("setVehicleId('')")
    expect(screen).toContain('setCreatedVehicles([])')
    expect(screen).toContain('}, [branchId])')
  })

  it('has complete Arabic and English guidance for the two-step flow', () => {
    for (const catalog of [ar, en]) {
      expect(catalog.companyFinance.addNewVehicle.length).toBeGreaterThan(3)
      expect(catalog.companyFinance.vehicleOnlyHint.length).toBeGreaterThan(10)
      expect(catalog.companyFinance.vehicleCreatedAndSelected.length).toBeGreaterThan(10)
    }
  })
})
