import type { ReactNode } from 'react'

export function SectionHeading({
  title,
  subtitle,
  action,
  id,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  id?: string
}): ReactNode {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 pt-2">
      <div>
        <h2 id={id} className="text-title font-bold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-label text-ink-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}
