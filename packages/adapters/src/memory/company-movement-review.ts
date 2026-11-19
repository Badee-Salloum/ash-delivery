import type {
  CompanyHistoricalIntakeSession,
  CompanyMovementCorrection,
  CompanyMovementMetadata,
  CompanyMovementReviewRepo,
  CompanyHistoricalSourceCorrection,
} from '@ash/contracts'

const conflict = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

export class MemoryCompanyMovementReviewRepo implements CompanyMovementReviewRepo {
  readonly metadata = new Map<string, CompanyMovementMetadata>()
  readonly intakeSessions = new Map<string, CompanyHistoricalIntakeSession>()
  readonly corrections = new Map<string, CompanyMovementCorrection[]>()
  readonly sourceCorrections = new Map<string, CompanyHistoricalSourceCorrection>()

  snapshot() {
    return structuredClone({ metadata: this.metadata, intakeSessions: this.intakeSessions, corrections: this.corrections, sourceCorrections: this.sourceCorrections })
  }

  restore(snapshot: ReturnType<MemoryCompanyMovementReviewRepo['snapshot']>): void {
    for (const [target, source] of [
      [this.metadata, snapshot.metadata], [this.intakeSessions, snapshot.intakeSessions],
      [this.corrections, snapshot.corrections],
      [this.sourceCorrections, snapshot.sourceCorrections],
    ] as const) {
      const map = target as Map<string, unknown>
      map.clear()
      for (const [id, value] of source as Map<string, unknown>) map.set(id, structuredClone(value))
    }
  }

  async findMetadata(commandId: string): Promise<CompanyMovementMetadata | null> {
    return structuredClone(this.metadata.get(commandId.toLowerCase()) ?? null)
  }
  async listMetadata(branchId: string): Promise<CompanyMovementMetadata[]> {
    return structuredClone([...this.metadata.values()].filter((row) => row.branchId === branchId))
  }
  async createMetadata(row: CompanyMovementMetadata): Promise<void> {
    if (this.metadata.has(row.commandId.toLowerCase())) throw conflict('DUPLICATE_MOVEMENT_METADATA')
    this.metadata.set(row.commandId.toLowerCase(), structuredClone(row))
  }
  async getIntakeSession(id: string): Promise<CompanyHistoricalIntakeSession | null> {
    return structuredClone(this.intakeSessions.get(id.toLowerCase()) ?? null)
  }
  async listIntakeSessions(branchId: string): Promise<CompanyHistoricalIntakeSession[]> {
    return structuredClone([...this.intakeSessions.values()].filter((row) => row.branchId === branchId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs))
  }
  async createIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void> {
    if (this.intakeSessions.has(row.id.toLowerCase())) throw conflict('DUPLICATE_INTAKE_SESSION')
    this.intakeSessions.set(row.id.toLowerCase(), structuredClone(row))
  }
  async closeIntakeSession(row: CompanyHistoricalIntakeSession): Promise<void> {
    const prior = this.intakeSessions.get(row.id.toLowerCase())
    if (!prior || prior.closedAtMs !== null) throw conflict('INTAKE_SESSION_CLOSED')
    this.intakeSessions.set(row.id.toLowerCase(), structuredClone(row))
  }
  async getCorrection(id: string): Promise<CompanyMovementCorrection | null> {
    return structuredClone(this.corrections.get(id.toLowerCase())?.at(-1) ?? null)
  }
  async getCorrectionByAction(actionId: string): Promise<CompanyMovementCorrection | null> {
    const row = [...this.corrections.values()].flat().find((value) => value.actionId.toLowerCase() === actionId.toLowerCase())
    return structuredClone(row ?? null)
  }
  async listCorrections(branchId: string, targetId?: string): Promise<CompanyMovementCorrection[]> {
    return structuredClone([...this.corrections.values()].flatMap((rows) => rows.at(-1) ?? [])
      .filter((row) => row.branchId === branchId && (targetId === undefined || row.targetId === targetId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)))
  }
  async listCorrectionHistory(id: string): Promise<CompanyMovementCorrection[]> {
    return structuredClone(this.corrections.get(id.toLowerCase()) ?? [])
  }
  async saveCorrection(row: CompanyMovementCorrection, expectedVersion: number): Promise<void> {
    const replacementParent = (await this.listCorrections(row.branchId))
      .find((value) => value.status === 'confirmed' && value.financial && value.replacementId === row.targetId)
    if (replacementParent) throw conflict('CORRECTION_ORIGINAL_TARGET_REQUIRED')
    const prior = await this.getCorrection(row.id)
    if ((prior?.version ?? 0) !== expectedVersion || row.version !== expectedVersion + 1) throw conflict('MOVEMENT_VERSION_CONFLICT')
    if (prior?.status === 'confirmed') throw conflict('CORRECTION_ALREADY_CONFIRMED')
    if (await this.getCorrectionByAction(row.actionId)) throw conflict('MOVEMENT_ACTION_CONFLICT')
    if (row.status === 'confirmed') {
      const confirmed = (await this.listCorrections(row.branchId, row.targetId)).filter((value) => value.status === 'confirmed')
      if (confirmed.length !== row.targetVersion - 1) throw conflict('MOVEMENT_VERSION_CONFLICT')
    }
    this.corrections.set(row.id.toLowerCase(), [...(this.corrections.get(row.id.toLowerCase()) ?? []), structuredClone(row)])
  }
  async listHistoricalSourceCorrections(branchId: string, sourceReference?: string): Promise<CompanyHistoricalSourceCorrection[]> {
    return structuredClone([...this.sourceCorrections.values()].filter(row => row.branchId === branchId &&
      (sourceReference === undefined || row.sourceReference === sourceReference)).sort((a,b) => a.version-b.version))
  }
  async findHistoricalSourceCorrection(id: string): Promise<CompanyHistoricalSourceCorrection | null> {
    return structuredClone(this.sourceCorrections.get(id) ?? null)
  }
  async saveHistoricalSourceCorrection(row: CompanyHistoricalSourceCorrection, expectedVersion: number): Promise<void> {
    if (this.sourceCorrections.has(row.id)) throw conflict('MOVEMENT_ACTION_CONFLICT')
    const history = await this.listHistoricalSourceCorrections(row.branchId, row.sourceReference)
    if (history.length !== expectedVersion - 1 || row.version !== expectedVersion + 1) throw conflict('MOVEMENT_VERSION_CONFLICT')
    this.sourceCorrections.set(row.id, structuredClone(row))
  }
}
