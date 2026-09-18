import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'

const firstAddress = (value: string | string[] | undefined): string | null => {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || null
}

const embeddedIpv4 = (address: string): string | null => {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return match?.[1] && isIP(match[1]) === 4 ? match[1] : null
}

/** Coarsen IPv6 to /64 before hashing so privacy addresses cannot evade the hourly budget. */
export function normalizeRegistrationAddress(raw: string): string | null {
  let address = raw.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const mapped = embeddedIpv4(address)
  if (mapped) address = mapped
  if (isIP(address) === 4) return `${address.split('.').map(Number).join('.')}/32`
  if (isIP(address) !== 6) return null

  const halves = address.toLowerCase().split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
    : left
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group || '0', 16).toString(16))
  return `${prefix.join(':')}::/64`
}

function isPrivateProxyAddress(raw: string): boolean {
  const mapped = embeddedIpv4(raw)
  const address = mapped ?? raw.split('%')[0]!
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
  }
  if (isIP(address) !== 6) return false
  const value = address.toLowerCase()
  if (value === '::1') return true
  const first = Number.parseInt(value.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

export function registrationAddress(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env): string {
  const peer = req.raw.socket.remoteAddress ?? ''
  let selected = peer
  if (env.VERCEL === '1') {
    selected = firstAddress(req.headers['x-vercel-forwarded-for'])
      ?? firstAddress(req.headers['x-forwarded-for'])
      ?? peer
  } else if (isPrivateProxyAddress(peer)) {
    // Caddy overwrites X-Forwarded-For. Only a private/loopback socket peer is allowed to speak
    // for it; a public direct client cannot choose its own throttle identity with a spoofed header.
    selected = firstAddress(req.headers['x-forwarded-for']) ?? peer
  }
  return normalizeRegistrationAddress(selected) ?? 'unknown/0'
}

export const registrationAddressHash = (address: string): string =>
  createHash('sha256').update(address).digest('hex')
