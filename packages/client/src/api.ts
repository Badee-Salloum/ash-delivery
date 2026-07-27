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
  orders: Array<{ providerOrderNo: string; payMode: 'cash' | 'electronic' | 'free'; fee: string; zone: string | null }>
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
  source?: 'ocr' | 'manual'
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

  /** Raw bytes for evidence upload — never base64, never multipart. */
  putBytes<T>(path: string, bytes: Uint8Array, contentType: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    return this.request<T>('PUT', path, bytes, { 'content-type': contentType, ...extraHeaders })
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
      vehicleTypes: Array<{ id: string; code: string; nameAr: string; nameEn: string; typeNo: number; active: boolean }>
    }>('/vehicle-types')
  }
  createVehicleType(body: { code: string; nameAr: string; nameEn: string; typeNo: number }) {
    return this.post<{ id: string }>('/vehicle-types', body)
  }
  /** Changing `typeNo` restates the printed number of every vehicle of this type. */
  updateVehicleType(id: string, body: { nameAr?: string; nameEn?: string; typeNo?: number; active?: boolean }) {
    return this.patch<{ id: string }>(`/vehicle-types/${id}`, body)
  }

  /** What the next bike of this type would be called — for the live preview on the add form. */
  nextVehicleNumber(vehicleTypeId: string) {
    return this.get<{ code: string; machineNo: number }>(
      `/vehicles/next-number?vehicleTypeId=${encodeURIComponent(vehicleTypeId)}`,
    )
  }
  createVehicle(body: { vehicleTypeId: string; machineNo?: number; plateNo?: string | null }) {
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

  // ── Manual orders (Section C) ─────────────────────────────────────────────────────────────
  /** A higher-level manager adds a manual order to reconcile a shift (fixes BR1's «missing order»). */
  addManualOrder(shiftId: string, body: { providerOrderNo: string; payMode: string; fee: string; zone?: string | null }) {
    return this.post(`/shifts/${shiftId}/orders/manual`, body)
  }
  /** A driver asks a manager to add an order he can no longer add himself. */
  requestManualOrder(shiftId: string, body: { providerOrderNo: string; payMode: string; fee: string; zone?: string | null }) {
    return this.post(`/shifts/${shiftId}/orders/request`, body)
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
  addTranche(shiftId: string, body: { kind: 'float' | 'topup'; amount: string }) {
    return this.post<{ id: string; kind: string }>(`/shifts/${shiftId}/tranche`, body)
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
