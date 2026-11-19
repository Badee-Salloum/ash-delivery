import type {
  CompanyHistoricalDraft, CompanyHistoricalDraftIdentity, CompanyHistoricalDraftRepo, CompanyHistoricalDraftRevision,
} from '@ash/contracts'

const conflict = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

export class MemoryCompanyHistoricalDraftRepo implements CompanyHistoricalDraftRepo {
  readonly identities = new Map<string, CompanyHistoricalDraftIdentity>()
  readonly revisions = new Map<string, CompanyHistoricalDraftRevision[]>()

  snapshot() { return structuredClone({ identities: this.identities, revisions: this.revisions }) }
  restore(snapshot: ReturnType<MemoryCompanyHistoricalDraftRepo['snapshot']>): void {
    this.identities.clear(); this.revisions.clear()
    for (const [id, value] of snapshot.identities) this.identities.set(id, structuredClone(value))
    for (const [id, value] of snapshot.revisions) this.revisions.set(id, structuredClone(value))
  }

  async get(id: string): Promise<CompanyHistoricalDraft | null> {
    const identity = this.identities.get(id.toLowerCase())
    const revisions = this.revisions.get(id.toLowerCase()) ?? []
    const current = revisions.at(-1)
    return identity && current ? structuredClone({ ...identity, version: current.version, updatedBy: current.actorId,
      updatedAtMs: current.createdAtMs, payload: current.payload, revisions }) : null
  }
  async list(companyBranchId: string): Promise<CompanyHistoricalDraft[]> {
    const drafts = await Promise.all([...this.identities.values()].filter(row => row.companyBranchId === companyBranchId).map(row => this.get(row.id)))
    return drafts.filter((draft): draft is CompanyHistoricalDraft => draft !== null)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
  }
  async getByRequest(requestId: string): Promise<CompanyHistoricalDraftRevision | null> {
    return structuredClone(this.findRequest(requestId))
  }
  private findRequest(requestId: string): CompanyHistoricalDraftRevision | null {
    return [...this.revisions.values()].flat().find(row => row.requestId.toLowerCase() === requestId.toLowerCase()) ?? null
  }
  async create(identity: CompanyHistoricalDraftIdentity, revision: CompanyHistoricalDraftRevision): Promise<void> {
    if (this.identities.has(identity.id.toLowerCase())) throw conflict('HISTORICAL_DRAFT_ID_CONFLICT')
    if (revision.draftId !== identity.id || revision.version !== 1 || revision.expectedVersion !== 0) throw conflict('HISTORICAL_DRAFT_VERSION_CONFLICT')
    if (this.findRequest(revision.requestId)) throw conflict('HISTORICAL_DRAFT_REQUEST_CONFLICT')
    this.identities.set(identity.id.toLowerCase(), structuredClone(identity))
    this.revisions.set(identity.id.toLowerCase(), [structuredClone(revision)])
  }
  async append(revision: CompanyHistoricalDraftRevision, expectedVersion: number): Promise<void> {
    const revisions = this.revisions.get(revision.draftId.toLowerCase())
    if (!revisions || revisions.at(-1)?.version !== expectedVersion || revision.expectedVersion !== expectedVersion || revision.version !== expectedVersion + 1) {
      throw conflict('HISTORICAL_DRAFT_VERSION_CONFLICT')
    }
    if (this.findRequest(revision.requestId)) throw conflict('HISTORICAL_DRAFT_REQUEST_CONFLICT')
    this.revisions.set(revision.draftId.toLowerCase(), [...revisions, structuredClone(revision)])
  }
}
