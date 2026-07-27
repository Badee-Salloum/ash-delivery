import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card } from '../ui.tsx'

/**
 * The approval queue — shifts awaiting a manager, newest first, driven off the notification bell
 * so the same events that ring the bell populate the list. Selecting one opens the C-7 review.
 */
export function Queue({ onOpen }: { onOpen(shiftId: string): void }): ReactNode {
  const { api, t } = useApp()
  const [items, setItems] = useState<Array<{ shiftId: string; kind: string; businessDate: string }>>([])

  const load = (): void => {
    void api
      .notifications()
      .then((n) =>
        setItems(
          n.notifications
            .filter((x) => x.kind.startsWith('shift_awaiting'))
            .map((x) => ({
              shiftId: String(x.payload.shiftId),
              kind: x.kind,
              businessDate: String(x.payload.businessDate ?? ''),
            })),
        ),
      )
      .catch(() => setItems([]))
  }
  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (items.length === 0) {
    return (
      <Card>
        <p className="py-8 text-center text-slate-400">{t.approval.queue}: —</p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <Card key={item.shiftId} className="flex items-center gap-3">
          <Badge tone={item.kind.includes('close') ? 'amber' : 'sky'}>
            {item.kind.includes('close') ? t.shift.states.pending_review : t.shift.states.awaiting_open_approval}
          </Badge>
          <span className="num text-sm text-slate-500">{item.businessDate}</span>
          <Button variant="ghost" className="ms-auto inline-flex items-center gap-1.5" onClick={() => onOpen(item.shiftId)}>
            {t.approval.review}
            {/* Forward chevron — points inline-end, mirrored in RTL. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="rtl:-scale-x-100">
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
        </Card>
      ))}
    </div>
  )
}
