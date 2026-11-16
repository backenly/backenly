/**
 * The Auth & Users page's reads and writes, in one place.
 *
 * The user routes resolve the project from the `X-Project-Id` header for the
 * caller (lib/tenant/isolation.ts); the bearer token is sent beside the cookie
 * for the same reason the rest of the console does. A refusal comes back as an
 * Error in the server's own words, so the page can show it on the row it came
 * from.
 */

export interface EndUser {
  id: string
  email: string
  name: string | null
  /** 'email', 'google', 'github'… */
  provider: string
  lastLogin: string | null
  createdAt: string | null
  isBlocked: boolean
}

export interface UsersPage {
  users: EndUser[]
  total: number
  page: number
  totalPages: number
}

export interface AuthStats {
  totalUsers: number
  activeUsers: number
  verifications: number
  signups24h: number
}

export function authHeaders(projectId: string, json = false): HeadersInit {
  const headers: Record<string, string> = { 'X-Project-Id': projectId }
  if (json) headers['Content-Type'] = 'application/json'
  try {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('auth-token') : null
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // Blocked storage: the cookie still authenticates.
  }
  return headers
}

/** The JSON body, or an Error carrying the server's own words. */
export async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body && typeof body === 'object' && 'success' in body && body.success === false)) {
    // Some routes put a summary in `error` and the database's reason in `message`.
    const error = typeof body?.error === 'string' ? body.error : ''
    const message = typeof body?.message === 'string' ? body.message : ''
    const said = error && message && message !== error ? `${error}: ${message}` : error || message
    throw new Error(said || fallback)
  }
  return body as T
}

export const USERS_PAGE_SIZE = 50

export async function fetchUsers(projectId: string, opts: { page: number; search: string }): Promise<UsersPage> {
  const qs = new URLSearchParams({ limit: String(USERS_PAGE_SIZE), page: String(opts.page) })
  if (opts.search) qs.set('search', opts.search)
  const res = await fetch(`/api/auth/users?${qs.toString()}`, { headers: authHeaders(projectId), credentials: 'include', cache: 'no-store' })
  const data = await readJson<{ users?: any[]; pagination?: { total?: number; page?: number; totalPages?: number } }>(res, 'The users could not be read.')
  const users: EndUser[] = (data.users ?? []).map((u) => ({
    id: String(u.id),
    email: String(u.email ?? ''),
    name: typeof u.name === 'string' && u.name.trim() ? u.name.trim() : null,
    provider: typeof u.provider === 'string' && u.provider ? u.provider : 'email',
    lastLogin: u.lastLogin ?? null,
    createdAt: u.createdAt ?? null,
    isBlocked: !!u.isBlocked,
  }))
  const total = data.pagination?.total ?? users.length
  return { users, total, page: data.pagination?.page ?? opts.page, totalPages: Math.max(1, data.pagination?.totalPages ?? 1) }
}

export async function fetchStats(projectId: string): Promise<AuthStats> {
  const res = await fetch('/api/auth/users/stats', { headers: authHeaders(projectId), credentials: 'include', cache: 'no-store' })
  const data = await readJson<Partial<AuthStats>>(res, 'The user counts could not be read.')
  return {
    totalUsers: data.totalUsers ?? 0,
    activeUsers: data.activeUsers ?? 0,
    verifications: data.verifications ?? 0,
    signups24h: data.signups24h ?? 0,
  }
}

/**
 * Block or unblock an end user: `users.is_blocked`, which sign-in enforces.
 * Through the Database page's own row update (the users table lives in the
 * project's workspace schema), so no new route was needed for it.
 */
export async function setBlocked(projectId: string, userId: string, blocked: boolean): Promise<void> {
  const qs = new URLSearchParams({ type: 'postgresql', table: 'users', schema: `workspace_${projectId}`, projectId })
  const res = await fetch(`/api/database/rows/${encodeURIComponent(userId)}?${qs.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ data: { is_blocked: blocked } }),
  })
  await readJson(res, blocked ? 'The user could not be blocked.' : 'The user could not be unblocked.')
}
