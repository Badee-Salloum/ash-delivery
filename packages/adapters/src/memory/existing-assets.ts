import type {
  ExistingAssetEventRecord,
  ExistingAssetEvidenceRecord,
  ExistingAssetRecord,
  ExistingAssetRepo,
  ExistingAssetPaymentEvent,
} from '@ash/contracts'

interface State {
  cards: ExistingAssetRecord[]
  events: ExistingAssetEventRecord[]
  evidence: ExistingAssetEvidenceRecord[]
  payments: ExistingAssetPaymentEvent[]
}

const clone = <T>(value: T): T => structuredClone(value)
const conflict = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

export class MemoryExistingAssetRepo implements ExistingAssetRepo {
  private state: State = { cards: [], events: [], evidence: [], payments: [] }
  snapshot(): State { return clone(this.state) }
  restore(state: State): void { this.state = clone(state) }

  async paymentEvents(branchId: string): Promise<ExistingAssetPaymentEvent[]> {
    return clone(this.state.payments.filter(row => row.branchId === branchId))
  }
  async addPaymentEvent(row: ExistingAssetPaymentEvent): Promise<void> {
    if (this.state.payments.some(event => event.id === row.id)) throw conflict('EXISTING_ASSET_PAYMENT_DUPLICATE')
    if (!this.state.cards.some(card => card.id === row.assetId && card.branchId === row.branchId)) throw conflict('EXISTING_ASSET_NOT_FOUND')
    if (row.version !== this.state.payments.filter(event => event.assetId === row.assetId).length + 1) throw conflict('EXISTING_ASSET_VERSION_CONFLICT')
    this.state.payments.push(clone(row))
  }

  async get(id: string): Promise<ExistingAssetRecord | null> {
    return clone(this.state.cards.find((row) => row.id === id) ?? null)
  }
  async getByVehicle(vehicleId: string): Promise<ExistingAssetRecord | null> {
    return clone(this.state.cards.find((row) => row.vehicleId === vehicleId && row.status !== 'sold') ?? null)
  }
  async list(companyBranchId: string): Promise<ExistingAssetRecord[]> {
    return clone(this.state.cards.filter((row) => row.branchId === companyBranchId))
  }
  async getEvent(id: string): Promise<ExistingAssetEventRecord | null> {
    return clone(this.state.events.find((row) => row.id === id) ?? null)
  }
  async listEvents(assetId: string): Promise<ExistingAssetEventRecord[]> {
    return clone(this.state.events.filter((row) => row.assetId === assetId))
  }
  async apply(event: ExistingAssetEventRecord): Promise<void> {
    if (this.state.events.some((row) => row.id === event.id)) throw conflict('EXISTING_ASSET_REQUEST_DUPLICATE')
    const index = this.state.cards.findIndex((row) => row.id === event.assetId)
    const prior = index === -1 ? null : this.state.cards[index]!
    if ((prior?.version ?? 0) !== event.expectedVersion || event.version !== event.expectedVersion + 1 ||
      event.snapshot.version !== event.version || event.snapshot.id !== event.assetId ||
      event.snapshot.branchId !== event.branchId || event.snapshot.updatedBy !== event.createdBy ||
      (prior === null) !== (event.kind === 'register')) throw conflict('EXISTING_ASSET_VERSION_CONFLICT')
    if (event.snapshot.status !== 'sold' && this.state.cards.some((row) =>
      row.id !== event.assetId && row.vehicleId === event.snapshot.vehicleId && row.status !== 'sold')) {
      throw conflict('EXISTING_ASSET_VEHICLE_DUPLICATE')
    }
    if (event.snapshot.sale?.status === 'confirmed' && event.snapshot.sale.receiptEntryId !== null && this.state.cards.some(row => row.id !== event.assetId && row.sale?.status === 'confirmed' && row.sale.receiptEntryId === event.snapshot.sale!.receiptEntryId)) {
      throw conflict('EXISTING_ASSET_SALE_RECEIPT_DUPLICATE')
    }
    this.state.events.push(clone(event))
    if (index === -1) this.state.cards.push(clone(event.snapshot))
    else this.state.cards[index] = clone(event.snapshot)
  }
  async listEvidence(assetId: string): Promise<ExistingAssetEvidenceRecord[]> {
    return clone(this.state.evidence.filter((row) => row.assetId === assetId))
  }
  async addEvidence(row: ExistingAssetEvidenceRecord): Promise<void> {
    if (this.state.evidence.some((stored) => stored.id === row.id)) throw conflict('EXISTING_ASSET_EVIDENCE_DUPLICATE')
    if (!this.state.cards.some((card) => card.id === row.assetId)) throw conflict('EXISTING_ASSET_NOT_FOUND')
    this.state.evidence.push(clone(row))
  }
  async linkedToOperation(operationId: string, journalEntryId: number): Promise<ExistingAssetRecord[]> {
    const linked = new Set(this.state.evidence.filter((row) =>
      row.operationId === operationId || row.journalEntryId === journalEntryId).map((row) => row.assetId))
    return clone(this.state.cards.filter((row) => linked.has(row.id) ||
      row.recognition?.journalEntryId === journalEntryId || row.sale?.receiptEntryId === journalEntryId ||
      row.sale?.disposalEntryId === journalEntryId))
  }
}
