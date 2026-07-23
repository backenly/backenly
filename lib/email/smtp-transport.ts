/**
 * SHARED SMTP TRANSPORT
 * =====================
 * The single place Backenly turns SMTP config into a nodemailer transport.
 *
 * WHY THIS EXISTS
 * ---------------
 * Port 465 (implicit TLS / SMTPS) is blocked OUTBOUND on our production host
 * (Hetzner blocks 465). A user who pastes their provider's "465" snippet gets
 * silently-failing email — and a scary "SMTP unreachable" item in their review
 * queue that they have no lever to fix.
 *
 * Every major provider — Resend, SendGrid, Mailgun, Amazon SES, Gmail — also
 * serves STARTTLS on port 587, which is NOT blocked and delivers identical
 * mail. So we normalize 465 -> 587 by default. Non-technical users get working
 * email with zero knowledge of TLS modes or firewall rules.
 *
 * Escape hatch: set SMTP_ALLOW_IMPLICIT_TLS=true to honor 465 as-is (for
 * self-hosters on infra where 465 is open and 587 happens to be closed).
 *
 * Keep ALL transport construction going through here so that email sending and
 * the integration-health probe always agree on the effective port.
 */

/** Effective transport parameters after applying the 465 -> 587 normalization. */
export interface EffectiveSmtp {
  /** Port we actually connect on (465 rewritten to 587 unless opted out). */
  port: number
  /** Implicit TLS on connect. Only true for a genuine, opted-in 465. */
  secure: boolean
  /** Force STARTTLS upgrade — set whenever we land on the 587 path. */
  requireTLS: boolean
  /** True when we rewrote a configured 465 down to 587. */
  normalized: boolean
}

/**
 * Resolve the effective port / TLS mode from a raw configured port.
 * Pure and dependency-free so both the sender and the health probe can use it.
 */
export function resolveSmtpPort(rawPort: number | string | undefined | null): EffectiveSmtp {
  const parsed = typeof rawPort === 'string' ? parseInt(rawPort, 10) : rawPort
  const allowImplicitTls = process.env.SMTP_ALLOW_IMPLICIT_TLS === 'true'

  // No / bad port -> STARTTLS on 587 (the universally-open default).
  if (!parsed || Number.isNaN(parsed)) {
    return { port: 587, secure: false, requireTLS: true, normalized: false }
  }

  // Configured 465 but implicit TLS not explicitly allowed -> rewrite to 587.
  if (parsed === 465 && !allowImplicitTls) {
    return { port: 587, secure: false, requireTLS: true, normalized: true }
  }

  // Genuine opted-in 465 -> implicit TLS. Anything else -> STARTTLS.
  if (parsed === 465) {
    return { port: 465, secure: true, requireTLS: false, normalized: false }
  }

  return { port: parsed, secure: false, requireTLS: true, normalized: false }
}

export interface SmtpCredentials {
  host?: string | null
  port?: number | string | null
  user?: string | null
  pass?: string | null
}

/**
 * Read platform SMTP credentials from environment.
 * Returns null when SMTP is not configured (dev/no-op path).
 */
export function readEnvSmtpCredentials(): SmtpCredentials | null {
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  if (!host || !user || !pass) return null
  return { host, port: process.env.SMTP_PORT, user, pass }
}

/**
 * Build a nodemailer transport from explicit credentials, applying the
 * 465 -> 587 normalization. Accepts the nodemailer module so callers can
 * import it however they like (static, dynamic, or `.default`).
 *
 * Returns null when host/user/pass are incomplete.
 */
export function buildSmtpTransport(nodemailer: any, creds: SmtpCredentials | null): any | null {
  if (!creds || !creds.host || !creds.user || !creds.pass) return null

  const { port, secure, requireTLS } = resolveSmtpPort(creds.port ?? undefined)

  return nodemailer.createTransport({
    host: creds.host,
    port,
    secure,
    requireTLS,
    auth: { user: creds.user, pass: creds.pass },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 10_000,
  })
}

/**
 * Convenience: build the platform transport straight from env.
 * Returns null when SMTP is unconfigured.
 */
export function buildEnvSmtpTransport(nodemailer: any): any | null {
  return buildSmtpTransport(nodemailer, readEnvSmtpCredentials())
}
