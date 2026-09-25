/**
 * WHERE AUTH MAIL IS SENT FROM
 * ============================
 *
 * `readEnvSmtpCredentials()` read SMTP_HOST/SMTP_USER/SMTP_PASS from the
 * process environment and that was the only answer available. An operator could
 * not change mail settings without editing .env and restarting, and a Cloud
 * tenant could not send from their own domain at all. The register called it
 * PARTIAL: a real transport with no way to configure it.
 *
 * ── Project config first, deployment env as FALLBACK ────────────────────────
 *
 * Not a replacement. A self-host install that already works keeps working after
 * an upgrade, and an operator who prefers .env is not pushed into the dashboard.
 * The precedence is one-directional and stated: an ENABLED project config wins;
 * anything else falls through to the environment.
 *
 * `enabled` exists so settings survive being switched off. Deleting the row to
 * stop using project SMTP would mean retyping a host, a username and a password
 * to switch back.
 *
 * ── The password is never readable ──────────────────────────────────────────
 *
 * AES-256-GCM through `lib/security/projectEnvCrypto`, the scheme
 * `database_credentials` already uses, rather than a second one. No route
 * returns it, and this module exposes no function that would: the surface
 * reports configured / not configured, and replacing it means sending a new one.
 * The audit found a provider route handing `clientSecret` to any authenticated
 * browser, and an SMTP password is the same kind of material with a bill
 * attached.
 *
 * ── "Configured" is not "works" ─────────────────────────────────────────────
 *
 * Every field can be right and the credentials still wrong. So the row records
 * the last real send attempt, and the dashboard reports that separately from
 * whether settings exist. A green tick over an untested configuration is the
 * claim this program keeps finding.
 */

import { prisma } from '@/lib/db/prisma'
import { decryptValue, encryptValue } from '@/lib/security/projectEnvCrypto'
import {
  buildSmtpTransport,
  readEnvSmtpCredentials,
  resolveSmtpPort,
  type SmtpCredentials,
} from './smtp-transport'

/** Where the credentials that will actually be used came from. */
export type SmtpSource = 'project' | 'deployment' | 'none'

export interface ResolvedSmtp {
  source: SmtpSource
  credentials: SmtpCredentials | null
  /** Envelope sender to use, already resolved through the same precedence. */
  from: string | null
}

/**
 * What the dashboard is allowed to see.
 *
 * Deliberately has no field that could hold a password. Not "a field that is
 * usually empty" — the shape itself cannot carry one, so no future edit can
 * accidentally start returning it.
 */
export interface SmtpConfigView {
  configured: boolean
  enabled: boolean
  host: string | null
  port: number | null
  username: string | null
  fromAddress: string | null
  fromName: string | null
  /** True when a password is stored. Never the password. */
  passwordConfigured: boolean
  /** The port that will really be used, after the 465 to 587 normalisation. */
  effectivePort: number | null
  portNormalised: boolean
  /** Evidence of a real send, or its absence. */
  lastTestAt: string | null
  lastTestError: string | null
  /** Whether the deployment environment could serve as a fallback. */
  deploymentFallbackAvailable: boolean
  /** Which source a message sent right now would use. */
  activeSource: SmtpSource
}

export interface SmtpConfigInput {
  host: string
  port: number
  username: string
  /** Omitted on an edit means "keep the stored password". */
  password?: string
  fromAddress: string
  fromName?: string | null
  enabled: boolean
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The credentials a send from this project should use, right now.
 *
 * Returns `source: 'none'` rather than throwing when nothing is configured,
 * because the callers already have a defined behaviour for that: log the email
 * and report `false`, never return the token to the caller.
 */
export async function resolveProjectSmtp(projectId: string): Promise<ResolvedSmtp> {
  const row = await prisma.projectEmailConfig
    .findUnique({ where: { projectId } })
    .catch(() => null)

  if (row?.enabled) {
    let password: string
    try {
      password = decryptValue({
        valueCipher: row.passwordCipher,
        valueIv: row.passwordIv,
        valueTag: row.passwordTag,
      })
    } catch (err: any) {
      // A row that cannot be decrypted means MASTER_ENCRYPTION_KEY changed. Do
      // NOT fall through to the deployment environment: sending this project's
      // mail from somewhere the operator did not choose is worse than not
      // sending it, and silently doing so would hide the key rotation.
      console.error(
        `[SMTP] project ${projectId} has SMTP settings that cannot be decrypted ` +
          `(MASTER_ENCRYPTION_KEY may have changed). Refusing to fall back:`,
        err?.message ?? err,
      )
      return { source: 'none', credentials: null, from: null }
    }

    return {
      source: 'project',
      credentials: { host: row.host, port: row.port, user: row.username, pass: password },
      from: row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress,
    }
  }

  const env = readEnvSmtpCredentials()
  if (env) {
    return {
      source: 'deployment',
      credentials: env,
      from: process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>',
    }
  }

  return { source: 'none', credentials: null, from: null }
}

/**
 * A ready transport for this project, or null when nothing is configured.
 *
 * Goes through `buildSmtpTransport` so the 465 to 587 normalisation applies
 * identically to project and deployment credentials. Two code paths that
 * disagreed about the effective port is exactly what that module was written to
 * prevent.
 */
export async function buildProjectSmtpTransport(
  nodemailer: any,
  projectId: string,
): Promise<{ transport: any; from: string; source: SmtpSource } | null> {
  const resolved = await resolveProjectSmtp(projectId)
  if (!resolved.credentials || !resolved.from) return null

  const transport = buildSmtpTransport(nodemailer, resolved.credentials)
  if (!transport) return null

  return { transport, from: resolved.from, source: resolved.source }
}

// ── Reading, for the dashboard ────────────────────────────────────────────────

export async function getSmtpConfigView(projectId: string): Promise<SmtpConfigView> {
  const row = await prisma.projectEmailConfig
    .findUnique({ where: { projectId } })
    .catch(() => null)
  const env = readEnvSmtpCredentials()
  const active = await resolveProjectSmtp(projectId)

  const effective = row ? resolveSmtpPort(row.port) : null

  return {
    configured: row !== null,
    enabled: row?.enabled ?? false,
    host: row?.host ?? null,
    port: row?.port ?? null,
    username: row?.username ?? null,
    fromAddress: row?.fromAddress ?? null,
    fromName: row?.fromName ?? null,
    passwordConfigured: Boolean(row?.passwordCipher),
    effectivePort: effective?.port ?? null,
    portNormalised: effective?.normalized ?? false,
    lastTestAt: row?.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestError: row?.lastTestError ?? null,
    deploymentFallbackAvailable: env !== null,
    activeSource: active.source,
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface SmtpConfigProblem {
  field: keyof SmtpConfigInput
  message: string
}

/** Reject what cannot work, before storing it. */
export function validateSmtpConfig(
  input: SmtpConfigInput,
  hasStoredPassword: boolean,
): SmtpConfigProblem[] {
  const problems: SmtpConfigProblem[] = []

  if (!input.host?.trim()) {
    problems.push({ field: 'host', message: 'A host is required.' })
  } else if (/\s/.test(input.host.trim())) {
    problems.push({ field: 'host', message: 'A host cannot contain spaces.' })
  }

  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    problems.push({ field: 'port', message: 'The port must be a whole number between 1 and 65535.' })
  }

  if (!input.username?.trim()) {
    problems.push({ field: 'username', message: 'A username is required.' })
  }

  // Absent password on an edit means keep. Absent on a first save means there is
  // nothing to keep, which would store a config that cannot authenticate.
  if (!input.password && !hasStoredPassword) {
    problems.push({ field: 'password', message: 'A password is required the first time.' })
  }

  const from = input.fromAddress?.trim() ?? ''
  if (!from) {
    problems.push({ field: 'fromAddress', message: 'A from address is required.' })
  } else if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(from)) {
    problems.push({ field: 'fromAddress', message: `"${from}" is not an email address.` })
  }

  // A newline in either field is header injection, which is the one input here
  // that is a security problem rather than a usability one.
  for (const field of ['fromAddress', 'fromName', 'username', 'host'] as const) {
    const value = input[field]
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      problems.push({ field, message: 'Line breaks are not allowed.' })
    }
  }

  return problems
}

/**
 * Store settings. A password is written only when one is supplied.
 *
 * Saving invalidates the previous test result: settings that have changed have
 * not been proven, and leaving a stale green tick beside new credentials is
 * exactly the false claim this row exists to avoid.
 */
export async function saveSmtpConfig(projectId: string, input: SmtpConfigInput) {
  const existing = await prisma.projectEmailConfig.findUnique({ where: { projectId } })

  const secret = input.password ? encryptValue(input.password) : null

  const shared = {
    enabled: input.enabled,
    host: input.host.trim(),
    port: input.port,
    username: input.username.trim(),
    fromAddress: input.fromAddress.trim(),
    fromName: input.fromName?.trim() || null,
    lastTestAt: null,
    lastTestError: null,
  }

  if (!existing) {
    if (!secret) throw new Error('saveSmtpConfig: a password is required on first save')
    return prisma.projectEmailConfig.create({
      data: {
        projectId,
        ...shared,
        passwordCipher: secret.valueCipher,
        passwordIv: secret.valueIv,
        passwordTag: secret.valueTag,
      },
    })
  }

  return prisma.projectEmailConfig.update({
    where: { projectId },
    data: {
      ...shared,
      ...(secret
        ? {
            passwordCipher: secret.valueCipher,
            passwordIv: secret.valueIv,
            passwordTag: secret.valueTag,
          }
        : {}),
    },
  })
}

/** Record the outcome of a real send attempt. */
export async function recordSmtpTest(
  projectId: string,
  error: string | null,
): Promise<void> {
  await prisma.projectEmailConfig
    .update({
      where: { projectId },
      // Truncated: this is shown in the dashboard, and a provider's rejection can
      // be a wall of text.
      data: { lastTestAt: new Date(), lastTestError: error ? error.slice(0, 500) : null },
    })
    .catch(() => {
      // No project row means the test ran against the deployment fallback, which
      // has nowhere to record a result. Not an error.
    })
}

/**
 * Send one real test message to `to` with the settings a send would use now,
 * and record the outcome. Shared by the Auth page's "Send test" and the
 * agent's auth test_smtp, so both prove the same thing.
 */
export async function sendProjectSmtpTest(
  nodemailer: any,
  projectId: string,
  to: string,
): Promise<{ sent: boolean; source: SmtpSource; error?: string }> {
  const resolved = await buildProjectSmtpTransport(nodemailer, projectId)
  if (!resolved) {
    return {
      sent: false,
      source: 'none',
      error: 'No SMTP settings for this project and no deployment fallback, so nothing was sent.',
    }
  }
  try {
    await resolved.transport.sendMail({
      from: resolved.from,
      to,
      subject: 'Backenly SMTP test',
      // Deliberately dull and carrying no project data. A test message is not a
      // place to demonstrate templates, and it must be safe to send anywhere.
      text:
        'This is a test message from Backenly. If you are reading it, this ' +
        "project's outgoing mail settings work.",
    })
    await recordSmtpTest(projectId, null)
    return { sent: true, source: resolved.source }
  } catch (err: any) {
    // The provider's own words. An operator debugging a 535 needs to read it,
    // and paraphrasing it into "send failed" is how a five-second fix becomes a
    // support thread.
    const message = String(err?.message ?? err)
    await recordSmtpTest(projectId, message)
    return { sent: false, source: resolved.source, error: message.slice(0, 500) }
  }
}

/** A recipient a test can be checked at. */
export function isTestRecipient(to: unknown): to is string {
  return typeof to === 'string' && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(to.trim())
}

export async function deleteSmtpConfig(projectId: string): Promise<boolean> {
  const { count } = await prisma.projectEmailConfig.deleteMany({ where: { projectId } })
  return count > 0
}
