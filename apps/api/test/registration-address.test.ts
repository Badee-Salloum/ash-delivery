import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { normalizeRegistrationAddress, registrationAddress } from '../src/registration-address.ts'

const request = (peer: string, headers: Record<string, string> = {}): FastifyRequest => ({
  headers,
  raw: { socket: { remoteAddress: peer } },
}) as unknown as FastifyRequest

describe('driver registration network identity', () => {
  it('normalizes IPv4 and groups IPv6 privacy addresses by /64', () => {
    expect(normalizeRegistrationAddress('192.0.2.8')).toBe('192.0.2.8/32')
    expect(normalizeRegistrationAddress('2001:db8:abcd:42::1')).toBe('2001:db8:abcd:42::/64')
    expect(normalizeRegistrationAddress('2001:0db8:abcd:0042:ffff::9')).toBe('2001:db8:abcd:42::/64')
    expect(normalizeRegistrationAddress('not-an-address')).toBeNull()
  })

  it('trusts Caddy forwarding only through a private proxy peer', () => {
    expect(registrationAddress(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.8' }), {}))
      .toBe('198.51.100.8/32')
    expect(registrationAddress(request('203.0.113.9', { 'x-forwarded-for': '198.51.100.8' }), {}))
      .toBe('203.0.113.9/32')
  })

  it('uses Vercel-overwritten forwarding only in the Vercel runtime', () => {
    expect(registrationAddress(
      request('203.0.113.9', { 'x-vercel-forwarded-for': '2001:db8:1:2::7' }),
      { VERCEL: '1' },
    )).toBe('2001:db8:1:2::/64')
  })
})
