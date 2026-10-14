/**
 * The support case vocabulary: categories, severities, statuses and limits.
 *
 * Kept in one file so the words the form offers, the words the API validates
 * and the words the admin queue filters by cannot drift apart. Severity is
 * AWS-shaped (general guidance → production down) because that is the scheme
 * developers already know how to pick from.
 */
import type { UserEntitlements } from '@/lib/entitlements/types'

export const SUPPORT_CATEGORIES = [
  { id: 'database', label: 'Database' },
  { id: 'api', label: 'API & runtime' },
  { id: 'auth', label: 'Auth & users' },
  { id: 'storage', label: 'Storage' },
  { id: 'functions', label: 'Functions' },
  { id: 'realtime', label: 'Realtime' },
  { id: 'deploy', label: 'Deployments' },
  { id: 'agent', label: 'Agent & MCP connection' },
  { id: 'billing', label: 'Billing & plans' },
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security report' },
  { id: 'other', label: 'Something else' },
] as const

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]['id']

export const SUPPORT_SEVERITIES = [
  {
    id: 'low',
    label: 'General guidance',
    blurb: 'A question about how something works. Nothing is broken.',
    paidOnly: false,
  },
  {
    id: 'normal',
    label: 'System impaired',
    blurb: 'Something behaves wrongly, but you can keep working.',
    paidOnly: false,
  },
  {
    id: 'high',
    label: 'Production impaired',
    blurb: 'A live backend is degraded. End users are affected.',
    paidOnly: true,
  },
  {
    id: 'urgent',
    label: 'Production down',
    blurb: 'A live backend is down or unusable.',
    paidOnly: true,
  },
] as const

export type SupportSeverity = (typeof SUPPORT_SEVERITIES)[number]['id']

export const TICKET_STATUSES = ['open', 'waiting_on_customer', 'resolved', 'closed'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  waiting_on_customer: 'Waiting on you',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const TICKET_SUBJECT_MAX = 160
export const TICKET_BODY_MIN = 10
export const TICKET_BODY_MAX = 10_000

/** Creation and reply ceilings per user per hour (lib/middleware/rateLimiter.ts keys). */
export const TICKET_CREATE_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 }
export const TICKET_REPLY_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 }

export function isSupportCategory(v: unknown): v is SupportCategory {
  return typeof v === 'string' && SUPPORT_CATEGORIES.some((c) => c.id === v)
}

export function isSupportSeverity(v: unknown): v is SupportSeverity {
  return typeof v === 'string' && SUPPORT_SEVERITIES.some((s) => s.id === v)
}

/**
 * Whether this account may file at this severity.
 *
 * The production severities (high, urgent) need a paid plan, like AWS reserves
 * its production severities for paid support tiers. `null` entitlements is
 * Cloud's "no active subscription" and gets the free rules — someone whose
 * billing is broken must still be able to file a ticket about it.
 */
export function severityAllowedOnPlan(ent: UserEntitlements | null, severity: SupportSeverity): boolean {
  const def = SUPPORT_SEVERITIES.find((s) => s.id === severity)
  if (!def) return false
  if (!def.paidOnly) return true
  return ent ? !ent.isSandboxPlan : false
}
