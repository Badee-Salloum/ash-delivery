import { createHash } from 'node:crypto'
import type { CloseDraftData } from '@ash/contracts'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
}

/** Stable across PostgreSQL jsonb key reordering. */
export function closeDraftHash(data: CloseDraftData): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex')
}

/** Compare evidence generations by value, never by JSON object key insertion order. */
export function sameCloseDraftEvidence(
  left: CloseDraftData['evidence'],
  right: CloseDraftData['evidence'],
): boolean {
  const slots = Object.keys(left)
  return slots.length === Object.keys(right).length && slots.every((slot) => {
    const a = left[slot]
    const b = right[slot]
    return a !== undefined && b !== undefined &&
      a.mediaId === b.mediaId &&
      a.attachmentToken === b.attachmentToken &&
      a.attachedAtMs === b.attachedAtMs
  })
}
