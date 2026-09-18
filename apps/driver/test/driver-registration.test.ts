import { describe, expect, it } from 'vitest'
import { validateDriverRegistration } from '../src/screens/Register.tsx'

const valid = {
  fullNameAr: 'سائق جديد',
  branchId: 'branch-damascus',
  username: 'newdriver',
  password: 'password8',
  confirmation: 'password8',
}

describe('driver registration form validation', () => {
  it('requires every displayed field', () => {
    expect(validateDriverRegistration({ ...valid, branchId: '' })).toBe('required')
    expect(validateDriverRegistration({ ...valid, fullNameAr: '   ' })).toBe('required')
  })

  it('validates normalized username length and password bounds', () => {
    expect(validateDriverRegistration({ ...valid, username: '\u0650ab\u200f' })).toBe('invalid_username')
    expect(validateDriverRegistration({ ...valid, password: '1234567', confirmation: '1234567' })).toBe('short_password')
  })

  it('keeps password confirmation local and requires it to match', () => {
    expect(validateDriverRegistration({ ...valid, confirmation: 'different8' })).toBe('password_mismatch')
    expect(validateDriverRegistration(valid)).toBeNull()
  })
})
