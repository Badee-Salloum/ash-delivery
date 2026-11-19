import { type ReactNode, useState } from 'react'
import type { DateRange } from '@ash/domain'
import { useApp } from '../../app-context.tsx'
import { Button } from '../../ui.tsx'
import { CompanyOwnerPanel } from '../CompanyFinanceReview.tsx'

/** All history by default; the owner panel alone owns filters after this optional shortcut. */
export function OwnerFundingSection({ range, asOf }: { range: DateRange | null; asOf?: string }): ReactNode {
  const { t } = useApp()
  const [appliedRange, setAppliedRange] = useState<DateRange | null>(null)
  const [revision, setRevision] = useState(0)
  return <section className="flex flex-col gap-3" aria-label={t.financeReview.ownerTitle}>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={range === null} onClick={() => { if (range) { setAppliedRange({ ...range }); setRevision(value => value + 1) } }}>{t.dashboard.selectedPeriod}</Button>
    </div>
    {appliedRange ? <CompanyOwnerPanel key={`owner-period:${revision}`} from={appliedRange.from} to={appliedRange.to} /> : <CompanyOwnerPanel key={`all-owner-history:${asOf ?? ''}`} {...(asOf === undefined ? {} : { to: asOf })} />}
  </section>
}
