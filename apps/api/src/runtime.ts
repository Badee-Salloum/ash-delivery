import { randomBytes, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Clock, IdGen, PasswordHasher } from '@ash/contracts'

/**
 * Production implementations of the infrastructure ports.
 *
 * These are the only places in the codebase allowed to read the wall clock or draw randomness.
 * Everything above them takes both as values, which is what makes the domain deterministic and
 * every test reproducible.
 */

export class SystemClock implements Clock {
  private readonly offset: number
  constructor(offset: number) {
    this.offset = offset
  }
  nowMs(): number {
    return Date.now()
  }
  offsetMinutes(): number {
    return this.offset
  }
}

export class CryptoIdGen implements IdGen {
  uuid(): string {
    return randomUUID()
  }
  token(): string {
    // 256 bits. Only its sha256 is ever stored, so a database dump yields no usable sessions.
    return randomBytes(32).toString('base64url')
  }
}

/** SRS §7 mandates bcrypt. Cost comes from config so it can be raised without a code change. */
export class BcryptHasher implements PasswordHasher {
  private readonly rounds: number
  constructor(rounds: number) {
    this.rounds = rounds
  }
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds)
  }
  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plain, hash)
    } catch {
      // A malformed stored hash must read as "wrong password", never as a 500 that tells an
      // attacker this account is interesting.
      return false
    }
  }
}
