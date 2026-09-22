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
 * Send, wait for the provider's answer, and say what happened.
 *
 * Returns 'recipient_refused' only for nodemailer's EENVELOPE: the provider
 * accepted the connection and the sender, and refused this one address. Every
 * other failure is ours, and throws.
 */
export async function deliverPlatformEmail(send: () => Promise<unknown>): Promise<'sent' | 'recipient_refused'> {
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
    if ((err as { code?: unknown })?.code === 'EENVELOPE') return 'recipient_refused'
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
