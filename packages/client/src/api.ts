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

/** Everything the driver's app needs to pick a half-finished shift back up where he left it. */
export interface ShiftStateView {
  id: string
  state: 'draft' | 'awaiting_open_approval' | 'open' | 'pending_review' | 'suspended' | 'approved' | 'week_locked'
  driverId: string
  vehicleId: string
  shiftNo: number
  businessDate: string
  startPackage: {
    odometerKm: number | null
    batteryPercent: number | null
    floatTotal: string
    topupTotal: string
    mediaSlots: string[]
    batteries: Array<{ batteryId: string; slotNo: number; percent: number | null }>
  }
  endPackage: {
    odometerKm: number | null
    batteryPercent: number | null
    cashDeclared: string | null
    walletDeclared: string | null
    mediaSlots: string[]
    batteries: Array<{ batteryId: string; slotNo: number; percent: number | null }>
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
export interface ExpenseView {
  id: string
  branchId: string
  categoryId: string
  costCenterKind: 'vehicle' | 'branch' | 'general'
  vehicleId: string | null
  /** Decimal string. */
  amount: string
  businessDate: string
  description: string
  receiptMediaId: string | null
  journalEntryId: number | null
  createdBy: string
}

/**
 * «الترميم» as the wire carries it. Every money field is a decimal STRING — the client never turns
 * money into a `number`, not even to display it.
 */
export interface RestorationLegView {
  fundCode: 'office_cash' | 'office_wallet'
  /** counted + الذمم — «الوضع الحالي». */
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
  /** Preview only: whether tonight's count has been sealed yet (decision j gates on this). */
  counted?: boolean
  legs: RestorationLegView[]
  netToCompany: string
  feasible: boolean
  refusals: Array<'sweep_exceeds_counted' | 'no_capital_target'>
}

/**
 * One pack's BMS reading. Scaled INTEGERS, never floats — millivolts, deci-amp-hours,
 * deci-Celsius — so 83.37 V is 83_370 and 50.0 Ah is 500.
 */
export interface BatteryReadingInput {
  batteryId: string
  percent: number | null
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

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = {
      method,
      credentials: 'include', // the session cookie, always
      headers: body instanceof Uint8Array ? headers : { 'content-type': 'application/json', ...headers },
    }
    if (body !== undefined) {
      init.body = body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body)
    }
    const res = await fetch(`${this.baseUrl}${path}`, init)

    const text = await res.text()
    const json = text ? (JSON.parse(text) as unknown) : null

    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; detail?: unknown }
      // The session, not this request, is what failed. Announced once so the app can drop to the
      // login screen; the error still throws, because the caller's own state is still wrong.
      // `login` itself answers 401 on a bad password — that is a failed ATTEMPT, not a lapsed
      // session, and signing the user out of a screen he is not signed in to helps nobody.
      if (res.status === 401 && !path.endsWith('/auth/login')) this.onUnauthorized?.()
      throw { status: res.status, error: err.error ?? 'unknown', detail: err.detail } satisfies ApiError
    }
    return json as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', this.scoped(path))
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
  putBatteryReadings(shiftId: string, pkg: 'start' | 'end', readings: BatteryReadingInput[]) {
    return this.put<{ readings: BatteryReadingInput[] }>(`/shifts/${shiftId}/battery-readings`, {
      package: pkg,
      readings,
    })
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
    return this.get<{ receiptCeilingMinor: string | null; kwhPriceMinor: string | null }>('/settings')
  }
  /** Money fields are decimal strings ("50000.00"); only what is sent changes. */
  updateSettings(body: { receiptCeilingMinor?: string; kwhPriceMinor?: string }) {
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
    categoryId: string
    costCenterKind: 'vehicle' | 'branch' | 'general'
    vehicleId?: string | null
    amount: string
    description: string
    businessDate?: string
    receiptMediaId?: string | null
  }) {
    return this.post<ExpenseView>('/expenses', { ...body, ...(this.branchId ? { branchId: this.branchId } : {}) })
  }

  /** «كشف التسوية» — read-only. Posts nothing; it only shows where tonight's cash would go. */
  shiftSettlement(shiftId: string, choices: { keepAsReceivable?: string; payShareNow?: boolean } = {}) {
    const q = new URLSearchParams()
    if (choices.keepAsReceivable) q.set('keepAsReceivable', choices.keepAsReceivable)
    if (choices.payShareNow !== undefined) q.set('payShareNow', String(choices.payShareNow))
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return this.get<{
      toOfficeCash: string
      keptAsReceivable: string
      paidToDriver: string
      withheldFromShare: string
      residualReceivable: string
      shareRemainingPayable: string
      lines: Array<{ code: string; amount: string }>
      feasible: boolean
      refusals: string[]
    }>(`/shifts/${shiftId}/settlement${suffix}`)
  }

  // ── Branch treasury (cash box + wallet) ─────────────────────────────────────────────────────
  treasuryBalances() {
    return this.get<{ cash: string; wallet: string }>('/treasury/balances')
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

  /** What tonight's ترميم WOULD do, read from the sealed count. Posts nothing. */
  restorationPreview() {
    return this.get<RestorationView>(`/treasury/restoration/preview${this.branchId ? `?branchId=${this.branchId}` : ''}`)
  }
  /** Performs it. The plan is re-derived server-side from the count — nothing here is trusted. */
  restore(reason: string) {
    return this.post<RestorationView & { postings: number }>('/treasury/restoration', {
      reason,
      ...(this.branchId ? { branchId: this.branchId } : {}),
    })
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
  addTranche(shiftId: string, body: { kind: 'float' | 'topup'; amount: string; occurrenceKey?: string }) {
    return this.post<{ id: string; kind: string }>(`/shifts/${shiftId}/tranche`, body)
  }

  // ── Upper-level shift override (stuck shift) ────────────────────────────────────────────────
  /** Void a stuck shift: reverse the float/top-up, discard orders, mark it cancelled. */
  voidShift(shiftId: string, reason: string) {
    return this.post<{ id: string; state: string }>(`/shifts/${shiftId}/void`, { reason })
  }
  /** Force-close a stuck shift, settling any declared-vs-expected gap to a variance. */
  forceCloseShift(shiftId: string, body: { reason: string; odometerKm?: number | null; cashDeclared?: string | null; walletDeclared?: string | null }) {
    return this.post<{ id: string; state: string; postings: number }>(`/shifts/${shiftId}/force-close`, body)
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

/** Which screen the cloud reader is being asked about. Mirrors `OcrField` on the server. */
export type CloudOcrField = 'orders' | 'payments_log' | 'wallet' | 'odometer' | 'bms'

export interface CloudOcrResponse {
  ok: boolean
  cached: boolean
  reads: { used: number; max: number }
  rows: Array<{ printed: string; value: string | null; cancelled: boolean }>
  fields: Record<string, string | null>
  reason?: 'unavailable' | 'timeout' | 'no_fields' | 'refused'
}

/**
 * Read one screen with the cloud model.
 *
 * A SEPARATE upload from the evidence one, carrying LARGER bytes, and that is the point rather
 * than an inefficiency: the evidence copy is compressed to 1280 px at quality 0.4 to be cheap to
 * store, which also puts its body text below what any reader can resolve. See `compressForOcr`.
 *
 * Never throws for a failed read — the server answers 200 with `ok: false` and a reason, because a
 * reader that can fail a request can fail a shift. It still throws for a malformed request (415 on
 * a body that is not an image, 403 on someone else's shift), which is a bug, not a bad photo.
 */
export function ocrReadPath(shiftId: string, field: CloudOcrField): string {
  return `/shifts/${shiftId}/ocr/${field}`
}

/**
 * Prepare a picked file and read it in the cloud. `null` for every failure, of any kind.
 *
 * One return value for "offline", "no provider configured", "past the shift's cap", "the model
 * timed out" and "this image is too big to send", because the caller's response to all five is
 * identical: keep the on-device reading. Distinguishing them would be UI that shows a driver a
 * distinction he cannot act on.
 *
 * `compressForOcr` is imported lazily so the OCR path stays out of the entry bundle.
 */
export async function readInCloud(
  api: ApiClient,
  shiftId: string,
  field: CloudOcrField,
  file: Blob,
): Promise<CloudOcrResponse | null> {
  try {
    const { compressForOcr } = await import('./compress.ts')
    const prepared = await compressForOcr(file)
    if (!prepared) return null
    const res = await api.putBytes<CloudOcrResponse>(
      ocrReadPath(shiftId, field),
      prepared.bytes,
      prepared.mimeType,
      {},
      'POST',
    )
    return res.ok ? res : null
  } catch {
    return null
  }
}
