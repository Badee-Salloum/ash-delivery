/**
 * The typed API client.
 *
 * A thin wrapper over `fetch` that both front-ends share. Same-origin (Caddy proxies `/api` to
 * the API on the same host), so the session cookie rides along with `credentials: 'include'` and
 * there is no token to store in JS — which is the whole reason sessions are httpOnly cookies.
 *
 * Money crosses as decimal strings, never numbers (see the wire schemas). This client never
 * coerces a money field to a Number.
 */

export interface ApiError {
  status: number
  error: string
  detail?: unknown
}

/** Server-derived position of one provider operation relative to the shift's canonical window. */
export type OperationWindowStatus = import('@ash/contracts').OperationWindowStatus

/** The persisted, driver-owned closing draft. It is the only source used by the new close flow. */
export type CloseDraftReadFailure =
  | 'unavailable'
  | 'timeout'
  | 'no_fields'
  | 'refused'
  | 'wrong_screen'
  | 'read_budget_exhausted'

export type CloseDraftReadStatus = 'idle' | 'running' | 'complete' | 'failed'

export interface CloseDraftAttachmentRead {
  readId: string
  status: CloseDraftReadStatus
  field: CloudOcrField
  failure: CloseDraftReadFailure | null
  attempts: number
  rowCount?: number
  ordersCount?: number
  deductionsCount?: number
  cancelledCount?: number
}

export interface CloseDraftAttachment {
  package: 'end'
  slot: string
  mediaId: string
  attachmentToken: string
  attachedAt?: string
  attachedAtMs?: number
  read: CloseDraftAttachmentRead | null
}

export interface CloseDraftFigures {
  odometerKm: number | null
  odometerKmOcr: number | null
  odometerAnomalyConfirmed: boolean
  batteryPercent: number | null
  cashDeclared: string | null
  walletDeclared: string | null
  walletDeclaredOcr: string | null
}

export type CloseDraftOperationSource = 'manual' | 'local_ocr' | 'cloud_ocr'
export type CloseDraftWindowBasis = 'printed_time' | 'screen_position' | 'manager' | null

export interface CloseDraftEvidenceSource {
  mediaId: string
  attachmentToken: string
  slot: string
}

export interface CloseDraftPositionBasis {
  lowerInstant: string | null
  upperInstant: string | null
  anchorObservationIds?: string[]
}

export interface CloseDraftSighting {
  readId: string
  observationId: string
  rowIndex: number
  dateSection: string | null
  evidence: CloseDraftEvidenceSource
}

interface CloseDraftObservedRow {
  clientKey: string
  source: CloseDraftOperationSource
  readId: string | null
  observationId: string | null
  rowIndex: number | null
  dateSection: string | null
  evidence: CloseDraftEvidenceSource | null
  /** All overlapping evidence observations; singular fields remain for rolling compatibility. */
  sightings?: CloseDraftSighting[]
}

export interface CloseDraftOrder extends CloseDraftObservedRow {
  providerOrderNo: string
  payMode: 'cash' | 'electronic' | 'free'
  fee: string | null
  feeOcr: string | null
  feeRefused: boolean
  reviewRequired: boolean
  included: boolean
  occurredMinute: string | null
  occurredDate: string | null
  pointA: string | null
  pointB: string | null
  windowBasis: CloseDraftWindowBasis
  position: CloseDraftPositionBasis | null
}

export interface CloseDraftCashDeduction extends CloseDraftObservedRow {
  operationKey: string
  amount: string | null
  amountOcr: string | null
  reviewRequired: boolean
  included: boolean
  occurredMinute: string | null
  occurredDate: string | null
  pointA: string | null
  pointB: string | null
  windowBasis: CloseDraftWindowBasis
  position: CloseDraftPositionBasis | null
}

export interface CloseDraftMovement extends CloseDraftObservedRow {
  amount: string
  occurredMinute: string | null
  role: 'yalago_cut' | 'order_credit' | 'unmatched'
  providerOrderNo: string | null
  ambiguous: boolean
  included: boolean
  notes: string | null
}

/**
 * Canonical operations are returned in the driver's existing editing model.
 * OCR provenance is server-owned; callers may edit values but must never manufacture it.
 */
export interface CloseDraftView {
  shiftId: string
  revision: number
  draftHash: string
  updatedAt: string
  restored: boolean
  figures: CloseDraftFigures
  attachments: CloseDraftAttachment[]
  operations: {
    orders: CloseDraftOrder[]
    cashDeductions: CloseDraftCashDeduction[]
    movements: CloseDraftMovement[]
  }
  submittedAt: string | null
}

export type CloseDraftRowEdit =
  | {
      clientKey: string
      kind: 'order'
      fee?: string | null
      occurredMinute?: string | null
      occurredDate?: string | null
    }
  | {
      clientKey: string
      kind: 'cash_deduction'
      amount?: string | null
      occurredMinute?: string | null
      occurredDate?: string | null
    }
  | {
      clientKey: string
      kind: 'movement'
      amount?: string
      occurredMinute?: string | null
      notes?: string | null
      ambiguous?: boolean
    }

export interface CloseDraftPatch {
  expectedRevision: number
  /** Human-editable declarations only. OCR baselines and battery fields are server-owned. */
  figures?: {
    odometerKm?: number | null
    odometerAnomalyConfirmed?: boolean
    cashDeclared?: string | null
    walletDeclared?: string | null
  }
  operations?: {
    manualOrders?: Array<{
      clientKey: string
      providerOrderNo: string
      payMode: 'cash' | 'electronic' | 'free'
      fee: string | null
      occurredMinute: string | null
      occurredDate: string | null
      pointA: string | null
      pointB: string | null
      source: 'manual'
    }>
    manualCashDeductions?: Array<{
      clientKey: string
      operationKey: string
      amount: string | null
      occurredMinute: string | null
      occurredDate: string | null
      pointA: string | null
      pointB: string | null
      source: 'manual'
    }>
    manualMovements?: Array<{
      clientKey: string
      amount: string
      occurredMinute: string | null
      role: 'yalago_cut' | 'order_credit' | 'unmatched'
      providerOrderNo: string | null
      ambiguous: boolean
      notes: string | null
      source: 'manual'
    }>
    rowEdits?: CloseDraftRowEdit[]
  }
}

/**
 * The linked-read reply, exactly as the API sends it.
 *
 * There is NO top-level `read`. It was declared here once and never sent, so `response.read.status`
 * compiled cleanly and threw at runtime on every end-package battery read for twelve days. The read
 * belongs to a slot, and lives on `draft.attachments[].read`.
 */
export interface CloseDraftReadResponse {
  draft: CloseDraftView
  rows: CloudOcrResponse['rows']
  fields: Record<string, string | null>
  /** The server already had a complete read for this attachment and did no work. */
  alreadyRead?: boolean
}

export interface CloseDraftAttachmentHistoryItem {
  historyId: string
  package: 'end'
  slot: string
  mediaId: string
  attachmentToken: string
  attachedAt?: string
  attachedAtMs?: number
  reusedFromShiftId: string | null
  isCurrent: boolean
}

/** Everything the driver's app needs to pick a half-finished shift back up where he left it. */
export interface ShiftStateView {
  id: string
  state: 'draft' | 'awaiting_open_approval' | 'open' | 'pending_review' | 'suspended' | 'approved' | 'week_locked'
  driverId: string
  vehicleId: string
  shiftNo: number
  businessDate: string
  /** The manager-approved lower edge and driver-submitted upper edge of the operation window. */
  openApprovedAt: string | null
  submittedAt: string | null
  startPackage: {
    odometerKm: number | null
    batteryPercent: number | null
    floatTotal: string
    topupTotal: string
    mediaSlots: string[]
    batteries: Array<{
      batteryId: string
      slotNo: number
      percent: number | null
      mediaId: string | null
      /** The driver's BMS app cannot read this pack; the manager owns the remaining reading. */
      unavailable: boolean
    }>
  }
  endPackage: {
    odometerKm: number | null
    /** Present once the end-package OCR baseline is exposed by the state endpoint. */
    odometerKmOcr?: number | null
    batteryPercent: number | null
    cashDeclared: string | null
    walletDeclared: string | null
    /** Cloud-AI wallet baseline; optional only for compatibility with an older state endpoint. */
    walletDeclaredOcr?: string | null
    mediaSlots: string[]
    batteries: Array<{
      batteryId: string
      slotNo: number
      percent: number | null
      mediaId: string | null
      unavailable: boolean
    }>
  }
  orders: Array<{
    providerOrderNo: string
    payMode: 'cash' | 'electronic' | 'free'
    fee: string
    zone: string | null
    /** Checked. Unchecked rows still come back: whoever closes the shift must see all of them. */
    included: boolean
    /** What the payments log says reached the wallet. `null` = unmeasured, the pay mode decides. */
    walletAmount: string | null
    occurredMinute: string | null
    /** «الخميس, ٦ أغسطس» — the day the SCREEN said, which is not always the shift's own day. */
    occurredDate?: string | null
    windowStatus: OperationWindowStatus
    decisionReason: string | null
    decidedBy: string | null
    decidedAt: string | null
    /** «A» the pickup, «B» the dropoff — the order has no number, so this is how it is known. */
    points?: Array<{ role: string; label: string; lat: number | null; lng: number | null }>
  }>
  /** «سجل المدفوعات» as read — what the wallet actually did, beside what the orders imply. */
  movements: Array<{
    id: string
    /** SIGNED money: negative left the wallet. */
    amount: string
    occurredMinute: string
    role: 'yalago_cut' | 'order_credit' | 'unmatched'
    ambiguous: boolean
    included: boolean
  }>
  /** Optional while older state endpoints do not yet expose Recent-Orders cash deductions. */
  cashDeductions?: Array<{
    id: string
    operationKey: string
    amount: string
    amountOcr?: string | null
    occurredMinute: string | null
    occurredDate: string | null
    source: 'ocr' | 'manual'
    pointA: string | null
    pointB: string | null
    included: boolean
    windowStatus: OperationWindowStatus
    decisionReason: string | null
    decidedBy: string | null
    decidedAt: string | null
  }>
  /** Mid-shift battery swaps (SRS §L seam): the pack on `slotNo` came off, another went on. */
  batterySwaps?: Array<{
    seqNo: number
    slotNo: number
    occurredAt: string
    outSerial: string | null
    inSerial: string | null
    outPercent: number | null
    inPercent: number | null
  }>
  /** The manager's latest decision (C-7): present after a re-shoot request / reject, so the driver knows why. */
  lastDecision?: { decision: 'approved' | 'rejected' | 'rephoto_requested'; notes: string | null } | null
}

/** Live shift-funding balances captured with the manager's transactional shift review. */
export type ShiftFundingPreviewView = import('@ash/contracts').ShiftFundingPreview

/**
 * Open approval binds to the exact funding preview. Zero is represented by an explicitly present
 * empty tranche array, matching the wire's existing no-tranche representation.
 */
export interface ApproveOpenShiftBody {
  floatTranches: string[]
  topupTranches: string[]
  carriedTranches: string[]
  carriedWalletTranches: string[]
}

/** A manager-authored rule that may open and fund one driver's shift without a live approval. */
export interface PreapprovedShiftRuleView {
  id: string
  branchId: string
  driverId: string
  businessDate: string
  windowStart: string
  windowEnd: string
  cashFloat: string
  walletTopup: string
  active: boolean
  consumedByShiftId: string | null
  consumedAt: string | null
  authorizedBy: string
  createdAt: string
}

/** One form submission expands into one pre-approved shift rule for each custom date. */
export interface CreatePreapprovedShiftRulesBody {
  branchId?: string
  driverId: string
  dates: string[]
  windowStart: string
  windowEnd: string
  cashFloat: string
  walletTopup: string
}

/**
 * The BMS phone apps a pack can ship with.
 *
 * Mirrors BMS_PROFILES in the driver app, which is where the label spellings and layout rules
 * actually live — this is only the picker's vocabulary. `auto` means nobody has said yet and the
 * reader tries everything, which works but is the slowest and least certain path.
 */
export const BMS_PROFILE_IDS = ['auto', 'table_en', 'cards_ar'] as const
export type BmsProfileId = (typeof BMS_PROFILE_IDS)[number]

/** A battery pack. `vehicleId` and `slotNo` are set together, or it is a spare on the shelf. */
export interface Battery {
  id: string
  branchId: string
  serialNo: string | null
  bmsMac: string | null
  capacityAh: number
  vehicleId: string | null
  slotNo: number | null
  state: 'ready' | 'charging' | 'maintenance' | 'retired'
  active: boolean
  bmsProfile: string | null
  /** «الرقم التمييزي» — the number marked on the pack, as staff read it at the shelf. */
  groundNo: string | null
}

/** One entry in a vehicle's life log (SRS B-2 / س66). `cost` is a decimal string, or null. */
export interface VehicleEvent {
  id: number
  vehicleId: string
  kind: string
  occurredAt: string
  businessDate: string
  odometerKm: number | null
  cost: string | null
  expenseId: string | null
  shiftId: string | null
  notes: string | null
}

// ── Tier admin (SRS F) ──────────────────────────────────────────────────────────────────────
export interface TierBand {
  from: number
  /** null = the top band, «and above». */
  to: number | null
  /** Driver share in basis points (4000 = 40%). */
  driverBps: number
}
export interface TierRuleView {
  id: number
  basis: 'orders' | 'revenue'
  mode: 'whole' | 'marginal'
  vehicleTypeId: string | null
  bands: TierBand[]
  effectiveFrom: string
  status: 'active' | 'superseded' | 'withdrawn'
  createdBy: string
  isDefault: false
}
export interface TierSimResult {
  from: string
  to: string
  drivers: Array<{ driverId: string; orders: number; currentDriverShare: string; candidateDriverShare: string; driverDelta: string }>
  driverTotalDelta: string
  companyTotalDelta: string
}

// ── Live GPS (SRS K) ────────────────────────────────────────────────────────────────────────
export interface GpsLiveDriver {
  driverId: string
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
  receivedAt: string
}

// ── Expenses (SRS G) ────────────────────────────────────────────────────────────────────────
export interface ExpenseCategoryView {
  id: string
  code: string
  nameAr: string
  active: boolean
}
/** «مدخول مباشر» — money arriving that is not a delivery fee. The mirror of an expense. */
/**
 * «السلفة» — an expense that was paid but must come back in full (owner decision 17).
 *
 * Recorded like a صرفية and read like a ذمة. `outstanding` is a LEDGER fact from the advance's own
 * fund, so it is authoritative even if the event rows are ever incomplete.
 */
export interface AdvanceView {
  id: string
  branchId: string
  /** Whoever must pay it back — free text. */
  partyName: string
  /** Normalised `partyName`. For grouping and search only; no money depends on it. */
  partyKey: string
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  /** Set when this advance was reclassified from that driver's «ذمة»; no money moved. */
  sourceDriverId: string | null
  /** WHICH BOX paid — or, for a reclassified receivable, which of his debts it was. */
  channel: 'office_cash' | 'office_wallet'
  /** Decimal string — what was originally handed over. */
  amount: string
  businessDate: string
  description: string
  receiptMediaId: string | null
  journalEntryId: number
  createdBy: string
}

/** One outstanding advance, with what the ledger says is still owed on it. */
export interface AdvanceOutstandingView extends AdvanceView {
  outstanding: string
  repaid: string
  converted: string
}

export interface AdvanceEventView {
  id: string
  advanceId: string
  branchId: string
  kind: 'repayment' | 'conversion'
  amount: string
  businessDate: string
  reason: string
  /** The ordinary expense row a conversion writes; null for a repayment. */
  expenseId: string | null
  journalEntryId: number
  createdBy: string
}

export interface IncomeView {
  id: string
  branchId: string
  categoryId: string
  /** WHICH BOX received it. A physical fact the operator knows, never a ledger fund code. */
  channel: 'office_cash' | 'office_wallet'
  /** Decimal string. */
  amount: string
  businessDate: string
  description: string
  evidenceMediaId: string | null
  /** Never null, unlike an expense's — the column is NOT NULL. */
  journalEntryId: number
  createdBy: string
}

export interface IncomeCategoryView {
  id: string
  code: string
  nameAr: string
  active: boolean
}

export interface ExpenseView {
  id: string
  branchId: string
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  /** WHICH BOX paid. Absent on rows recorded before the wallet channel existed (0059). */
  channel?: 'office_cash' | 'office_wallet'
  /** Decimal string. */
  amount: string
  businessDate: string
  description: string
  receiptMediaId: string | null
  journalEntryId: number | null
  createdBy: string
}

/**
 * The branch manager's immutable close-settlement preview.
 *
 * Every money field remains a decimal string. `walletAmount` and `cashAmount` are absolute values;
 * their direction is carried by the adjacent action so the manager is never asked to interpret a
 * minus sign while handing over real money. `variance` and `finalEmployeeCash` stay signed because
 * they are accounting facts in the explanatory breakdown.
 */
export interface ShiftSettlementView {
  policyCode: 'fixed_40_cash_close_v1' | 'fixed_40_cash_close_v2_receivable'
  driverRateBps: 4000
  deliveryFeeTotal: string
  fixedDriverShare: string
  manualDriverShare: string
  grossDriverShare: string
  cashDeductionTotal: string
  baseDriverShare: string
  expectedTotal: string
  actualCash: string
  actualWallet: string
  actualTotal: string
  variance: string
  varianceDirection: 'surplus' | 'shortage' | 'balanced'
  finalEmployeeCash: string
  cashClaimToOffice: string
  walletClaimToOffice: string
  cashReceivableDeferred: string
  walletReceivableDeferred: string
  maximumCashShortageReceivable: string
  cashShortageReceivable: string
  walletToOffice: string
  cashToOffice: string
  walletAction: 'collect' | 'fund' | 'none'
  walletAmount: string
  cashAction: 'collect' | 'pay' | 'none'
  cashAmount: string
  settlementHash: string
}

/**
 * Rolling-deploy shape from the API before close-shortage receivables were introduced.
 *
 * Those two fields were added together. Treating their absence as zero is the only truthful
 * compatibility value: the older server could neither preview nor publish that kind of debt.
 * A positive value typed by a new client still cannot match this normalized preview, so approval
 * remains blocked until a server that actually supports the feature answers with the same value.
 */
type ShiftSettlementWireView = Omit<
  ShiftSettlementView,
  'maximumCashShortageReceivable' | 'cashShortageReceivable'
> & {
  maximumCashShortageReceivable?: string
  cashShortageReceivable?: string
}

function normalizeShiftSettlementView(view: ShiftSettlementWireView): ShiftSettlementView {
  return {
    ...view,
    maximumCashShortageReceivable: view.maximumCashShortageReceivable ?? '0.00',
    cashShortageReceivable: view.cashShortageReceivable ?? '0.00',
  }
}

/** The two physical handovers the manager must attest before close approval can post. */
export interface ApproveCloseRequest {
  reviewedOrdersHash: string
  reviewedSettlementHash: string
  walletTransferConfirmed: boolean
  cashSettlementConfirmed: boolean
  cashReceivableDeferred?: string
  walletReceivableDeferred?: string
  cashShortageReceivable?: string
  varianceReason?: string | null
}

/**
 * «الترميم» as the wire carries it. Every money field is a decimal STRING — the client never turns
 * money into a `number`, not even to display it.
 */
export interface RestorationLegView {
  fundCode: 'office_cash' | 'office_wallet'
  /** Current office-fund balance from the system ledger. */
  officeBalance: string
  /** Transitional compatibility for older API deployments; UI code must use `officeBalance`. */
  counted?: string
  /** Outstanding driver debt assigned to this box. */
  receivables: string
  /**
   * Outstanding السلف assigned to this box (owner decision 17).
   *
   * Its own field, never folded into `receivables`: the screen labels that «الذمم», and a سلفة
   * shown there would read as a driver's debt. Optional so a page served during a rolling deploy
   * against the previous API still renders.
   */
  advances?: string
  /** officeBalance + الذمم + السلف — «الوضع الحالي». */
  position: string
  capitalTarget: string
  /** Signed: positive is «كييش», negative «شحن من الصندوق». */
  delta: string
  /** `null` when the box is already exactly on target. */
  direction: 'to_company' | 'from_company' | null
  amount: string
  feasible: boolean
  refusals: Array<'sweep_exceeds_counted' | 'no_capital_target'>
}
export interface RestorationView {
  businessDate: string
  /** Present only on the ledger-backed restoration API. Missing means the server is still legacy. */
  source?: 'live_ledger'
  /** True after today's immutable restoration posting exists; prevents a fresh-looking replay after reload. */
  alreadyRestored?: boolean
  legs: RestorationLegView[]
  netToCompany: string
  feasible: boolean
  refusals: Array<'sweep_exceeds_counted' | 'no_capital_target'>
}

/** Rolling-deploy shape accepted from both the old count-based API and the ledger-based API. */
interface RestorationWireView extends Omit<RestorationView, 'legs' | 'feasible' | 'refusals'> {
  /** Old previews exposed this gate; it is intentionally absent from the normalized view. */
  counted?: boolean
  feasible?: boolean
  refusals?: RestorationView['refusals']
  legs: Array<Omit<RestorationLegView, 'officeBalance'> & { officeBalance?: string }>
}

function normalizeRestorationView(view: RestorationWireView): RestorationView {
  const legs = view.legs.map((leg) => {
    const officeBalance = leg.officeBalance ?? leg.counted
    if (officeBalance === undefined) {
      throw {
        status: 502,
        error: 'malformed_response',
        detail: 'restoration leg is missing officeBalance',
      } satisfies ApiError
    }
    return { ...leg, officeBalance }
  })
  return {
    businessDate: view.businessDate,
    ...(view.source === undefined ? {} : { source: view.source }),
    ...(view.alreadyRestored === undefined ? {} : { alreadyRestored: view.alreadyRestored }),
    legs,
    netToCompany: view.netToCompany,
    feasible: view.feasible ?? legs.every((leg) => leg.feasible),
    refusals: view.refusals ?? [...new Set(legs.flatMap((leg) => leg.refusals))],
  }
}

export interface CapitalTargetsView {
  businessDate: string
  cashTarget: string
  walletTarget: string
}

export interface DriverReceivableView {
  driverId: string
  code: string
  nameAr: string
  ordinaryCash: string
  ordinaryWallet: string
  shiftFundingCash: string
  shiftFundingWallet: string
  cash: string
  wallet: string
  total: string
}

export interface ReceivablesView {
  /** Backwards-compatible alias: this endpoint historically returned the cash total as `total`. */
  total: string
  ordinaryCashTotal: string
  ordinaryWalletTotal: string
  shiftFundingCashTotal: string
  shiftFundingWalletTotal: string
  cashTotal: string
  walletTotal: string
  grandTotal: string
  drivers: DriverReceivableView[]
}

export type ReceivableKind = 'ordinary' | 'shift_funding'
export type ReceivableChannel = 'cash' | 'wallet'
export type ReceivableDirection = 'create' | 'collect'

export interface ReceivableEventView {
  id: string
  driverId: string
  driverCode: string
  driverNameAr: string
  receivableKind: ReceivableKind
  channel: ReceivableChannel
  direction: ReceivableDirection
  amount: string
  businessDate: string
  reason: string
  /**
   * `correction` restates a balance that was recorded wrongly — no money moved. Rendering it as a
   * collection would tell the driver his debt was paid when it was not. `writeoff` clears a real
   * debt against loss and, unlike collection, never moves an office box.
   */
  intent: 'command' | 'correction' | 'writeoff'
  /** Corrections/write-offs: what the balance read, and what it became. */
  priorBalance: string | null
  targetBalance: string | null
  journalEntryId: number
  createdBy: string
  createdAtMs: number
  replayed?: boolean
}

export interface CreateReceivableEventRequest {
  driverId: string
  receivableKind: ReceivableKind
  channel: ReceivableChannel
  direction: ReceivableDirection
  amount: string
  reason: string
  idempotencyKey: string
}

export interface WriteoffReceivableRequest {
  driverId: string
  channel: ReceivableChannel
  amount: string
  reason: string
  idempotencyKey: string
}

export interface CreateReceivableEventResult {
  id: string
  driverId: string
  receivableKind: ReceivableKind
  channel: ReceivableChannel
  direction: ReceivableDirection
  amount: string
  businessDate: string
  reason: string
  intent: 'command' | 'correction' | 'writeoff'
  priorBalance: string | null
  targetBalance: string | null
  journalEntryId: number
  replayed: boolean
}

/**
 * «تعديل الذمم المسجلة» — restate a balance, rather than record a movement.
 *
 * A driver's receivable balance is a ledger fund balance fed from seven places, only one of which
 * writes an event; the commonest wrong number of all — a `shift_funding` carry — has no event to
 * point at. So the correction names the balance, and `expectedCurrentBalance` is what the operator
 * had on screen: if it has moved since, the server refuses rather than applying his instruction to
 * a number he never saw.
 */
export interface CorrectReceivableRequest {
  driverId: string
  receivableKind: ReceivableKind
  channel: ReceivableChannel
  expectedCurrentBalance: string
  targetBalance: string
  reason: string
  idempotencyKey: string
}

/**
 * One pack's BMS reading. Scaled INTEGERS, never floats — millivolts, deci-amp-hours,
 * deci-Celsius — so 83.37 V is 83_370 and 50.0 Ah is 500.
 */
export interface BatteryReadingInput {
  batteryId: string
  percent: number | null
  /**
   * Optimistic evidence lock for a current PWA. When present, the server writes this reading only
   * if the pack's BMS slot is still attached to this exact media row. Cached PWAs omit it and keep
   * their read-before-upload staging behaviour, including a retake over an existing attachment.
   */
  expectedMediaId?: string
  packMillivolts?: number | null
  cycleCount?: number | null
  remainCapacityDah?: number | null
  fullCapacityDah?: number | null
  mosTempDc?: number | null
  t1Dc?: number | null
  t2Dc?: number | null
  source?: 'ocr' | 'manual' | 'manager'
  /**
   * «تطبيق البطارية لا يعمل على جهازي» — the driver cannot read this pack on his own phone.
   *
   * Unblocks him (the gate stops demanding a screenshot he cannot take) and blocks the branch
   * manager, who must read the pack himself before the shift can be approved.
   */
  unavailable?: boolean
  /** What the OCR read BEFORE the driver corrected anything (SRS D-3). */
  ocrRaw?: unknown
}

export class ApiClient {
  private readonly baseUrl: string

  /**
   * The branch an organisation-wide role is currently looking at.
   *
   * The GM and the system admin have `branchId === null` on their session — the §3 matrix grants
   * them scope 'all', so the session deliberately cannot pick a branch for them. Every
   * branch-scoped READ therefore has to carry the branch it means, or the server answers 422
   * `branch_required` and the screen sits on a spinner forever. A branch-scoped role leaves this
   * null: his session already says which branch, and naming another would be refused anyway.
   */
  branchId: string | null = null

  /**
   * Called once when the server says the session is gone.
   *
   * Without it a lapsed cookie is indistinguishable from a broken app: every read fails with
   * «تعذّر تحميل البيانات», every photo tile turns grey, the approval poll silently no-ops
   * forever — and the screen still shows the user signed in. He has no way to learn that the one
   * thing he needs to do is sign in again. Set by each app at construction.
   */
  onUnauthorized: (() => void) | null = null

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  /** Point every subsequent branch-scoped read at this branch. `null` restores session scope. */
  setBranch(branchId: string | null): void {
    this.branchId = branchId
  }

  /**
   * Append the selected branch to a read.
   *
   * Reads only: a write names its branch in the body, where it is explicit and auditable, and
   * where creating the wrong thing in the wrong branch is not one forgotten query param away.
   */
  private scoped(path: string): string {
    if (!this.branchId) return path
    const sep = path.includes('?') ? '&' : '?'
    return `${path}${sep}branchId=${encodeURIComponent(this.branchId)}`
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    options: { cache?: RequestCache; signal?: AbortSignal } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include', // the session cookie, always
      headers: body instanceof Uint8Array ? headers : { 'content-type': 'application/json', ...headers },
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    if (body !== undefined) {
      init.body = body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body)
    }
    const res = await fetch(`${this.baseUrl}${path}`, init)

    const text = await res.text()
    /*
     * Parse DEFENSIVELY, and never before the status has been read.
     *
     * A platform error page is HTML, not JSON. Vercel answers `FUNCTION_PAYLOAD_TOO_LARGE` (413)
     * and `FUNCTION_INVOCATION_TIMEOUT` (504) that way, and so do proxies and SSO gates. Parsing
     * first turned every one of them into a `SyntaxError` carrying no status and no code, which the
     * driver's upload tile could only render as a bare «فشل الرفع» — indistinguishable from an
     * offline phone. When the body is unreadable the status is the most useful thing we have, so
     * carry it rather than discarding it with the exception.
     */
    let json: unknown = null
    let parsed = true
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        parsed = false
      }
    }

    if (!res.ok) {
      const err = (parsed ? (json ?? {}) : {}) as { error?: string; detail?: unknown }
      // The session, not this request, is what failed. Announced once so the app can drop to the
      // login screen; the error still throws, because the caller's own state is still wrong.
      // `login` itself answers 401 on a bad password — that is a failed ATTEMPT, not a lapsed
      // session, and signing the user out of a screen he is not signed in to helps nobody.
      if (res.status === 401 && !path.endsWith('/auth/login')) this.onUnauthorized?.()
      throw {
        status: res.status,
        // An unreadable body still names its status. `http_413` is something the UI can map to real
        // words; a `SyntaxError` is not.
        error: err.error ?? (parsed ? 'unknown' : `http_${res.status}`),
        detail: parsed ? err.detail : text.slice(0, 200),
      } satisfies ApiError
    }
    // A 2xx whose body is not JSON is its own failure and must not be handed back as `T`.
    if (!parsed) {
      throw { status: res.status, error: 'malformed_response', detail: text.slice(0, 200) } satisfies ApiError
    }
    return json as T
  }

  get<T>(path: string, options: { cache?: RequestCache; signal?: AbortSignal } = {}): Promise<T> {
    return this.request<T>('GET', this.scoped(path), undefined, {}, options)
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body)
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }
  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', this.scoped(path))
  }

  /**
   * Raw bytes for evidence upload — never base64, never multipart.
   *
   * `method` exists because the cloud OCR read posts bytes to a different verb: an upload PUTs to
   * an addressable slot, whereas a read creates nothing and is a POST. Defaulted, so every existing
   * call site is unchanged.
   */
  putBytes<T>(
    path: string,
    bytes: Uint8Array,
    contentType: string,
    extraHeaders: Record<string, string> = {},
    method: 'PUT' | 'POST' = 'PUT',
  ): Promise<T> {
    return this.request<T>(method, path, bytes, { 'content-type': contentType, ...extraHeaders })
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────────────────
  login(username: string, password: string) {
    return this.post<{
      userId: string
      roleKey: string
      branchId: string | null
      fullNameAr: string
      secondFactorRequired: boolean
      enrollmentRequired: boolean
    }>('/auth/login', { username, password })
  }
  verify2fa(code: string) {
    return this.post<{ ok: true }>('/auth/2fa/verify', { code })
  }
  enroll2fa() {
    return this.post<{ secret: string; otpauthUri: string }>('/auth/2fa/enroll')
  }
  confirm2fa(secret: string, code: string) {
    return this.post<{ ok: true; enrolled: true }>('/auth/2fa/confirm', { secret, code })
  }
  logout() {
    return this.post<{ ok: true }>('/auth/logout')
  }
  me() {
    return this.get<{ userId: string; roleKey: string; branchId: string | null; driverId: string | null; businessDate: string }>('/me')
  }

  // ── Accounts (SRS A-2) ──────────────────────────────────────────────────────────────────────
  users() {
    return this.get<{
      users: Array<{
        id: string
        username: string
        roleKey: string
        fullNameAr: string
        branchId: string | null
        driverId: string | null
        active: boolean
      }>
    }>('/users')
  }
  branches() {
    return this.get<{ branches: Array<{ id: string; code: string; nameAr: string; nameEn: string }> }>('/branches')
  }
  /** Edit an account: rename, change role/branch, deactivate, or reset the password. */
  updateUser(
    id: string,
    body: { fullNameAr?: string; roleKey?: string; branchId?: string | null; active?: boolean; password?: string },
  ) {
    return this.patch<{
      id: string
      username: string
      roleKey: string
      fullNameAr: string
      branchId: string | null
      driverId: string | null
      active: boolean
    }>(`/users/${id}`, body)
  }
  createUser(body: { username: string; password: string; roleKey: string; fullNameAr: string; branchId?: string }) {
    return this.post<{ id: string; username: string; roleKey: string; fullNameAr: string; branchId: string | null; driverId: string | null }>(
      '/users',
      body,
    )
  }

  // ── The §3 permission matrix, as data (SRS A-2) ─────────────────────────────────────────────
  permissions() {
    return this.get<{
      roles: string[]
      permissions: string[]
      grants: Array<{ roleKey: string; permissionKey: string; scope: string }>
    }>('/permissions')
  }
  setGrant(roleKey: string, permissionKey: string, scope: 'own' | 'branch' | 'all' | null) {
    return this.put<{ roleKey: string; permissionKey: string; scope: string | null }>('/role-permissions', {
      roleKey,
      permissionKey,
      scope,
    })
  }

  // ── Audit trail (SRS A-5) ───────────────────────────────────────────────────────────────────
  audit(filter: { tableName?: string; recordId?: string; actorId?: string } = {}) {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(filter)) if (v) q.set(k, v)
    const qs = q.toString()
    return this.get<{
      rows: Array<{
        id: number
        tableName: string
        recordId: string
        action: string
        actorId: string | null
        actorKind: string
        branchId: string | null
        before: unknown
        after: unknown
        occurredAt: string
      }>
    }>(`/audit${qs ? `?${qs}` : ''}`)
  }

  /**
   * The register of rows a manager declared were never deliveries.
   *
   * Separate from `audit()` on purpose. The audit trail answers «what happened to THIS record», and
   * you must already know the table and the UUID to ask it. This answers «what has been removed
   * lately», which is the question a general manager actually has.
   */
  operationRemovals(filter: { branchId?: string; limit?: number } = {}) {
    const q = new URLSearchParams()
    if (filter.branchId) q.set('branchId', filter.branchId)
    if (filter.limit) q.set('limit', String(filter.limit))
    const qs = q.toString()
    return this.get<{
      rows: Array<{
        id: string
        kind: 'removed' | 'restored'
        operationKind: 'order' | 'cash_deduction'
        operationRef: string
        shiftId: string
        branchId: string
        businessDate: string
        driverName: string | null
        amount: string
        reason: string
        evidenceSlot: string | null
        evidenceMediaId: string | null
        actedByName: string | null
        actedAt: string
      }>
    }>(`/operation-removals${qs ? `?${qs}` : ''}`)
  }

  // -- The fleet: numbering, types, batteries (SRS B-2 / L) ------------------------------------
  governorates() {
    return this.get<{ governorates: Array<{ id: string; no: number; nameAr: string; nameEn: string; active: boolean }> }>(
      '/governorates',
    )
  }
  createGovernorate(body: { no: number; nameAr: string; nameEn: string }) {
    return this.post<{ id: string }>('/governorates', body)
  }
  updateGovernorate(id: string, body: { no?: number; nameAr?: string; nameEn?: string; active?: boolean }) {
    return this.patch<{ id: string }>(`/governorates/${id}`, body)
  }

  createBranch(body: { code: string; nameAr: string; nameEn: string; governorateId: string; branchNo: number }) {
    return this.post<{ id: string }>('/branches', body)
  }
  updateBranch(id: string, body: { nameAr?: string; nameEn?: string; governorateId?: string; branchNo?: number }) {
    return this.patch<{ id: string }>(`/branches/${id}`, body)
  }

  vehicleTypes() {
    return this.get<{
      vehicleTypes: Array<{
        id: string
        code: string
        nameAr: string
        nameEn: string
        typeNo: number
        /** Max packs a machine of this type may carry — the ceiling, not the count. */
        batterySlots: number
        active: boolean
      }>
    }>('/vehicle-types')
  }
  createVehicleType(body: { code: string; nameAr: string; nameEn: string; typeNo: number; batterySlots?: number }) {
    return this.post<{ id: string }>('/vehicle-types', body)
  }
  /** Changing `typeNo` restates the printed number of every vehicle of this type. */
  updateVehicleType(
    id: string,
    body: { nameAr?: string; nameEn?: string; typeNo?: number; batterySlots?: number; active?: boolean },
  ) {
    return this.patch<{ id: string }>(`/vehicle-types/${id}`, body)
  }

  /** What the next bike of this type would be called — for the live preview on the add form. */
  nextVehicleNumber(vehicleTypeId: string) {
    return this.get<{ code: string; machineNo: number }>(
      `/vehicles/next-number?vehicleTypeId=${encodeURIComponent(vehicleTypeId)}`,
    )
  }
  createVehicle(body: { vehicleTypeId: string; machineNo?: number; plateNo?: string | null; groundNo?: string | null }) {
    return this.post<{ id: string; code: string; machineNo: number }>('/vehicles', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  batteries() {
    return this.get<{ batteries: Battery[] }>('/batteries')
  }
  createBattery(body: {
    capacityAh: number
    serialNo?: string | null
    bmsMac?: string | null
    vehicleId?: string | null
    slotNo?: number | null
    bmsProfile?: string | null
    /** The marking on the pack. The server has accepted it since `createBatteryRequest` gained it;
     *  only this type omitted it, so a pack had to be created and then edited to carry its number. */
    groundNo?: string | null
  }) {
    return this.post<Battery>('/batteries', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  updateBattery(id: string, body: Partial<Omit<Battery, 'id' | 'branchId'>>) {
    return this.patch<Battery>(`/batteries/${id}`, body)
  }

  /** One reading per pack. A retake corrects that pack's row rather than adding a second. */
  putBatteryReadings(
    shiftId: string,
    pkg: 'start' | 'end',
    readings: BatteryReadingInput[],
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<{ readings: BatteryReadingInput[] }>(
      'PUT',
      `/shifts/${shiftId}/battery-readings`,
      { package: pkg, readings },
      {},
      options,
    )
  }

  /**
   * Record a mid-shift battery swap (SRS §L seam): the pack on `slotNo` comes off, `inBatteryId`
   * (a charged spare) goes on. Both packs' BMS readings are captured; the server re-fits the bike.
   */
  swapBattery(
    shiftId: string,
    body: {
      slotNo: number
      inBatteryId: string
      outReading: Omit<BatteryReadingInput, 'batteryId'>
      inReading: Omit<BatteryReadingInput, 'batteryId'>
    },
  ) {
    return this.post<{
      swap: { id: string; seqNo: number; slotNo: number }
      readings: BatteryReadingInput[]
      /** The bike's fitted set AFTER the swap — the driver app takes this back so the close screen
       *  asks for the pack now on the bike, not the one that just came off. */
      batteries: Array<{
        id: string
        slotNo: number | null
        capacityAh: number
        serialNo: string | null
        bmsProfile?: string | null
      }>
    }>(`/shifts/${shiftId}/battery-swap`, body)
  }

  // ── Driver ↔ vehicle assignments (B-3) ──────────────────────────────────────────────────────
  assignments(date?: string) {
    return this.get<{
      businessDate: string
      assignments: Array<{
        id: string
        driverId: string
        vehicleId: string
        businessDate: string
        shiftNo: number
      }>
    }>(`/assignments${date ? `?date=${encodeURIComponent(date)}` : ''}`)
  }
  createAssignment(body: { driverId: string; vehicleId: string; businessDate?: string; shiftNo?: number }) {
    return this.post<{ id: string }>('/assignments', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  deleteAssignment(id: string) {
    return this.del<{ ok: boolean }>(`/assignments/${id}`)
  }

  // -- Pre-approved shifts --------------------------------------------------------------------
  preapprovedShiftRules(options: { cache?: RequestCache; signal?: AbortSignal } = {}) {
    return this.get<{ rules: PreapprovedShiftRuleView[] }>('/preapproved-shift-rules', options)
  }
  createPreapprovedShiftRules(body: Omit<CreatePreapprovedShiftRulesBody, 'branchId'>) {
    return this.post<{ rules: PreapprovedShiftRuleView[] }>('/preapproved-shift-rules', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  deletePreapprovedShiftRule(id: string) {
    return this.del<{ ok: true }>(`/preapproved-shift-rules/${encodeURIComponent(id)}`)
  }

  /**
   * Seal the financial week (BR7).
   *
   * `week.close` is system-admin-only, and a system admin is organisation-wide with no branch on
   * his session — so the branch MUST be named here or the close 422s and the week never seals.
   */
  closeWeek(closeDate: string) {
    return this.post<{ weekStart: string }>('/weeks/close', {
      closeDate,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  /** A day's shifts for the branch, every state — including the ones stuck before `open`. */
  /**
   * Every shift currently occupying a driver and a bike, ACROSS DATES.
   *
   * Not `shiftsOfDay`: a shift opened at 23:40 and still running belongs to yesterday's business
   * date, so a date-filtered read reports its bike as free and the screen offers it to a second
   * driver. Any screen asking "who has this right now" wants this one.
   */
  liveShifts() {
    return this.get<{
      businessDate: string
      shifts: Array<{ id: string; driverId: string; vehicleId: string; shiftNo: number; state: string }>
    }>('/shifts?live=1')
  }
  shiftsOfDay(date?: string) {
    return this.get<{
      businessDate: string
      shifts: Array<{ id: string; driverId: string; vehicleId: string; shiftNo: number; state: string }>
    }>(`/shifts${date ? `?date=${encodeURIComponent(date)}` : ''}`)
  }

  /**
   * The DRIVER's read of his own shift.
   *
   * Not `/shifts/:id/review` — that one is `shift.approve` and answers a driver 403 on every call.
   * The app used to poll it waiting for the manager's approval, swallow the 403, and sit on
   * "awaiting approval" forever even after the shift had really opened.
   */
  shiftState(id: string) {
    return this.get<ShiftStateView>(`/shifts/${id}/state`)
  }

  /** Manager-only review, including current branch+driver shift funding from the locked read path. */
  shiftReview<T extends object>(
    id: string,
    options: { cache?: RequestCache; signal?: AbortSignal } = {},
  ) {
    return this.get<T & { shiftFunding: ShiftFundingPreviewView }>(`/shifts/${id}/review`, options)
  }

  /** Approve the open against the exact funding amounts returned by `shiftReview`. */
  approveOpenShift(id: string, body: ApproveOpenShiftBody) {
    return this.post<{ id: string; state: string }>(`/shifts/${id}/approve-open`, body)
  }

  /** The durable, revisioned draft used by the driver's end-shift flow. */
  closeDraft(id: string) {
    return this.get<CloseDraftView>(`/shifts/${id}/close-draft`)
  }

  patchCloseDraft(id: string, body: CloseDraftPatch) {
    return this.patch<CloseDraftView>(`/shifts/${id}/close-draft`, body)
  }

  /** Read the exact attachment generation already accepted as evidence. No unlinked bytes. */
  readCloseDraftAttachment(
    id: string,
    slot: string,
    body: {
      expectedRevision: number
      mediaId: string
      attachmentToken: string
      field: CloudOcrField
      retryFailed?: boolean
    },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.request<CloseDraftReadResponse>(
      'POST',
      `/shifts/${id}/close-draft/media/${encodeURIComponent(slot)}/read`,
      body,
      { 'x-ash-orders-time-consensus': 'close-draft-v1' },
      options,
    )
  }

  closeDraftAttachmentHistory(id: string) {
    return this.get<{
      current: CloseDraftAttachment[]
      history: CloseDraftAttachmentHistoryItem[]
    }>(
      `/shifts/${id}/close-draft/attachments`,
    )
  }

  restoreCloseDraftAttachment(
    id: string,
    historyId: string,
    body: { expectedRevision: number; expectedAttachmentToken: string | null; reason: string },
  ) {
    return this.post<{ draft: CloseDraftView }>(
      `/shifts/${id}/close-draft/attachments/${encodeURIComponent(historyId)}/restore`,
      body,
    )
  }

  deleteCloseDraftAttachment(
    id: string,
    slot: string,
    body: { expectedRevision: number; expectedAttachmentToken: string },
  ) {
    return this.request<{ slots: string[]; draft: CloseDraftView }>(
      'DELETE',
      `/shifts/${id}/media/end/${encodeURIComponent(slot)}`,
      undefined,
      {
        'x-close-draft-revision': String(body.expectedRevision),
        'x-expected-attachment-token': body.expectedAttachmentToken,
      },
    )
  }

  /** Discard a shift of his own that never opened — draft or awaiting approval only. */
  cancelMyShift(id: string) {
    return this.del<{ ok: boolean; id: string }>(`/shifts/${id}/mine`)
  }

  /** Discard a shift that never opened — see the route: only draft/awaiting_open_approval. */
  cancelShift(id: string) {
    return this.del<{ ok: boolean; id: string }>(`/shifts/${id}`)
  }

  // ── Daily FX rate (BR6) & general settings (A-4) — system admin ─────────────────────────────
  fxRate() {
    return this.get<{ businessDate: string; sypMinorPerUsd: number | null; provisional: boolean }>('/fx')
  }
  /** `sypMinorPerUsd` is SYP MINOR units per USD — 13000 = 130.00 SYP/USD. */
  setFxRate(businessDate: string, sypMinorPerUsd: number) {
    return this.put<{ id: number; businessDate: string }>('/fx', { businessDate, sypMinorPerUsd })
  }

  settings() {
    return this.get<{
      receiptCeilingMinor: string | null
      kwhPriceMinor: string | null
      goLiveBusinessDate: string | null
    }>('/settings')
  }
  /**
   * Money fields are decimal strings ("50000.00"); only what is sent changes.
   *
   * `goLiveBusinessDate` needs `branchId`: the setting is global but its opening ceremony (a sealed
   * cash count plus a restoration) is per-branch, and `settings.write` belongs to the system admin,
   * who has no branch of his own. `null` clears the date.
   */
  updateSettings(body: {
    receiptCeilingMinor?: string
    kwhPriceMinor?: string
    goLiveBusinessDate?: string | null
    branchId?: string
  }) {
    return this.put<{ updated: string[] }>('/settings', body)
  }

  // ── Tier admin (SRS F) — read is branch_data.view; publish/withdraw/simulate are sysadmin only ──
  tierRules() {
    return this.get<{ rules: TierRuleView[]; fallback: { bands: TierBand[]; basis: string; mode: string } }>('/tier-rules')
  }
  publishTier(body: { basis?: 'orders' | 'revenue'; mode?: 'whole' | 'marginal'; vehicleTypeId?: string | null; bands: TierBand[]; effectiveFrom: string }) {
    return this.post<TierRuleView>('/tier-rules', body)
  }
  withdrawTier(id: number) {
    return this.post<{ id: number; status: string }>(`/tier-rules/${id}/withdraw`)
  }
  /** What-if over past approved shifts. Sends the selected branch (a sysadmin has none on his session). */
  simulateTier(body: { basis?: 'orders' | 'revenue'; mode?: 'whole' | 'marginal'; bands: TierBand[]; from: string; to: string }) {
    return this.post<TierSimResult>('/tier-rules/simulate', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }

  // ── Expenses (SRS G) — create is expense.write (BM+GM); categories are settings.write (sysadmin) ──
  // ── «المدخول المباشر» — the mirror of an expense ──────────────────────────────────────────
  incomeCategories() {
    return this.get<{ categories: IncomeCategoryView[] }>('/income-categories')
  }
  createIncomeCategory(body: { code: string; nameAr: string }) {
    return this.post<IncomeCategoryView>('/income-categories', body)
  }
  incomes(from?: string, to?: string) {
    const q = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    return this.get<{ from: string; to: string; incomes: IncomeView[]; total: string }>(`/incomes${q ? `?${q}` : ''}`)
  }
  /** `channel` is the box that received the money; the recipe picks the ledger account. */
  createIncome(body: {
    idempotencyKey: string
    categoryId: string
    channel: 'office_cash' | 'office_wallet'
    amount: string
    description: string
    businessDate?: string
    evidenceMediaId?: string | null
    branchId?: string
  }) {
    return this.post<IncomeView>('/incomes', body)
  }

  // ── «السلفة» ──────────────────────────────────────────────────────────────────────────
  advances(from?: string, to?: string) {
    const q = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    return this.get<{
      from: string
      to: string
      advances: AdvanceView[]
      total: string
      outstanding: AdvanceOutstandingView[]
      outstandingCash: string
      outstandingWallet: string
      parties: Array<{ partyName: string; partyKey: string }>
    }>(`/advances${q ? `?${q}` : ''}`)
  }
  /**
   * `channel` is the box the money comes OUT of; the recipe picks the ledger account, and a
   * repayment must later return to that same box.
   *
   * `partyKey` is deliberately absent: the server derives it from `partyName`, so a client can
   * never send a key that disagrees with the name it is supposed to normalise.
   */
  createAdvance(body: {
    idempotencyKey: string
    partyName: string
    categoryId: string
    costCenterKind: 'vehicle' | 'branch' | 'general'
    vehicleId?: string | null
    /** Reclassify this driver's «ذمة» instead of paying out of a box. No money moves. */
    sourceDriverId?: string | null
    channel: 'office_cash' | 'office_wallet'
    amount: string
    description: string
    businessDate?: string
    receiptMediaId?: string | null
    branchId?: string
  }) {
    return this.post<AdvanceView>('/advances', body)
  }
  /** Partial is normal. The amount may not exceed what the ledger still says is outstanding. */
  repayAdvance(advanceId: string, body: { idempotencyKey: string; amount: string; reason: string }) {
    return this.post<AdvanceEventView>(`/advances/${advanceId}/repayments`, {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  /**
   * It is never coming back: recognise the remainder as the صرفية it turned out to be.
   *
   * No amount — the whole outstanding balance converts, read server-side inside the lock. Office
   * capital drops here and nowhere else in this instrument's life.
   */
  convertAdvance(advanceId: string, body: { idempotencyKey: string; reason: string }) {
    return this.post<AdvanceEventView>(`/advances/${advanceId}/conversion`, {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  advanceEvents(advanceId: string) {
    return this.get<{ advance: AdvanceView; outstanding: string; events: AdvanceEventView[] }>(
      `/advances/${advanceId}/events`,
    )
  }

  expenseCategories() {
    return this.get<{ categories: ExpenseCategoryView[] }>('/expense-categories')
  }
  createExpenseCategory(body: { code: string; nameAr: string }) {
    return this.post<ExpenseCategoryView>('/expense-categories', body)
  }
  expenses(from?: string, to?: string) {
    const q = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    return this.get<{ from: string; to: string; expenses: ExpenseView[]; total: string }>(`/expenses${q ? `?${q}` : ''}`)
  }
  expensesByCostCenter(from?: string, to?: string) {
    const q = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    return this.get<{ totals: Array<{ costCenterKind: string; vehicleId: string | null; total: string }> }>(`/expenses/by-cost-center${q ? `?${q}` : ''}`)
  }
  createExpense(body: {
    idempotencyKey: string
    categoryId: string
    costCenterKind: 'vehicle' | 'branch' | 'general'
    vehicleId?: string | null
    /** WHICH BOX pays. Omitted means cash — what every expense meant before 0059. */
    channel?: 'office_cash' | 'office_wallet'
    amount: string
    description: string
    businessDate?: string
    receiptMediaId?: string | null
  }) {
    return this.post<ExpenseView>('/expenses', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }

  // ── «التفقّد» — manager check-in rounds ───────────────────────────────────────────────

  checkinWindows(userId?: string) {
    return this.get<{ windows: CheckInWindowView[] }>(`/checkin-windows${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`)
  }
  createCheckinWindow(body: { userId: string; atMinute: number; toleranceMinutes: number; label: string | null }) {
    return this.post<CheckInWindowView>('/checkin-windows', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  deleteCheckinWindow(id: string) {
    // A DELETE carries no body, so an organisation-wide role names the branch on the query string
    // — the one channel `namedBranch` reads that a bodiless method still has.
    const q = this.branchId ? `?branchId=${encodeURIComponent(this.branchId)}` : ''
    return this.del<{ id: string; active: boolean }>(`/checkin-windows/${id}${q}`)
  }
  /** The manager presses «تفقّد»; the browser supplies the fix. Never blocks — it records. */
  checkin(body: { lat: number; lng: number; accuracyM: number | null; note: string | null }) {
    return this.post<CheckInView>('/checkins', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  checkinReport(date?: string, userId?: string) {
    const q = [date && `date=${date}`, userId && `userId=${encodeURIComponent(userId)}`].filter(Boolean).join('&')
    return this.get<CheckInReportView>(`/checkins${q ? `?${q}` : ''}`)
  }
  setBranchLocation(body: {
    lat: number | null
    lng: number | null
    checkinRadiusM: number
    confirmOutsideRegion?: boolean
  }) {
    return this.put<{ id: string; lat: number | null; lng: number | null; checkinRadiusM: number }>('/branch-location', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  /** «كشف التسوية» — read-only and server-owned. Posts nothing until both handovers are confirmed. */
  async shiftSettlement(
    shiftId: string,
    actual?: { actualCash: string; actualWallet: string },
    deferred?: {
      cashReceivableDeferred: string
      walletReceivableDeferred: string
      cashShortageReceivable?: string
    },
  ): Promise<ShiftSettlementView> {
    const params = new URLSearchParams()
    if (actual) {
      params.set('actualCash', actual.actualCash)
      params.set('actualWallet', actual.actualWallet)
    }
    if (deferred) {
      params.set('cashReceivableDeferred', deferred.cashReceivableDeferred)
      params.set('walletReceivableDeferred', deferred.walletReceivableDeferred)
      if (deferred.cashShortageReceivable !== undefined) {
        params.set('cashShortageReceivable', deferred.cashShortageReceivable)
      }
    }
    const encoded = params.toString()
    const query = encoded === '' ? '' : `?${encoded}`
    const view = await this.get<ShiftSettlementWireView>(`/shifts/${shiftId}/settlement${query}`)
    return normalizeShiftSettlementView(view)
  }

  /**
   * Ask AI to inspect the exact stored Recent Orders evidence page selected by the manager.
   * The response is suggestion-only: applying a time still uses the audited operation revision.
   */
  rereadOrderEvidence(
    shiftId: string,
    body: {
      package: 'end'
      slot: string
      target: ManagerOrderEvidenceRereadTarget
      reason: string
    },
  ) {
    return this.request<ManagerOrderEvidenceRereadResponse>(
      'POST',
      `/shifts/${shiftId}/ocr/orders/evidence-reread`,
      body,
      { 'x-ash-orders-time-consensus': 'close-draft-v1' },
    )
  }

  /** Approve the exact settlement the manager reviewed; the server rejects a stale hash. */
  approveCloseShift(shiftId: string, body: ApproveCloseRequest) {
    return this.post<{ id: string; state: string; postings: number }>(`/shifts/${shiftId}/approve-close`, body)
  }

  // ── Branch treasury (cash box + wallet) ─────────────────────────────────────────────────────
  treasuryBalances() {
    return this.get<{ cash: string; wallet: string }>('/treasury/balances')
  }
  receivables() {
    return this.get<ReceivablesView>('/treasury/receivables')
  }
  receivableEvents(driverId?: string) {
    const query = driverId ? `?driverId=${encodeURIComponent(driverId)}` : ''
    return this.get<{ events: ReceivableEventView[] }>(`/treasury/receivables/events${query}`)
  }
  createReceivableEvent(body: CreateReceivableEventRequest) {
    return this.post<CreateReceivableEventResult>('/treasury/receivables/events', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  writeoffReceivable(body: WriteoffReceivableRequest) {
    return this.post<CreateReceivableEventResult>('/treasury/receivables/writeoffs', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  correctReceivable(body: CorrectReceivableRequest) {
    return this.post<CreateReceivableEventResult>('/treasury/receivables/adjustments', {
      ...body,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  /**
   * «نقل بين الصندوق والمحفظة» — reshape the branch's money without changing how much it holds.
   *
   * The direction names both ends so no fund code crosses the wire: the generic withdraw route
   * takes a free-form `to`, and an unrecognised code lands in a look-alike account nothing sums.
   */
  treasuryTransfer(direction: 'cash_to_wallet' | 'wallet_to_cash', amount: string, reason: string) {
    return this.post<{ direction: string; amount: string; cash: string; wallet: string }>(
      '/treasury/transfer',
      { direction, amount, reason, ...(this.branchId ? { branchId: this.branchId } : {}) },
    )
  }
  treasuryDeposit(target: 'cash' | 'wallet', amount: string, note?: string) {
    // branchId is explicit here: the GM has scope 'all' and no session branch, so without it the
    // deposit 422s — the money would have nowhere to land.
    return this.post<{ target: string; balance: string }>('/treasury/deposit', {
      target,
      amount,
      note,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  /** «كييش» when `to` is the company fund — the same recipe الترميم uses automatically. */
  treasuryWithdraw(target: 'cash' | 'wallet', amount: string, reason: string, to = 'company_box') {
    return this.post<{ target: string; balance: string }>('/treasury/withdraw', {
      target,
      amount,
      to,
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  // ── «صندوق الشركة» — company-wide, so it is NOT scoped to the session branch on read ────────
  companyFund() {
    return this.get<{
      total: string
      branches: Array<{ branchId: string; code: string; nameAr: string; balance: string }>
    }>('/company-fund')
  }
  companyFundDeposit(amount: string, reason: string) {
    return this.post<{ balance: string }>('/company-fund/deposit', {
      amount,
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  companyFundWithdraw(amount: string, reason: string) {
    return this.post<{ balance: string }>('/company-fund/withdraw', {
      amount,
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  // ── «الترميم» — the daily restoration (owner decision 10) ───────────────────────────────────

  /** What tonight's ترميم would do from the ledger-backed office position. Posts nothing. */
  async restorationPreview(): Promise<RestorationView> {
    // `get()` already scopes branch reads. Building the query here as well produced duplicate
    // `branchId` parameters for organisation-wide actors, which some query parsers expose as an
    // array and the server correctly refuses as an invalid branch selector.
    const view = await this.get<RestorationWireView>('/treasury/restoration/preview')
    return normalizeRestorationView(view)
  }
  /** Publishes today's effective targets atomically; prior restored dates remain immutable. */
  updateCapitalTargets(cashTarget: string, walletTarget: string, reason: string) {
    return this.put<CapitalTargetsView>('/treasury/capital-targets', {
      cashTarget,
      walletTarget,
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }
  /** Performs it. The plan is re-derived server-side from the ledger — nothing here is trusted. */
  async restore(reason: string): Promise<RestorationView & { postings: number; reconciliationPostings?: number }> {
    const result = await this.post<RestorationWireView & { postings: number; reconciliationPostings?: number }>(
      '/treasury/restoration',
      {
        reason,
        ...(this.branchId ? { branchId: this.branchId } : {}),
      },
    )
    return {
      ...normalizeRestorationView(result),
      postings: result.postings,
      ...(result.reconciliationPostings === undefined ? {} : { reconciliationPostings: result.reconciliationPostings }),
    }
  }

  // ── Manual journal entry + BR7 correction (SRS E-3) — branch manager + GM ───────────────────
  manualEntry(body: { reason: string; lines: Array<{ fundCode: string; side: 'D' | 'C'; amount: string }>; businessDate?: string; evidenceMediaId?: string | null }) {
    return this.post<{ entryId: number | null; businessDate: string; reason: string }>('/journal/manual', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  /** BR7: a visible dated reversal of a posted entry (a locked week is never edited in place). */
  reverseEntry(entryId: number, reason: string) {
    return this.post<{ reversalEntryId: number; reversalOf: number; postingDate: string }>(`/journal/${entryId}/reverse`, {
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
  }

  // ── Notifications ─────────────────────────────────────────────────────────────────────────
  notifications() {
    return this.get<{ unreadCount: number; notifications: Array<{ id: number; kind: string; payload: Record<string, unknown>; read: boolean; createdAt: string }> }>(
      '/notifications',
    )
  }
  markNotificationRead(id: number) {
    return this.post(`/notifications/${id}/read`)
  }

  // ── Attendance (SRS B-4 / س41) ────────────────────────────────────────────────────────────
  attendance(date?: string) {
    return this.get<{
      date: string
      attendance: Array<{ userId: string; name: string; firstSeenAt: string; lastSeenAt: string }>
    }>(date ? `/attendance?date=${encodeURIComponent(date)}` : '/attendance')
  }

  // ── Vehicle life log (SRS B-2 / س66) ──────────────────────────────────────────────────────
  vehicleEvents(vehicleId: string) {
    return this.get<{ events: VehicleEvent[] }>(`/vehicles/${vehicleId}/events`)
  }
  recordVehicleEvent(
    vehicleId: string,
    body: { kind: string; odometerKm?: number | null; cost?: string | null; notes?: string | null },
  ) {
    return this.post<VehicleEvent>(`/vehicles/${vehicleId}/events`, body)
  }

  // ── Orders a manager enters (Section C) ───────────────────────────────────────────────────
  /**
   * A manager adds an order on a driver's shift — either a Yallago delivery he is reconciling
   * (BR1's «missing order»), or a MANUAL job: the branch's own work, which carries no Yallago cut
   * and whose two shares are typed rather than derived from the day's band. For a manual order the
   * server refuses anything where `driverShare + companyShare !== fee`.
   */
  addManualOrder(
    shiftId: string,
    body: {
      providerOrderNo: string
      payMode: string
      fee: string
      zone?: string | null
      kind?: 'yallago' | 'manual'
      driverShare?: string | null
      companyShare?: string | null
      notes?: string | null
      points?: Array<{ role: 'start' | 'stop' | 'end'; label: string; lat?: number | null; lng?: number | null }>
    },
  ) {
    return this.post(`/shifts/${shiftId}/orders/manual`, body)
  }

  // ── Suspended / mid-shift incident (SRS C-1 / س29) ────────────────────────────────────────
  /** A manager suspends a live shift for a mid-shift incident. */
  suspendShift(shiftId: string, notes?: string | null) {
    return this.post<{ id: string; state: string }>(`/shifts/${shiftId}/suspend`, { notes: notes ?? null })
  }
  /** The driver resumes a suspended shift back to open. */
  resumeShift(shiftId: string) {
    return this.post<{ id: string; state: string }>(`/shifts/${shiftId}/resume`)
  }
  /** The driver reports a mid-shift incident to the branch (he can't suspend himself). */
  reportIncident(shiftId: string, notes?: string | null) {
    return this.post(`/shifts/${shiftId}/report-incident`, { notes: notes ?? null })
  }

  // ── Mid-day float / top-up tranche (SRS C-5) ──────────────────────────────────────────────
  /** A manager disburses a second (or later) cash float or wallet top-up to a live shift. */
  addTranche(shiftId: string, body: { kind: 'float' | 'topup'; amount: string; occurrenceKey: string }) {
    return this.post<{ id: string; kind: string; replayed: boolean }>(`/shifts/${shiftId}/tranche`, body)
  }

  // ── Upper-level shift override (stuck shift) ────────────────────────────────────────────────
  /** Void a stuck shift: reverse the float/top-up, discard orders, mark it cancelled. */
  voidShift(shiftId: string, reason: string) {
    return this.post<{ id: string; state: string }>(`/shifts/${shiftId}/void`, { reason })
  }
  /** Freeze a stuck shift's boundary/actuals, then settle its exact reviewed snapshot. */
  forceCloseShift(shiftId: string, body: {
    reason: string
    odometerKm?: number | null
    odometerAnomalyConfirmed?: boolean
    cashDeclared: string
    walletDeclared: string
  } & (
    | { prepareOnly: true }
    | {
        prepareOnly?: false
        reviewedSettlementHash: string
        walletTransferConfirmed: true
        cashSettlementConfirmed: true
        cashReceivableDeferred?: string
        walletReceivableDeferred?: string
        cashShortageReceivable?: string
      }
  )) {
    return this.post<{ id: string; state: string; postings: number; prepared: boolean }>(
      `/shifts/${shiftId}/force-close`,
      body,
    )
  }

  // ── Live GPS (SRS K) ────────────────────────────────────────────────────────────────────────
  /** The driver's phone posts a location fix while his shift is open (foreground-only). */
  sendGps(shiftId: string, body: { lat: number; lng: number; accuracyM: number | null; capturedAtMs: number }) {
    return this.post(`/shifts/${shiftId}/gps`, body)
  }
  /** The manager's live map: the latest fix per driver in the selected branch. */
  gpsLive() {
    return this.get<{ drivers: GpsLiveDriver[] }>('/gps/live')
  }

  // ── Documents (SRS B-1 / س37) ───────────────────────────────────────────────────────────────
  createDocument(body: {
    ownerKind: 'driver' | 'vehicle'
    driverId?: string | null
    vehicleId?: string | null
    kind: string
    issuedOn?: string | null
    expiresOn?: string | null
  }) {
    return this.post('/documents', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }
  /** The expiry board. Reading it also raises the bell for anything crossing a threshold band. */
  expiringDocuments() {
    return this.get<{
      today: string
      through: string
      documents: Array<{
        id: string
        kind: string
        ownerKind: 'driver' | 'vehicle'
        ownerName: string | null
        driverId: string | null
        vehicleId: string | null
        expiresOn: string | null
        status: string
      }>
    }>('/documents/expiring')
  }
}

/** Uploading evidence needs the shift id, package, slot and the compressed bytes. */
export function uploadEvidencePath(shiftId: string, pkg: 'start' | 'end', slot: string): string {
  return `/shifts/${shiftId}/media/${pkg}/${encodeURIComponent(slot)}`
}

/** Metadata returned after an evidence slot has actually been attached. */
export interface EvidenceUploadResponse {
  mediaId: string
  sha256: string
  byteSize: number
  deduped: boolean
  /** Server receipt time minus the file timestamp supplied by the picker. */
  clockSkewMs: number | null
  slots: string[]
  /** Another evidence slot or shift already attached these exact bytes; null for first use. */
  reusedFromShiftId: string | null
  /** Opaque generation token that prevents acknowledging a slot after it was replaced and restored. */
  attachmentToken: string
  /** The server has an explicit driver acknowledgement for stale/reused evidence. */
  staleAcknowledged: boolean
  /** Present for end-package evidence: the upload and draft revision advance atomically. */
  draft?: CloseDraftView
}

export function acknowledgeStaleEvidencePath(shiftId: string, pkg: 'start' | 'end', slot: string): string {
  return `${uploadEvidencePath(shiftId, pkg, slot)}/acknowledge-stale`
}

export function evidenceUploadHeaders(
  clientTakenAtMs: number | null,
  staleAcknowledged: boolean,
  options?: {
    expectedRevision?: number
    expectedAttachmentToken?: string | null
    replaceConfirmed?: boolean
  },
): Record<string, string> {
  return {
    ...(clientTakenAtMs !== null && clientTakenAtMs > 0
      ? { 'x-client-taken-at': String(clientTakenAtMs) }
      : {}),
    ...(staleAcknowledged ? { 'x-stale-evidence-acknowledged': 'true' } : {}),
    ...(options?.expectedRevision !== undefined
      ? { 'x-close-draft-revision': String(options.expectedRevision) }
      : {}),
    ...(options?.expectedAttachmentToken
      ? { 'x-expected-attachment-token': options.expectedAttachmentToken }
      : {}),
    ...(options?.replaceConfirmed ? { 'x-replace-confirmed': 'true' } : {}),
  }
}

/** Driver-scoped same-origin thumbnail; the session cookie remains httpOnly. */
export function closeDraftThumbnailPath(shiftId: string, mediaId: string): string {
  return `/api/shifts/${encodeURIComponent(shiftId)}/close-draft/media/${encodeURIComponent(mediaId)}/thumbnail`
}

/** Which screen the cloud reader is being asked about. Mirrors `OcrField` on the server. */
export type CloudOcrField = 'orders' | 'payments_log' | 'wallet' | 'odometer' | 'bms'

export interface CloudOcrResponse {
  ok: boolean
  cached: boolean
  /** Whether this exact image generation still owns its single explicit AI retry. */
  retryable: boolean
  reads: { used: number; max: number }
  rows: Array<{
    printed: string
    value: string | null
    cancelled: boolean
    reviewRequired?: boolean
    time: string | null
    dateIso: string | null
    /** Orders list only — the route, which is half of a row's identity in the merge. */
    pointA: string | null
    pointB: string | null
  }>
  fields: Record<string, string | null>
  reason?: 'unavailable' | 'timeout' | 'no_fields' | 'refused' | 'wrong_screen' | 'read_budget_exhausted'
}

/** A read-only, audited manager read of one explicit stored dashboard evidence attachment. */
export interface ManagerOrderEvidenceRereadResponse {
  ok: boolean
  cached: boolean
  retryable: boolean
  reads: { used: number; max: number }
  rows: CloudOcrResponse['rows']
  reason?: CloudOcrResponse['reason']
  evidence: {
    package: 'end'
    slot: string
    mediaId: string
    attachmentToken: string
  }
  /** The requested operation is audit context only; server-side row provenance is not claimed. */
  target:
    | { kind: 'order'; providerOrderNo: string; provenanceLinked: false }
    | { kind: 'cash_deduction'; id: string; operationKey: string; provenanceLinked: false }
  reviewedOrdersHash: string
  settlementHash: string
}

export type ManagerOrderEvidenceRereadTarget =
  | { kind: 'order'; providerOrderNo: string }
  | { kind: 'cash_deduction'; id?: string; operationKey?: string }

/**
 * Read one screen with the cloud model.
 *
 * A SEPARATE upload from the evidence one, carrying recognition-quality bytes, and that is the
 * point rather than an inefficiency: the evidence copy is compressed to 1280 px at quality 0.4 to
 * be cheap to store, which also puts its body text below what any reader can resolve. Wallet alone
 * sends a high-quality focus crop of the orange card; all other fields send the full image. See
 * `compressForOcr`.
 *
 * Never throws for a failed read — the server answers 200 with `ok: false` and a reason, because a
 * reader that can fail a request can fail a shift. It still throws for a malformed request (415 on
 * a body that is not an image, 403 on someone else's shift), which is a bug, not a bad photo.
 */
export function ocrReadPath(shiftId: string, field: CloudOcrField): string {
  return `/shifts/${shiftId}/ocr/${field}`
}

/**
 * Prepare a picked file and read it in the cloud. `null` only when no structured response arrived.
 *
 * A server response with `ok: false` is deliberately preserved: its reason tells the UI whether a
 * timeout is worth retrying or the pixels simply contained no readable field. Transport and local
 * preparation failures still return `null`, because no server reason exists for those cases.
 *
 * `compressForOcr` is imported lazily so the OCR path stays out of the entry bundle.
 */
export async function readInCloud(
  api: ApiClient,
  shiftId: string,
  field: CloudOcrField,
  file: Blob,
  retryFailed = false,
): Promise<CloudOcrResponse | null> {
  try {
    const { compressForOcr } = await import('./compress.ts')
    // The wallet card occupies only the upper third of a tall phone screenshot. Give AI that card
    // at full effective resolution; all other readers still need their whole screen/page.
    const prepared = await compressForOcr(file, field === 'wallet' ? 'wallet' : 'full')
    if (!prepared) return null
    const headers = {
      ...(retryFailed ? { 'x-ocr-retry': 'true' } : {}),
      // The time-consensus response may retain a paid row with `time: null` for manager review.
      // Older driver bundles discarded that row, so the API refuses their orders requests instead
      // of allowing a stale PWA to create a silent short-count.
      ...(field === 'orders' ? { 'x-ash-orders-time-consensus': 'close-draft-v1' } : {}),
    }
    const res = await api.putBytes<CloudOcrResponse>(
      ocrReadPath(shiftId, field),
      prepared.bytes,
      prepared.mimeType,
      headers,
      'POST',
    )
    return res
  } catch {
    return null
  }
}

// ── «التفقّد» ───────────────────────────────────────────────────────────────────────────

export interface CheckInWindowView {
  id: string
  userId: string
  /** Minutes past branch-local midnight. 600 = 10:00. */
  atMinute: number
  toleranceMinutes: number
  label: string | null
}

export interface CheckInView {
  id: string
  userId: string
  businessDate: string
  capturedAt: string
  lat: number
  lng: number
  accuracyM: number | null
  windowId: string | null
  distanceM: number
  insideArea: boolean
  minutesFromTarget: number | null
  verdict: 'on_time' | 'outside_window' | 'outside_area' | 'outside_both'
  note: string | null
}

export interface CheckInReportView {
  businessDate: string
  /**
   * What the server let this caller see: `all` for an auditor, `own` for the person being checked.
   * The screen renders from this rather than re-deriving it, so the two can never disagree.
   */
  scope: 'all' | 'own'
  radiusM: number | null
  people: Array<{
    userId: string
    name: string
    rounds: Array<{
      windowRef: string
      atMinute: number
      /** `missed` is the absence of a check-in, not a failure — the row with no answer. */
      status: 'on_time' | 'outside_area' | 'missed'
      distanceMetres: number | null
      minutesFromTarget: number | null
    }>
  }>
  checkIns: CheckInView[]
}
