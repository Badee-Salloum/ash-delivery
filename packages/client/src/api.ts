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

export class ApiClient {
  private readonly baseUrl: string

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
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
    return this.request<T>('GET', path)
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

  // ── Branch treasury (cash box + wallet) ─────────────────────────────────────────────────────
  treasuryBalances() {
    return this.get<{ cash: string; wallet: string }>('/treasury/balances')
  }
  treasuryDeposit(target: 'cash' | 'wallet', amount: string, note?: string) {
    return this.post<{ target: string; balance: string }>('/treasury/deposit', { target, amount, note })
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
}

/** Uploading evidence needs the shift id, package, slot and the compressed bytes. */
export function uploadEvidencePath(shiftId: string, pkg: 'start' | 'end', slot: string): string {
  return `/shifts/${shiftId}/media/${pkg}/${encodeURIComponent(slot)}`
}
