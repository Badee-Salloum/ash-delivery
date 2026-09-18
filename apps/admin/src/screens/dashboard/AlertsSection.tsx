import type { ReactNode } from 'react'
import { useApp } from '../../app-context.tsx'
import { explainError } from '../../errors.ts'
import { Badge, Card, Pending } from '../../ui.tsx'
import { SectionHeading } from './SectionHeading.tsx'
import type { ExpiringDocument } from './types.ts'
import { useDashboardRead } from './use-dashboard-read.ts'

const statusTone: Record<string, 'warning' | 'danger' | 'success' | 'neutral'> = {
  expiring_soon: 'warning',
  expires_today: 'danger',
  expired: 'danger',
  valid: 'success',
  no_expiry: 'neutral',
}

export function AlertsSection(): ReactNode {
  const { t } = useApp()
  const { data, error, retry } = useDashboardRead<{ documents: ExpiringDocument[] }>('/documents/expiring')
  return (
    <section className="flex flex-col gap-3" aria-labelledby="dashboard-alerts">
      <SectionHeading title={t.dashboard.alertsTitle} />
      {data === null ? (
        <Pending
          error={error}
          loadingLabel={t.common.loading}
          errorLabel={explainError(error, t)}
          onRetry={retry}
          retryLabel={t.common.retry}
        />
      ) : (
        <Card title={t.dashboard.expiringDocuments}>
          {data.documents.length === 0 ? (
            <p id="dashboard-alerts" className="text-body text-ink-muted">{t.dashboard.noExpiring}</p>
          ) : (
            <ul id="dashboard-alerts" className="flex flex-col gap-2">
              {data.documents.map((document) => (
                <li key={document.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle pb-2 last:border-0 last:pb-0">
                  <span>
                    <span className="font-medium text-ink">{document.ownerName ?? t.fleet.ownerKinds[document.ownerKind]}</span>
                    <span className="text-ink-muted"> · {t.fleet.docKinds[document.kind as keyof typeof t.fleet.docKinds] ?? document.kind}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num text-label text-ink-muted">{document.expiresOn ?? '—'}</span>
                    <Badge tone={statusTone[document.status] ?? 'neutral'}>
                      {t.fleet.docStatus[document.status as keyof typeof t.fleet.docStatus] ?? document.status}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </section>
  )
}
