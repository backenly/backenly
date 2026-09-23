/**
 * DELIVERING MAIL THAT A FLOW CANNOT CONTINUE WITHOUT
 * ===================================================
 * Password reset and signup codes used to be sent fire-and-forget, with every
 * error swallowed, and the page said "sent" regardless. Production spent days
 * rejecting every message ("550 The backenly.com domain is not verified") while
 * each person who asked for a reset was told to check their inbox.
 *
 * A code that never arrives is a dead end, so these sends are awaited and a
 * delivery failure is reported to the person as what it is. One exception: a
 * refusal of that particular recipient is answered like a success, because
 * telling a stranger "we could not deliver to that address" is telling them an
 * account lives there.
 */
import { readEnvSmtpCredentials } from './smtp-transport'
import { classifyEmailError, type EmailFailureCategory } from './send-outcome'
import { currentEdition } from '@/lib/edition'

/** Long enough for a slow provider, short enough that a firewalled one does not hang the page. */
export const PLATFORM_EMAIL_TIMEOUT_MS = 10_000

/** Whether this deployment has a transport for Backenly's own account mail at all. */
export function platformEmailConfigured(): boolean {
  return readEnvSmtpCredentials() !== null
}

/** Raised by a code-mail sender when there is no transport to send through. */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Platform SMTP is not configured')
    this.name = 'EmailNotConfiguredError'
  }
}

/** The mail a flow depends on could not be delivered, for a reason on our side. */
export class EmailDeliveryUnavailableError extends Error {
  constructor(readonly category: EmailFailureCategory) {
    super(`Platform email delivery failed: ${category}`)
    this.name = 'EmailDeliveryUnavailableError'
  }
}

/**
 * Did the provider refuse THIS recipient, and nothing else?
 *
 * Only such a refusal may be reported as success, and only because naming it
 * would tell a stranger an account lives at that address. Everything else on
 * our side must stay visible.
 *
 * `EENVELOPE` alone is not proof of that. Nodemailer raises it for the whole
 * envelope: a sender address the provider rejected, a message with no
 * recipients defined, an unverified sending domain refused at MAIL FROM. So
 * the error has to attribute the refusal to this address specifically:
 *
 *   - the failing command is RCPT TO, when the error names one;
 *   - the rejected list is exactly this recipient;
 *   - there IS an SMTP status, and every one given is a permanent 5xx. A
 *     4xx is greylisting or a full mailbox, which is a retry, not a refusal,
 *     and a missing status proves nothing either way.
 *
 * Masking on the bare code was how a configuration fault could hide again,
 * which is the failure this module exists to end.
 */
export function isRecipientRefusal(err: unknown, recipient: string): boolean {
  const e = (err ?? {}) as Record<string, unknown>
  if (e.code !== 'EENVELOPE') return false

  const command = typeof e.command === 'string' ? e.command.toUpperCase().trim() : ''
  if (command && command !== 'RCPT TO') return false

  const wanted = String(recipient ?? '').trim().toLowerCase()
  if (!wanted) return false
  const rejected = Array.isArray(e.rejected)
    ? e.rejected.map(r => String((r as { address?: unknown })?.address ?? r).trim().toLowerCase())
    : []
  if (rejected.length === 0) return false
  if (!rejected.every(r => r === wanted)) return false

  // The refusal must be PROVEN permanent: at least one SMTP status, and every
  // status a 5xx. No status at all is not proof of anything, and was masked
  // before, because "no code is below 500" is also true of an empty list. A
  // 4xx is greylisting or a full mailbox, which clears on its own.
  const codes = [
    e.responseCode,
    ...(Array.isArray(e.rejectedErrors) ? e.rejectedErrors.map(r => (r as { responseCode?: unknown })?.responseCode) : []),
  ].filter((c): c is number => typeof c === 'number')
  if (codes.length === 0) return false
  if (!codes.every(c => c >= 500 && c <= 599)) return false

  return true
}

/**
 * Send, wait for the provider's answer, and say what happened.
 *
 * `recipient` is the address being written to, because "the provider refused
 * this one address" can only be decided against it.
 */
export async function deliverPlatformEmail(
  recipient: string,
  send: () => Promise<unknown>,
): Promise<'sent' | 'recipient_refused'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      send(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('email send timed out'), { code: 'ETIMEDOUT' })),
          PLATFORM_EMAIL_TIMEOUT_MS,
        )
      }),
    ])
    return 'sent'
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) throw new EmailDeliveryUnavailableError('not_configured')
    if (isRecipientRefusal(err, recipient)) return 'recipient_refused'
    throw new EmailDeliveryUnavailableError(classifyEmailError(err).category)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The refusal a page shows when mail cannot go out.
 *
 * Deployment-wide, and asked before any account lookup, so it says nothing
 * about who has an account. A self-hosted operator is told how to recover
 * without email, because on their machine they can.
 */
export function emailUnavailableBody(reason: 'not_configured' | 'failed'): {
  error: string
  code: 'EMAIL_DELIVERY_UNAVAILABLE'
  selfHosted: boolean
} {
  const selfHosted = currentEdition() === 'single-tenant'
  let error: string
  if (reason === 'not_configured') {
    error = selfHosted
      ? 'Email is not configured on this server, so no code can be sent. ' +
        'The operator can set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in .env, ' +
        'or reset a password directly with: npm run auth:reset-password -- --email you@example.com'
      : 'Email is temporarily unavailable, so no code can be sent. Please try again later or contact support.'
  } else {
    error = selfHosted
      ? 'This server could not send email just now. Check the SMTP settings and the server log ' +
        '(lines starting with [email]), or reset a password directly with: npm run auth:reset-password -- --email you@example.com'
      : 'We could not send email just now. Please try again in a few minutes or contact support.'
  }
  return { error, code: 'EMAIL_DELIVERY_UNAVAILABLE', selfHosted }
}
