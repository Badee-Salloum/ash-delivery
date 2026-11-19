import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '@ash/contracts'
import { isCalendarDate } from '@ash/domain'
import { companyReport } from './company-report.service.ts'
import { loadCompanyReportSnapshot } from './company-report-snapshot.ts'
import { ServiceError, todayFor } from './shifts.service.ts'

/** Additive reporting; the legacy movements endpoint and every accounting write remain unchanged. */
export function registerCompanyReportRoutes(app: FastifyInstance, deps: Deps): void {
  const date = z.string().refine(isCalendarDate).refine(value => value >= '2000-01-01')
  const query = z.object({ from: date.optional(), to: date.optional(),
    all: z.literal('true').optional(),
    // Compatibility for older clients: this selector does not change the HQ report scope.
    branchId: z.string().uuid().optional(),
    view: z.enum(['as_booked', 'current_corrected']).default('as_booked'),
    dateBasis: z.enum(['posting', 'occurrence']).default('posting') }).strict()
  app.get('/company/reports', { config: { permission: 'company_fund.manage' } }, async req => {
    const q = query.parse(req.query), today = todayFor(deps)
    const from = q.all === 'true' ? '2000-01-01' : q.from ?? today, to = q.to ?? today
    if (q.all === 'true' && q.from !== undefined) throw new ServiceError(422, 'invalid_date_range')
    if (from > to || to > today) throw new ServiceError(422, 'invalid_date_range')
    const branch = await deps.directory.companyBranch()
    if (!branch) throw new ServiceError(500, 'company_branch_missing')
    return deps.financialUnitOfWork.run({ mode: 'read_snapshot', lockKey: `receivables:${branch.id}`, actorId: req.actor!.userId, requestId: req.requestId }, async tx => {
      return companyReport(await loadCompanyReportSnapshot(tx, branch.id, today),
        { from, to, view: q.view, dateBasis: q.dateBasis, generatedAtMs: deps.clock.nowMs(), all: q.all === 'true' })
    })
  })
}
