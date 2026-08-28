/**
 * Structured, privacy-preserving outcomes for outbound email.
 *
 * Mail delivery fails in ways that need different responses — a timeout, a
 * rejected credential, a refused recipient, a TLS problem — but a bare
 * `await transporter.sendMail(...)` discards the provider's result and a bare
 * `.catch(() => {})` discards the reason. Both outcomes then look identical
 * from the outside: nothing. These helpers record what happened in a form that
 * is safe to keep.
 *
 * SECURITY PROPERTIES
 *
 * - Verification and reset links are bearer credentials, so URL-shaped text is
 *   redacted from any recorded message.
 * - SMTP user and password are never touched; only the provider's response is
 *   inspected.
 * - Recipients are recorded as a bare domain, never as an address and never as
 *   a per-recipient identifier. The domain is kept because "all failures share
 *   one domain" is the most useful signal when a provider starts rejecting
 *   mail; anything narrower would build a durable handle on an individual
 *   without a transport-debugging reason to justify it.
 * - Nothing here reaches an HTTP response, so a caller cannot learn from a
 *   send outcome whether an account exists.
 *
 * Control flow is untouched: `observeSend` returns the provider's result on
 * success and rethrows the original error on failure, so existing callers keep
 * whatever fatal/non-fatal handling they already have.
 */
export type EmailFailureCategory =
  | 'timeout'
  | 'auth_failure'
  | 'recipient_rejected'
  | 'tls_error'
  | 'network_error'
  | 'provider_rejected'
  | 'not_configured'
  | 'unknown'

export type EmailOutcome =
  | { result: 'sent'; kind: string; recipient: string; messageId: string | null; accepted: number; rejected: number }
  | { result: 'failed'; kind: string; recipient: string; category: EmailFailureCategory; code: string | null; responseCode: number | null; detail: string }

/**
 * The recipient's domain, and nothing else.
 *
 * Deliberately NOT a per-recipient identifier. Diagnosing mail transport needs
 * to know which provider is misbehaving, not which person was written to, and a
 * stable digest of an address is a durable pseudonymous handle that this
 * subsystem has no reason to mint. Correlating a specific message uses the
 * provider's own message id (below), which the provider already holds.
 */
export function recipientDomain(email: string): string {
  const at = String(email ?? '').lastIndexOf('@')
  const domain = at >= 0 ? String(email).slice(at + 1).toLowerCase().trim() : ''
  return domain || 'unknown'
}

/**
 * Provider message id, kept only in a shape that is safe to store.
 *
 * It is retained because it is the one handle a provider's support can look up
 * when a message goes missing — `accepted` proves the provider took the message,
 * but not which one. Nodemailer builds it from the sender domain rather than
 * from recipient input, so it is not normally attacker- or user-controlled; the
 * guards here exist so that a provider echoing something unexpected cannot turn
 * this field into a place where an address lands. Dropped entirely if it
 * contains the recipient's local part, contains whitespace, or is oversized.
 */
export function sanitizeMessageId(raw: unknown, email: string): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim().replace(/^<|>$/g, '')
  if (!id || id.length > 120 || /\s/.test(id)) return null
  const at = String(email ?? '').lastIndexOf('@')
  const localPart = at > 0 ? String(email).slice(0, at).toLowerCase() : ''
  if (localPart && id.toLowerCase().includes(localPart)) return null
  return id
}

/**
 * Map a nodemailer error to a category an operator can act on.
 *
 * Ordering matters: a timeout carries `ETIMEDOUT`/`ESOCKET` and would otherwise
 * be swallowed by the generic network bucket, and `EAUTH` must outrank the 5xx
 * check because an auth rejection also carries a 5xx responseCode.
 */
export function classifyEmailError(err: unknown): { category: EmailFailureCategory; code: string | null; responseCode: number | null } {
  const e = (err ?? {}) as Record<string, unknown>
  const code = typeof e.code === 'string' ? e.code : null
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null
  const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase()

  let category: EmailFailureCategory = 'unknown'

  if (code === 'EAUTH' || responseCode === 535 || msg.includes('invalid login') || msg.includes('authentication failed')) {
    category = 'auth_failure'
  } else if (code === 'ETIMEDOUT' || code === 'ECONNECTION' && msg.includes('timeout') || msg.includes('timeout') || msg.includes('timed out')) {
    category = 'timeout'
  } else if (code === 'EENVELOPE' || responseCode === 550 || responseCode === 553 || msg.includes('invalid `to`') || msg.includes('recipient')) {
    category = 'recipient_rejected'
  } else if (code === 'ETLS' || msg.includes('tls') || msg.includes('certificate') || msg.includes('ssl')) {
    category = 'tls_error'
  } else if (code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EDNS' || msg.includes('econnrefused')) {
    category = 'network_error'
  } else if (typeof responseCode === 'number' && responseCode >= 500) {
    category = 'provider_rejected'
  }

  return { category, code, responseCode }
}

/** Short, safe description. Never carries a URL, token, or credential. */
function safeDetail(err: unknown): string {
  const m = (err as { message?: unknown })?.message
  const text = typeof m === 'string' ? m : String(err ?? 'unknown error')
  // Strip anything URL-shaped: a reset link is the credential itself.
  return text.replace(/https?:\/\/\S+/gi, '[url-redacted]').slice(0, 200)
}

/**
 * Describe a successful `sendMail` result. Counts only — the accepted and
 * rejected arrays hold addresses, so their contents never reach the log.
 */
export function describeSendSuccess(kind: string, email: string, info: unknown): EmailOutcome {
  const i = (info ?? {}) as Record<string, unknown>
  return {
    result: 'sent',
    kind,
    recipient: recipientDomain(email),
    messageId: sanitizeMessageId(i.messageId, email),
    accepted: Array.isArray(i.accepted) ? i.accepted.length : 0,
    rejected: Array.isArray(i.rejected) ? i.rejected.length : 0,
  }
}

/** Describe a failed send. */
export function describeSendFailure(kind: string, email: string, err: unknown): EmailOutcome {
  const { category, code, responseCode } = classifyEmailError(err)
  return {
    result: 'failed',
    kind,
    recipient: recipientDomain(email),
    category,
    code,
    responseCode,
    detail: safeDetail(err),
  }
}

/** Emit an outcome. A broken log sink must never affect the send. */
function emit(outcome: EmailOutcome, logger: (line: string) => void): void {
  try {
    logger(`[email] ${JSON.stringify(outcome)}`)
  } catch {
    /* intentionally ignored */
  }
}

/**
 * Observe a send without altering its control flow.
 *
 * Deliberately TRANSPARENT: the provider's result is returned on success and
 * the original error is rethrown unchanged on failure. Callers that already
 * treat email as non-fatal keep doing so, and callers that catch keep catching
 * the same error — this wrapper only ensures the outcome is recorded on the way
 * past. Swallowing here instead would silently convert throwing functions into
 * resolving ones and change every caller's contract.
 */
export async function observeSend<T>(
  kind: string,
  email: string,
  send: () => Promise<T>,
  logger: (line: string) => void = console.log,
): Promise<T> {
  try {
    const info = await send()
    emit(describeSendSuccess(kind, email, info), logger)
    return info
  } catch (err) {
    emit(describeSendFailure(kind, email, err), logger)
    throw err
  }
}

/**
 * Report that email could not be sent because no transport is configured.
 *
 * Verification, reset and invite links are bearer credentials: possession of
 * the URL is sufficient to act as the account. Printing them is a genuinely
 * useful local-development affordance and a credential disclosure anywhere
 * else, and "anywhere else" includes any self-hosted deployment whose logs are
 * shipped, retained, or read by more people than can act as those accounts.
 *
 * So the preview is gated on an explicit development environment, and every
 * other environment gets a structured line naming only the kind of mail that
 * could not be sent.
 *
 * This does NOT throw. Callers currently treat an unconfigured transport as a
 * no-op that resolves — one of them awaits without a catch — so raising here
 * would turn a missing SMTP setting into a failed invite or a failed signup,
 * and could make a reset request behave differently depending on whether an
 * account exists.
 */
export function reportUnconfigured(input: {
  kind: string
  email: string
  /** Development-only preview. Treated as a bearer credential everywhere else. */
  preview?: Record<string, string>
  isDevelopment?: boolean
  logger?: (line: string) => void
}): void {
  const dev = input.isDevelopment ?? process.env.NODE_ENV === 'development'
  const log = input.logger ?? console.log
  try {
    if (dev) {
      const detail = Object.entries(input.preview ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      log(
        `\n===== DEV EMAIL PREVIEW (${input.kind}) — not sent, SMTP not configured =====\n` +
          `To: ${input.email}\n${detail}\n` +
          `===== development only; never printed outside development =====\n`,
      )
      return
    }
    log(
      `[email] ${JSON.stringify({
        event: 'email_not_configured',
        kind: input.kind,
        recipient: recipientDomain(input.email),
      })}`,
    )
  } catch {
    /* a broken log sink must not affect the caller */
  }
}
