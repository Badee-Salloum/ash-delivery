import { describe, expect, it } from 'vitest'
import { compareDailySummary, suggestDailySummaryDate } from '../src/daily-summary.ts'
import {readFileSync} from 'node:fs'
const dailySummaryFixtures = JSON.parse(readFileSync(new URL('../../../test-fixtures/daily-summary.json',import.meta.url),'utf8')) as Array<{
  id:string;name:string;fields:Record<string,string>;orders:Array<{fee:string;occurredDate:string;included:boolean}>
}>

const date = '2026-10-31'
const orders = [{included:true, fee:'100.00', occurredDate:date}, {included:true, fee:'200.00', occurredDate:date}]

describe('optional daily screenshot comparison', () => {
  it('compares gross independently of the blue earnings', () => {
    const report = compareDailySummary({grossTotal:'300.00', blueTotal:'240', trips:'2'}, date, orders)
    expect(report.difference).toBe('0.00')
    expect(report.countDifference).toBe(0)
  })
  it('retains a difference as reference data', () => {
    expect(compareDailySummary({grossTotal:'250', trips:'1'}, date, orders)).toMatchObject({difference:'-50.00', countDifference:-1})
  })
  it('never derives a missing gross value from blue earnings', () => {
    expect(compareDailySummary({blueTotal:'240'}, date, orders).grossTotal).toBeNull()
  })
  it('does not assert a match when the date is unknown', () => {
    expect(compareDailySummary({grossTotal:'300'}, null, orders)).toMatchObject({difference:null, partial:true})
  })
  it('keeps undated orders explicit', () => {
    expect(compareDailySummary({grossTotal:'300'}, date, [{included:true,fee:'300',occurredDate:null}]).partial).toBe(true)
  })
  it('compares a calendar subset across the midnight boundary', () => {
    const report = compareDailySummary({grossTotal:'300',trips:'2'}, date, [...orders,{included:true,fee:'160',occurredDate:'2026-11-01'}])
    expect(report.difference).toBe('0.00')
    expect(report.orderCount).toBe(2)
    expect(report).toMatchObject({partial:true,status:'partial',outsideOrderCount:1})
  })
  it('accepts Arabic digits and preserves exact minor units', () => {
    expect(compareDailySummary({grossTotal:'٣٠٠٫٠١'}, date, orders).difference).toBe('0.01')
  })
  it('does not silently count unknown fees or impossible dates as a match', () => {
    expect(compareDailySummary({grossTotal:'0',trips:'1'}, date, [{fee:'invalid',occurredDate:date}]))
      .toMatchObject({status:'incomplete',difference:null,orderTotal:null,invalidFeeCount:1})
    expect(compareDailySummary({grossTotal:'0',trips:'0'}, '2026-02-30', []))
      .toMatchObject({status:'date_required',difference:null,orderCount:null})
    expect(compareDailySummary({grossTotal:'300'}, date, orders)).toMatchObject({status:'incomplete',partial:true})
  })
  it('leaves missing dates unconfirmed and suggests from dated orders, not the upload clock', () => {
    expect(suggestDailySummaryDate(orders,'2026-11-05')).toBe(date)
    expect(suggestDailySummaryDate([...orders,{fee:'1',occurredDate:'2026-11-01'}],date)).toBe(date)
    expect(suggestDailySummaryDate([],null)).toBeNull()
  })
  it.each(dailySummaryFixtures)('keeps all five verified image fields unchanged: $name', fixture => {
    const result=compareDailySummary(fixture.fields,'2026-11-04',fixture.orders)
    expect(result.blueTotal).toBe(fixture.fields.blueTotal)
    expect(result.grossTotal).toBe(fixture.fields.grossTotal)
    expect(result.trips).toBe(Number(fixture.fields.trips))
    expect(result.distanceKm).toBe(fixture.fields.distanceKm)
    expect(result.onlineMinutes).toBe(fixture.fields.onlineMinutes)
    const mismatch=fixture.id==='gross-mismatch',partial=fixture.id==='calendar-subset'
    expect(result.difference).toBe(mismatch?'390.00':partial?'515.00':'0.00')
    expect(result.countDifference).toBe(mismatch||partial?2:0)
    expect(result.status).toBe(mismatch?'difference':partial?'partial':'match')
  })
})
