import type { ReactNode } from 'react'
import { useApp } from '../app-context.tsx'

/**
 * Where a number came from, said out loud.
 *
 * The deliveries list has shown this since the fee rewrite — ◍ read, ◌ refused, ✎ typed — and every
 * other reading in the app hid it. `odoOcr` and `walletOcr` are captured on every shift, shipped to
 * the server as the SRS D-3 baseline, and rendered NOWHERE: a pre-filled OCR odometer and one the
 * driver typed from memory were pixel-identical on his screen.
 *
 * That matters more here than on a delivery. A fee the reader guessed wrong is one row of many; an
 * odometer it guessed wrong is the number the whole shift's distance is measured from — and this
 * reader was measured wrong three times out of three on real shifts.
 *
 * The glyph and the words are lifted from `OperationsList` rather than reinvented, so a driver reads
 * one vocabulary across the whole app.
 */

export type ReadingSource = 'read' | 'refused' | 'typed'

const MARK: Record<ReadingSource, string> = { read: '◍', refused: '◌', typed: '✎' }

/**
 * What produced the value in the field.
 *
 * `refused` is its own answer and not a kind of `typed`: the reader SAW the picture and declined,
 * which is a different fact from nobody having tried — and the difference is exactly what makes the
 * sample worth keeping.
 */
export function sourceOf(input: { ocrValue: unknown; hadImage: boolean; value: string }): ReadingSource | null {
  if (input.value.trim() === '') return null
  if (input.ocrValue !== null && input.ocrValue !== undefined) return 'read'
  return input.hadImage ? 'refused' : 'typed'
}

/** The one-glyph mark, at the lowest visual weight on the row. */
export function SourceMark({ source }: { source: ReadingSource | null }): ReactNode {
  const { t } = useApp()
  if (source === null) return null
  const words =
    source === 'read' ? t.orders.sourceRead : source === 'refused' ? t.orders.sourceRefused : t.orders.sourceTyped
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500">
      <span aria-hidden>{MARK[source]}</span>
      {words}
    </span>
  )
}
