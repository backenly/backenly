/**
 * Branded auth emails for END USERS of apps built on Backenly.
 *
 * These are different from lib/auth/email.ts (platform emails): the recipient
 * is a user of the developer's app, so every email is branded with the app's
 * name and links back to the app's URL — never to backenly.com. Branding comes
 * from ProjectAuthConfig (appName/appUrl), falling back to the project name.
 *
 * Delivery uses the platform SMTP transport (buildEnvSmtpTransport). When SMTP
 * is unconfigured (local dev) the email is logged to console instead — tokens
 * are NEVER returned to API callers (see forgotEndUserPassword).
 */

import nodemailer from 'nodemailer'
import { prisma } from '@/lib/db'
import { buildEnvSmtpTransport } from '@/lib/email/smtp-transport'

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
    select: { name: true, publicUrl: true, authConfig: true },
  })
  const cfg = project?.authConfig
  const rawUrl = cfg?.appUrl || project?.publicUrl || null
  return {
    appName: cfg?.appName || project?.name || 'your app',
    appUrl: rawUrl ? rawUrl.replace(/\/+$/, '') : null,
    requireEmailVerification: cfg?.requireEmailVerification ?? false,
    magicLinksEnabled: cfg?.magicLinksEnabled ?? true,
  }
}

/**
 * Where auth links land. Verification and magic links go to Backenly-hosted
 * GET endpoints (they complete server-side, then redirect to the app), so
 * they work even when the developer has configured nothing. Password reset
 * links need a page with a form, so they go to the app URL with the token in
 * the query — the app exchanges it via auth.resetPassword().
 */
export function hostedAuthUrl(projectId: string, path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com').replace(/\/+$/, '')
  return `${base}/api/v1/${projectId}/auth/${path}`
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shell(appName: string, heading: string, body: string, ctaText: string, ctaUrl: string, footer: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0e0f13; color: #f0f0f5; border-radius: 16px;">
      <p style="color: #8b5cf6; font-weight: 700; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 16px;">${esc(appName)}</p>
      <h1 style="font-size: 22px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">${heading}</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">${body}</p>
      <a href="${ctaUrl}" style="display: inline-block; background: #8b5cf6; color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">${ctaText}</a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        ${footer}
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${ctaUrl}</span>
      </p>
    </div>
  `
}

async function deliver(to: string, subject: string, html: string, label: string): Promise<boolean> {
  const transporter = buildEnvSmtpTransport(nodemailer)
  if (transporter) {
    const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
    await transporter.sendMail({ from, to, subject, html })
    return true
  }
  console.log(`\n========== ${label} (SMTP unconfigured) ==========`)
  console.log(`To: ${to}`)
  console.log(`Subject: ${subject}`)
  console.log('===================================================\n')
  return false
}

export async function sendEndUserVerificationEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  const verifyUrl = hostedAuthUrl(projectId, `verify-email?token=${encodeURIComponent(token)}`)
  const html = shell(
    ctx.appName,
    'Verify your email',
    `Confirm <strong style="color:#e5e7eb;">${esc(email)}</strong> to finish setting up your ${esc(ctx.appName)} account. This link expires in <strong style="color:#e5e7eb;">24 hours</strong>.`,
    'Verify email',
    verifyUrl,
    `If you didn't create a ${esc(ctx.appName)} account, you can safely ignore this email.`,
  )
  return deliver(email, `Verify your ${ctx.appName} email`, html, 'END-USER VERIFICATION EMAIL')
}

export async function sendEndUserMagicLinkEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  const magicUrl = hostedAuthUrl(projectId, `magic?token=${encodeURIComponent(token)}`)
  const html = shell(
    ctx.appName,
    `Sign in to ${esc(ctx.appName)}`,
    `Click the button below to sign in as <strong style="color:#e5e7eb;">${esc(email)}</strong>. This link can be used once and expires in <strong style="color:#e5e7eb;">15 minutes</strong>.`,
    'Sign in',
    magicUrl,
    `If you didn't request this link, you can safely ignore this email — no one can sign in without it.`,
  )
  return deliver(email, `Sign in to ${ctx.appName}`, html, 'END-USER MAGIC LINK EMAIL')
}

export async function sendEndUserPasswordResetEmail(
  projectId: string,
  email: string,
  token: string,
  ctx: AuthEmailContext,
): Promise<boolean> {
  // Reset needs a form, so the link goes to the developer's app when
  // configured (?backenly_reset_token=…); the app calls auth.resetPassword().
  // Fallback: platform-hosted generic reset page.
  const resetUrl = ctx.appUrl
    ? `${ctx.appUrl}?backenly_reset_token=${encodeURIComponent(token)}`
    : `${(process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com').replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}&projectId=${encodeURIComponent(projectId)}`
  const html = shell(
    ctx.appName,
    'Reset your password',
    `We received a request to reset the password for your ${esc(ctx.appName)} account (<strong style="color:#e5e7eb;">${esc(email)}</strong>). This link expires in <strong style="color:#e5e7eb;">1 hour</strong>.`,
    'Reset password',
    resetUrl,
    `If you didn't request a password reset, you can safely ignore this email — your password won't change.`,
  )
  return deliver(email, `Reset your ${ctx.appName} password`, html, 'END-USER PASSWORD RESET EMAIL')
}
