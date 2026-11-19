import type {
  CompanyRestorationProposal,
  CompanyRestorationReviewRepo,
  CompanyRestorationReviewRevision,
} from '@ash/contracts'

export class MemoryCompanyRestorationReviewRepo implements CompanyRestorationReviewRepo {
  private readonly proposals: CompanyRestorationProposal[] = []
  private readonly revisions: CompanyRestorationReviewRevision[] = []

  snapshot() { return structuredClone({ proposals: this.proposals, revisions: this.revisions }) }
  restore(value: ReturnType<MemoryCompanyRestorationReviewRepo['snapshot']>): void {
    this.proposals.splice(0, this.proposals.length, ...structuredClone(value.proposals))
    this.revisions.splice(0, this.revisions.length, ...structuredClone(value.revisions))
  }
  async get(id: string) { return structuredClone(this.proposals.find((row) => row.id === id) ?? null) }
  async getByRestoration(restorationId: number) {
    return structuredClone(this.proposals.find((row) => row.restorationId === restorationId) ?? null)
  }
  async getBySource(sourceEntryId: number) {
    return structuredClone(this.proposals.find((row) => row.legs.some((leg) => leg.sourceEntryId === sourceEntryId)) ?? null)
  }
  async list(companyBranchId: string, branchId?: string) {
    return structuredClone(this.proposals.filter((row) => row.companyBranchId === companyBranchId &&
      (branchId === undefined || row.branchId === branchId)))
  }
  async create(row: CompanyRestorationProposal): Promise<void> {
    if (this.proposals.some((prior) => prior.id === row.id || prior.restorationId === row.restorationId ||
      prior.legs.some((leg) => row.legs.some((candidate) => candidate.sourceEntryId === leg.sourceEntryId)))) {
      throw Object.assign(new Error('duplicate restoration proposal'), { code: 'DUPLICATE_RESTORATION_PROPOSAL' })
    }
    this.proposals.push(structuredClone(row))
  }
  async getRevision(id: string) { return structuredClone(this.revisions.find((row) => row.id === id) ?? null) }
  async listRevisions(proposalId: string) {
    return structuredClone(this.revisions.filter((row) => row.proposalId === proposalId).sort((a, b) => a.version - b.version))
  }
  async appendRevision(row: CompanyRestorationReviewRevision): Promise<void> {
    if (this.revisions.some((prior) => prior.id === row.id) ||
      row.version !== this.revisions.filter((prior) => prior.proposalId === row.proposalId).length + 1) {
      throw Object.assign(new Error('restoration review version conflict'), { code: 'RESTORATION_REVIEW_VERSION_CONFLICT' })
    }
    if (!this.proposals.some((prior) => prior.id === row.proposalId)) throw new Error('unknown proposal')
    this.revisions.push(structuredClone(row))
  }
}
