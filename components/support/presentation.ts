/**
 * How support cases read, shared by the Support pages (list, new case, case).
 * Labels come from lib/support/constants.ts so the form, the API and the list
 * always speak the same words; this file adds the states as the customer sees
 * them, who wrote last, docs links, times, and the customer-facing copy for
 * what the AI first responder did.
 */
import {
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from '@/lib/support/constants'
import { timeAgo } from '@/lib/api/support'

/**
 * The Backenly community server, as the site header links it
 * (components/site/SiteShell.tsx ROUTES.discord, an invite that never expires).
 * A literal rather than an import: SiteShell is the marketing shell and would
 * bring its icon registry into the console, as app/contact/page.tsx notes too.
 */
export const COMMUNITY_URL = 'https://discord.gg/6cHeYXDAu3'

/**
 * A case's state from the customer's side. Only "waiting on you" asks for
 * anything, so it is the only state a list writes out; the others are glyphs.
 */
export type CaseState = 'waiting' | 'open' | 'resolved' | 'closed'

export function caseState(status: string): CaseState {
  if (status === 'waiting_on_customer') return 'waiting'
  if (status === 'resolved') return 'resolved'
  if (status === 'closed') return 'closed'
  return 'open'
}

export const CASE_STATE_LABEL: Record<CaseState, string> = {
  waiting: TICKET_STATUS_LABELS.waiting_on_customer,
  open: 'With the team',
  resolved: TICKET_STATUS_LABELS.resolved,
  closed: TICKET_STATUS_LABELS.closed,
}

export const isOpenStatus = (status: string) => status === 'open' || status === 'waiting_on_customer'

/** The two severities that mean a live backend is hurting; only these earn a tag in a list. */
export const isProductionSeverity = (severity: string) => severity === 'high' || severity === 'urgent'

/** Production down reads as a failure (white text in its tag); production impaired stays neutral. */
export const SEVERITY_TAG_TONE: Record<string, 'neutral' | 'bad'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'neutral',
  urgent: 'bad',
}

export function categoryLabel(id: string): string {
  return SUPPORT_CATEGORIES.find((c) => c.id === id)?.label ?? id
}

export function severityLabel(id: string): string {
  return SUPPORT_SEVERITIES.find((s) => s.id === id)?.label ?? id
}

export function statusLabel(id: string): string {
  return TICKET_STATUS_LABELS[id as TicketStatus] ?? id
}

/** Who wrote last and when: "Team replied 40m ago", "You replied 2h ago". */
export function lastReplyText(by: string, at: string): string {
  const who = by === 'staff' ? 'Team' : by === 'ai' ? 'Backenly AI' : 'You'
  return `${who} replied ${timeAgo(at)}`
}

/**
 * The /docs pages most likely to answer a case of each category. /docs is
 * written for people; the agent docs the AI reads are never linked from here.
 */
export const CATEGORY_DOCS: Record<string, Array<{ title: string; href: string }>> = {
  agent: [{ title: 'Connect your coding agent', href: '/docs/connect' }],
  api: [{ title: 'Connect your app', href: '/docs/connect' }],
  database: [{ title: 'Database', href: '/docs/database' }],
  auth: [{ title: 'Auth & Users', href: '/docs/auth' }],
  storage: [{ title: 'Storage', href: '/docs/storage' }],
  functions: [{ title: 'Functions', href: '/docs/functions' }],
  realtime: [{ title: 'Realtime', href: '/docs/realtime' }],
  deploy: [
    { title: 'Deploy', href: '/docs/deploy' },
    { title: 'Branches', href: '/docs/branches' },
  ],
  billing: [{ title: 'Plans and pricing', href: '/pricing' }],
  account: [{ title: 'Project settings', href: '/docs/settings' }],
  security: [{ title: 'Keys and access', href: '/docs/connect' }],
  other: [{ title: 'Documentation', href: '/docs' }],
}

export function docsFor(category: string): Array<{ title: string; href: string }> {
  return CATEGORY_DOCS[category] ?? CATEGORY_DOCS.other
}

/**
 * What to tell the customer when the AI first responder did not answer. The
 * reason recorded on the case (aiError) is for the team's queue; the customer
 * gets what it means for them, never the internal cause.
 */
export function aiShortfall(aiState: string, aiError: string | null): string {
  if (aiState === 'unavailable') return 'Instant answers are not available right now.'
  switch (aiError) {
    case 'spend_limit':
    case 'quota_exhausted':
    case 'access_denied':
    case 'invalid_request':
    case 'not_configured':
      return 'Instant answers are not available right now.'
    case 'refused':
      return 'Backenly AI could not answer this case.'
    default:
      return 'Backenly AI did not answer in time.'
  }
}

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const MONTH_DAY_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "Oct 22, 2026, 11:41 PM" in the reader's locale, for hover titles. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? DATE_TIME.format(d) : ''
}

/** "Nov 15, 8:31 PM": the year only when it is not this one. */
export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.getFullYear() === new Date().getFullYear() ? MONTH_DAY_TIME.format(d) : DATE_TIME.format(d)
}

/** A span of time to the precision a reply time deserves: "41 s", "12 m", "3 h 12 m", "2 d 4 h". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(s, 1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

/** The team's first-reply target for a plan, in words. */
export function teamTargetLabel(hours: number | null | undefined): string {
  if (!hours) return 'Best effort'
  if (hours < 48) return `Within ${hours} hours`
  return `Within ${Math.round(hours / 24)} days`
}
