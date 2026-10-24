/**
 * Who hears about support case activity, and how.
 *
 * The customer is notified through the platform notification pipeline
 * (in-app + templated email, preference-gated, never throws). The operators
 * are notified by plain email to SUPPORT_NOTIFY_EMAIL; when that is unset or
 * SMTP is unconfigured the case still exists in the admin queue, so every
 * send here is best-effort and a failure is logged, never surfaced.
 */
import { sendPlatformNotice } from '@/lib/auth/email'
import { deliverPlatformEmail, platformEmailConfigured } from '@/lib/email/platform-delivery'
import { escapeHtml } from '@/lib/notifications/email-templates'
import { createPlatformNotification } from '@/lib/notifications/platform'
import { SUPPORT_SEVERITIES } from './constants'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'

export interface TicketRef {
  id: string
  caseNumber: number
  subject: string
  severity: string
  category: string
}

function severityLabel(severity: string): string {
  return SUPPORT_SEVERITIES.find((s) => s.id === severity)?.label ?? severity
}

/** The inbox the deployment's operators read. Unset means nobody is emailed. */
function operatorInbox(): string | null {
  const v = process.env.SUPPORT_NOTIFY_EMAIL?.trim()
  return v || null
}

async function emailOperators(kind: string, subject: string, lines: string[], ticket: TicketRef): Promise<void> {
  const to = operatorInbox()
  if (!to || !platformEmailConfigured()) return
  const caseUrl = `${APP_URL}/app/support/${ticket.id}`
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0A0E1A;color:#f0f0f5;border-radius:12px;">
      <p style="margin:0 0 4px;color:#6b7280;font-size:12px;">Case #${ticket.caseNumber} · ${escapeHtml(severityLabel(ticket.severity))} · ${escapeHtml(ticket.category)}</p>
      <h1 style="font-size:18px;font-weight:700;margin:0 0 16px;color:#ffffff;">${escapeHtml(ticket.subject)}</h1>
      ${lines.map((l) => `<p style="color:#9ca3af;margin:0 0 10px;font-size:14px;line-height:1.6;white-space:pre-line;">${escapeHtml(l)}</p>`).join('')}
      <p style="margin:16px 0 0;"><a href="${caseUrl}" style="color:#a78bfa;">${caseUrl}</a></p>
    </div>`
  const text = [`Case #${ticket.caseNumber} [${severityLabel(ticket.severity)} / ${ticket.category}]`, ticket.subject, '', ...lines, '', caseUrl].join('\n')
  try {
    await deliverPlatformEmail(to, () => sendPlatformNotice({ kind, to, subject, html, text }))
  } catch (err: any) {
    console.warn(`[Support] operator email (${kind}) failed:`, err?.message)
  }
}

/** A new case was filed (or a customer replied): the team's queue grew. */
export async function notifyOperatorsOfCustomerMessage(
  ticket: TicketRef,
  customerEmail: string,
  body: string,
  event: 'created' | 'replied',
): Promise<void> {
  const subject =
    event === 'created'
      ? `[Support #${ticket.caseNumber}] ${severityLabel(ticket.severity)}: ${ticket.subject}`
      : `[Support #${ticket.caseNumber}] Customer replied: ${ticket.subject}`
  await emailOperators(event === 'created' ? 'support_case_created' : 'support_case_reply', subject, [
    `From ${customerEmail}`,
    body.length > 1200 ? `${body.slice(0, 1200)}…` : body,
  ], ticket)
}

/**
 * The AI first responder gave up on a case. The filing email went out before
 * it ran, so without this the team cannot tell a case that got an instant
 * answer from one that is waiting on a person alone, which is the one to pick
 * up first. `reason` is the recorded failure kind (spend_limit, timeout, …):
 * for the team, never shown to the customer.
 */
export async function notifyOperatorsOfMissedAnswer(ticket: TicketRef, reason: string): Promise<void> {
  await emailOperators(
    'support_ai_missed',
    `[Support #${ticket.caseNumber}] No instant answer (${reason}): ${ticket.subject}`,
    [
      `Backenly AI did not answer this case (${reason}). The customer was told the team will reply in the thread.`,
    ],
    ticket,
  )
}

/** The team answered or changed the case: tell the customer, their way. */
export async function notifyCustomerOfCaseUpdate(
  userId: string,
  ticket: TicketRef,
  title: string,
  body: string,
): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'support_update',
    title,
    body,
    metadata: { ticketId: ticket.id, caseNumber: ticket.caseNumber, subject: ticket.subject },
  })
}
