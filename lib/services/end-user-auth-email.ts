/**
 * Branded auth emails for END USERS of apps built on Backenly.
 *
 * These are different from lib/auth/email.ts (platform emails): the recipient
 * is a user of the developer's app, so every email is branded with the app's
 * name and links back to the app's URL — never to backenly.com. Branding comes
 * from ProjectAuthConfig (appName/appUrl), falling back to the project name.
 *
 * Delivery resolves SMTP per project, falling back to the deployment
 * environment (lib/email/project-smtp.ts). Through the deployment, the From
 * names the app, not the deployment (endUserFrom). When neither is configured
 * the email is logged to console instead — tokens are NEVER returned to API
 * callers (see forgotEndUserPassword).
 *
 * The BUILT-IN subjects and bodies live in lib/email/auth-builtins.ts, the one
 * definition the Auth page's template editor also starts from. An operator
 * override replaces one per kind; absence means the built-in is used, so an
 * install that customises nothing behaves exactly as it did. A stored template
 * that cannot render falls back to the built-in and says so in the log,
 * because an auth flow must not be the thing that surfaces a template bug.
 */

import nodemailer from 'nodemailer'
import { prisma } from '@/lib/db'
import { buildProjectSmtpTransport, endUserFrom } from '@/lib/email/project-smtp'
import { resolveAuthEmail } from '@/lib/email/auth-template-resolver'
import { BUILT_IN_EXPIRY, builtInAuthEmail, type AuthEmailValues } from '@/lib/email/auth-builtins'
import type { TemplateKind, TemplateVariable } from '@/lib/email/template-kinds'

export interface AuthEmailContext {
  appName: string
  /** Developer's app base URL (no trailing slash) — null when unconfigured. */
  appUrl: string | null
  requireEmailVerification: boolean
  magicLinksEnabled: boolean
}

export async function getAuthEmailContext(projectId: string): Promise<AuthEmailContext> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, authConfig: true },
  })
  const cfg = project?.authConfig
  // Only the App URL the developer set. project.publicUrl is the project's API
  // base (lib/deployment/go-live.ts), never a page a person can use: read as
  // the app's address, it sent every reset link of a published project to the
  // API's JSON descriptor.
  return {
    appName: cfg?.appName || project?.name || 'your app',
    appUrl: linkableAppUrl(cfg?.appUrl),
    requireEmailVerification: cfg?.requireEmailVerification ?? false,
    magicLinksEnabled: cfg?.magicLinksEnabled ?? true,
  }
}

/**
 * An App URL as something safe to link or redirect to: an http(s) address
 * whose host is a plain hostname or IP, in the form the URL parser writes it
 * (so a quote or an angle bracket in the path, query or fragment arrives
 * percent-encoded), without a trailing slash. Anything else is no App URL.
 *
 * The parser does not encode a quote in a host, and it accepts any scheme,
 * javascript: and data: included, so neither "it parsed" nor "it was saved"
 * is enough: a value stored before saving checked this is read through here.
 */
export function linkableAppUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!/^[a-z0-9._\-[\]:]+$/i.test(url.hostname)) return null
  return url.href.replace(/\/+$/, '')
}

/**
 * Where auth links land. Verification and magic links go to Backenly-hosted
 * GET endpoints (they complete server-side, then redirect to the app), so
 * they work even when the developer has configured nothing. Password reset
 * needs a page with a form: the app's, when it has an App URL (the token in
 * the query, exchanged via auth.resetPassword()), otherwise the one Backenly
 * hosts (lib/services/end-user-hosted-pages.ts).
 */
export function hostedAuthUrl(projectId: string, path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com').replace(/\/+$/, '')
  return `${base}/api/v1/${projectId}/auth/${path}`
}

async function deliver(
  projectId: string,
  to: string,
  subject: string,
  html: string,
  label: string,
  appName: string | undefined,
): Promise<boolean> {
  const resolved = await buildProjectSmtpTransport(nodemailer, projectId)
  if (resolved) {
    // Through the deployment's SMTP the sender is the app, not the deployment.
    await resolved.transport.sendMail({ from: endUserFrom(resolved, appName), to, subject, html })
    return true
  }
  // Neither project settings nor deployment env. The email is logged WITHOUT
  // its body, because the body carries the reset link and console output ends
  // up in log aggregators.
  console.log(`\n========== ${label} (SMTP unconfigured) ==========`)
  console.log(`To: ${to}`)
  console.log(`Subject: ${subject}`)
  console.log('===================================================\n')
  return false
}

/**
 * Send one auth email, using the operator's template when there is a usable one.
 *
 * Every caller routes through here so the override, the fallback and the
 * logging cannot be applied to two of the three emails and forgotten on the
 * third.
 */
async function sendAuthEmail(
  projectId: string,
  kind: TemplateKind,
  to: string,
  label: string,
  values: Partial<Record<TemplateVariable, string>>,
  builtIn: { subject: string; bodyHtml: string },
): Promise<boolean> {
  const email = await resolveAuthEmail(projectId, kind, values, builtIn)

  if (email.fallbackReason) {
    // Loud on purpose. A quiet fallback is how a project sends Backenly's
    // default wording for months while the dashboard shows a template nobody
    // is using.
    console.warn(
      `[AuthEmail] project ${projectId} has a ${kind} template that could not be ` +
        `used (${email.fallbackReason}); sent the built-in instead.`,
    )
  }

  return deliver(projectId, to, email.subject, email.bodyHtml, label, values.appName)
}

export async function sendEndUserVerificationEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  const verifyUrl = hostedAuthUrl(projectId, `verify-email?token=${encodeURIComponent(token)}`)
  const values: AuthEmailValues = { appName: ctx.appName, email, ctaUrl: verifyUrl, expiry: BUILT_IN_EXPIRY.verification }
  return sendAuthEmail(
    projectId,
    'verification',
    email,
    'END-USER VERIFICATION EMAIL',
    values,
    builtInAuthEmail('verification', values),
  )
}

export async function sendEndUserMagicLinkEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  const magicUrl = hostedAuthUrl(projectId, `magic?token=${encodeURIComponent(token)}`)
  const values: AuthEmailValues = { appName: ctx.appName, email, ctaUrl: magicUrl, expiry: BUILT_IN_EXPIRY.magic_link }
  return sendAuthEmail(
    projectId,
    'magic_link',
    email,
    'END-USER MAGIC LINK EMAIL',
    values,
    builtInAuthEmail('magic_link', values),
  )
}

export async function sendEndUserPasswordResetEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  // Reset needs a form, so the link goes to the developer's app when
  // configured (?backenly_reset_token=…); the app calls auth.resetPassword().
  // Otherwise to the reset page Backenly hosts for the project.
  const resetUrl = ctx.appUrl
    ? `${ctx.appUrl}?backenly_reset_token=${encodeURIComponent(token)}`
    : hostedAuthUrl(projectId, `reset?token=${encodeURIComponent(token)}`)
  const values: AuthEmailValues = { appName: ctx.appName, email, ctaUrl: resetUrl, expiry: BUILT_IN_EXPIRY.password_reset }
  return sendAuthEmail(
    projectId,
    'password_reset',
    email,
    'END-USER PASSWORD RESET EMAIL',
    values,
    builtInAuthEmail('password_reset', values),
  )
}
