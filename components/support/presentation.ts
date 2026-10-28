/**
 * How support case states render, shared by the Support Center pages.
 * Labels come from lib/support/constants.ts so the form, the API and the list
 * always speak the same words; this file only adds tones, docs links and the
 * customer-facing copy for what the AI first responder did.
 */
import {
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from '@/lib/support/constants'

/** Status → badge, from the customer's point of view. */
export const STATUS_BADGE: Record<string, { tone: 'operational' | 'managed' | 'attention' | 'neutral'; label: string }> = {
  open: { tone: 'managed', label: 'With the team' },
  waiting_on_customer: { tone: 'attention', label: TICKET_STATUS_LABELS.waiting_on_customer },
  resolved: { tone: 'operational', label: TICKET_STATUS_LABELS.resolved },
  closed: { tone: 'neutral', label: TICKET_STATUS_LABELS.closed },
}

export const SEVERITY_TAG_TONE: Record<string, 'neutral' | 'warn' | 'bad'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warn',
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

/** "Oct 22, 2026, 11:41 PM" in the reader's locale, for titles and detail rows. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? DATE_TIME.format(d) : ''
}

/** The team's first-reply target for a plan, in words. */
export function teamTargetLabel(hours: number | null | undefined): string {
  if (!hours) return 'Best effort'
  if (hours < 48) return `Within ${hours} hours`
  return `Within ${Math.round(hours / 24)} days`
}
