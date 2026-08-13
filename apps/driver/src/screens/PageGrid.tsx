import type { ReactNode } from 'react'
import { MAX_PAGE_SLOTS, pageSlot } from '@ash/domain'
import { useApp } from '../app-context.tsx'
import { PhotoSlot } from './PhotoSlot.tsx'

/**
 * One scrollable Yallago screen, photographed in as many pages as it takes.
 *
 * «الطلبات الحديثة» and «سجل المدفوعات» both scroll, and a day rarely fits in one screenful — so
 * each is 1…8 images that differ only by their page number. As full-width 80px bars that was the
 * single biggest thing on the close screen: a real shift produced six dashboard pages, and with the
 * wallet, the odometer and two BMS shots the driver scrolled past ~1,000px of near-identical grey
 * before reaching a field he came to fill in.
 *
 * A number is all the label these need, so they become a grid — the same move the deliveries list
 * made, and for the same reason.
 */
export function PageGrid({
  title,
  base,
  pages,
  shiftId,
  slots,
  onUploaded,
  onAddPage,
  onImage,
  onDeleted,
  status,
}: {
  title: string
  base: string
  /** How many pages the driver has asked for so far. Always ≥ 1. */
  pages: number
  shiftId: string
  slots: ReadonlySet<string>
  onUploaded(slot: string): void
  onAddPage(): void
  onImage(file: File): void
  /** Remove a page. Offered on every tile in a grid — a surplus page is a real thing to undo. */
  onDeleted(slot: string): void
  /** What this screen's read made of it — one line for the whole set, not per page. */
  status?: ReactNode
}): ReactNode {
  const { t } = useApp()
  const numbers = Array.from({ length: pages }, (_, i) => i + 1)
  const last = pageSlot(base, pages)

  /*
   * The add-tile appears only once the last page actually holds an image. Otherwise one tap adds an
   * empty tile, and a row of empty tiles reads as a longer list of things the driver still owes.
   * It disappears at MAX_PAGE_SLOTS, where there is genuinely nothing more to add.
   */
  const canAdd = slots.has(last) && pages < MAX_PAGE_SLOTS

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {/* Four columns: at 360px the content is 328px, so ~76px cells — well above a 44px target,
          and the six pages a real shift produced fit in two rows with the add-tile beside them. */}
      <div className="grid grid-cols-4 gap-2">
        {numbers.map((n) => {
          const slot = pageSlot(base, n)
          return (
            <PhotoSlot
              key={slot}
              shiftId={shiftId}
              pkg="end"
              slot={slot}
              // The full name is the tile's accessible label; the visible caption is the digit.
              label={`${title} ${n}`}
              badge={String(n)}
              variant="tile"
              uploaded={slots.has(slot)}
              onUploaded={onUploaded}
              onImage={onImage}
              onDelete={onDeleted}
            />
          )
        })}
        {canAdd ? (
          <button
            type="button"
            onClick={onAddPage}
            aria-label={t.shift.addPage}
            className="flex aspect-square items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white text-2xl text-slate-400"
          >
            +
          </button>
        ) : null}
      </div>
      {status}
    </div>
  )
}
