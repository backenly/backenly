/**
 * THE BUILT-IN AUTH EMAILS, WRITTEN ONCE
 * ======================================
 *
 * What a project's end users receive when nobody has written their own
 * verification, password reset or magic-link email. Two readers need the same
 * words:
 *
 *   - the send path (lib/services/end-user-auth-email.ts) builds each email
 *     with the real values for one send: the app's name, the address, the
 *     link and how long it lasts;
 *   - the Auth page's template editor starts from the built-in text, so a
 *     person changing one sentence edits Backenly's wording instead of facing
 *     an empty box (lib/email/project-templates.ts returns it as `builtIn`).
 *
 * Both call `builtInAuthEmail`. The editor's version is the same function given
 * the placeholders themselves (`{{appName}}` and the rest), so the two can
 * never say different things: rendering the template form with a send's values
 * gives that send's email (tests/unit/auth-email-builtins.spec.ts).
 *
 * Pure on purpose (no database, no mail transport), so the dashboard's read and
 * a unit test can import it without either.
 */

import type { TemplateKind, TemplateVariable } from './template-kinds'

export interface BuiltInAuthEmail {
  subject: string
  bodyHtml: string
}

/** The values one send fills in. `expiry` is prose ("24 hours"), written by the code that knows the lifetime. */
export type AuthEmailValues = Record<TemplateVariable, string>

/** How long each kind's link lasts, as its email says it. */
export const BUILT_IN_EXPIRY: Record<TemplateKind, string> = {
  verification: '24 hours',
  password_reset: '1 hour',
  magic_link: '15 minutes',
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
      <a href="${esc(ctaUrl)}" style="display: inline-block; background: #8b5cf6; color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">${ctaText}</a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        ${footer}
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${esc(ctaUrl)}</span>
      </p>
    </div>
  `
}

/** One kind's built-in subject and body, for these values. */
export function builtInAuthEmail(kind: TemplateKind, v: AuthEmailValues): BuiltInAuthEmail {
  const strong = (text: string) => `<strong style="color:#e5e7eb;">${esc(text)}</strong>`
  switch (kind) {
    case 'verification':
      return {
        subject: `Verify your ${v.appName} email`,
        bodyHtml: shell(
          v.appName,
          'Verify your email',
          `Confirm ${strong(v.email)} to finish setting up your ${esc(v.appName)} account. This link expires in ${strong(v.expiry)}.`,
          'Verify email',
          v.ctaUrl,
          `If you didn't create a ${esc(v.appName)} account, you can safely ignore this email.`,
        ),
      }
    case 'magic_link':
      return {
        subject: `Sign in to ${v.appName}`,
        bodyHtml: shell(
          v.appName,
          `Sign in to ${esc(v.appName)}`,
          `Click the button below to sign in as ${strong(v.email)}. This link can be used once and expires in ${strong(v.expiry)}.`,
          'Sign in',
          v.ctaUrl,
          `If you didn't request this link, you can safely ignore this email — no one can sign in without it.`,
        ),
      }
    case 'password_reset':
      return {
        subject: `Reset your ${v.appName} password`,
        bodyHtml: shell(
          v.appName,
          'Reset your password',
          `We received a request to reset the password for your ${esc(v.appName)} account (${strong(v.email)}). This link expires in ${strong(v.expiry)}.`,
          'Reset password',
          v.ctaUrl,
          `If you didn't request a password reset, you can safely ignore this email — your password won't change.`,
        ),
      }
  }
}

/**
 * The built-in as a template: the same words with the placeholders in place of
 * the values, which is what the Auth page's editor starts from. It passes
 * `validateTemplate`, so saving it unchanged is always accepted.
 */
export function builtInAuthTemplate(kind: TemplateKind): BuiltInAuthEmail {
  return builtInAuthEmail(kind, {
    appName: '{{appName}}',
    email: '{{email}}',
    ctaUrl: '{{ctaUrl}}',
    expiry: '{{expiry}}',
  })
}
