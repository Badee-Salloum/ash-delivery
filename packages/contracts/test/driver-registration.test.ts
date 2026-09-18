import { describe, expect, it } from 'vitest'
import { registerDriverRequest } from '../src/wire.ts'

describe('driver registration contract', () => {
  const valid = {
    fullNameAr: '  أحمد سالم  ',
    branchId: 'branch-damascus',
    username: '\u0650 driver-new \u200f',
    password: 'password8',
  }

  it('normalizes the username and trims the Arabic full name', () => {
    expect(registerDriverRequest.parse(valid)).toEqual({
      ...valid,
      fullNameAr: 'أحمد سالم',
      username: 'driver-new',
    })
  })

  it('enforces username and password bounds', () => {
    expect(registerDriverRequest.safeParse({ ...valid, username: 'ab' }).success).toBe(false)
    expect(registerDriverRequest.safeParse({ ...valid, username: 'x'.repeat(41) }).success).toBe(false)
    expect(registerDriverRequest.safeParse({ ...valid, password: '1234567' }).success).toBe(false)
    expect(registerDriverRequest.safeParse({ ...valid, password: 'x'.repeat(201) }).success).toBe(false)
  })

  it('rejects empty branch identifiers and every privileged extra field', () => {
    expect(registerDriverRequest.safeParse({ ...valid, branchId: '' }).success).toBe(false)
    for (const extra of [
      { roleKey: 'system_admin' },
      { active: false },
      { id: 'chosen-id' },
      { driverId: 'chosen-driver' },
    ]) {
      expect(registerDriverRequest.safeParse({ ...valid, ...extra }).success).toBe(false)
    }
  })
})
