import {describe,expect,it} from 'vitest'
import {motorSchedulePreview} from './screens/CompanyMotorPayments.tsx'
describe('motor schedule preview uses exact money and future dates',()=>{
  it('shows exact final partial installment and anchored month day',()=>{
    expect(motorSchedulePreview('320.00',{installmentAmount:'150.00',firstDueOn:'2027-01-31',recurrence:'monthly'})).toEqual({count:3,lastAmount:'20.00',lastDueOn:'2027-03-31'})
  })
  it('shows weekly and custom-day schedules without an ambient browser clock',()=>{
    expect(motorSchedulePreview('400.00',{installmentAmount:'100.00',firstDueOn:'2027-01-01',recurrence:'weekly'})).toEqual({count:4,lastAmount:'100.00',lastDueOn:'2027-01-22'})
    expect(motorSchedulePreview('400.00',{installmentAmount:'100.00',firstDueOn:'2027-01-01',recurrence:'every_n_days',intervalDays:'10'})?.lastDueOn).toBe('2027-01-31')
  })
  it('rejects zero, unknown balance, impossible dates and excessive plans without guessing',()=>{
    const values={installmentAmount:'100.00',firstDueOn:'2027-01-01',recurrence:'monthly'}
    expect(motorSchedulePreview(null,values)).toBeNull()
    expect(motorSchedulePreview('200.00',{...values,installmentAmount:'0.00'})).toBeNull()
    expect(motorSchedulePreview('200.00',{...values,firstDueOn:'2027-02-30'})).toBeNull()
    expect(motorSchedulePreview('700.00',{...values,installmentAmount:'0.01'})).toBeNull()
  })
})
