/**
 * How support case states render, shared by the Support Center pages.
 * Labels come from lib/support/constants.ts so the form, the API and the list
 * always speak the same words; this file only adds tones.
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
