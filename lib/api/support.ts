// Client-side API helpers for the Support Center (Backenly Cloud).

export interface SupportLevel {
  plan: string
  targetResponseHours: number | null
  priority: boolean
  allowedSeverities: string[]
}

export interface TicketSummary {
  id: string
  caseNumber: number
  subject: string
  category: string
  severity: string
  status: string
  aiState: string
  projectId: string | null
  lastMessageAt: string
  lastMessageBy: string
  createdAt: string
}

export interface TicketMessage {
  id: string
  author: 'user' | 'ai' | 'staff'
  body: string
  createdAt: string
}

export interface TicketDetail extends TicketSummary {
  message: string
  resolvedAt: string | null
  resolvedBy: string | null
  project: { id: string; name: string } | null
  messages: TicketMessage[]
}

export class SupportApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'SupportApiError'
    this.status = status
    this.code = code
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    const token = localStorage.getItem('auth-token')
    if (token) headers['Authorization'] = `Bearer ${token}`
  } catch {
    // Storage can be blocked; the session cookie still authenticates.
  }
  const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, credentials: 'include', cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new SupportApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code)
  }
  return data as T
}

export function listSupportTickets(status: 'open' | 'resolved' | 'all' = 'all') {
  return call<{ tickets: TicketSummary[]; level: SupportLevel }>(`/api/support/tickets?status=${status}`)
}

export function createSupportTicket(input: {
  subject: string
  message: string
  category: string
  severity: string
  projectId?: string | null
}) {
  return call<{ ticket: TicketSummary }>(`/api/support/tickets`, { method: 'POST', body: JSON.stringify(input) })
}

export function getSupportTicket(id: string) {
  return call<{ ticket: TicketDetail }>(`/api/support/tickets/${encodeURIComponent(id)}`)
}

export function replyToSupportTicket(id: string, body: string) {
  return call<{ message: TicketMessage }>(`/api/support/tickets/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

export function patchSupportTicket(id: string, action: 'resolve' | 'reopen') {
  return call<{ ticket: TicketSummary }>(`/api/support/tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  })
}

/** "3m ago" / "2h ago" / "5d ago" — enough resolution for a case list. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
