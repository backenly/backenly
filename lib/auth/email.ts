import nodemailer from 'nodemailer'
import { buildEnvSmtpTransport } from '@/lib/email/smtp-transport'
import { observeSend, reportUnconfigured } from '@/lib/email/send-outcome'
import { EmailNotConfiguredError } from '@/lib/email/platform-delivery'
import { EMAIL_CODE_TTL_MS } from '@/lib/auth/email-code'

function getTransporter() {
  // Shared builder normalizes port 465 -> 587 (STARTTLS) so email works on
  // hosts that block implicit-TLS outbound (e.g. Hetzner). Returns null in dev
  // when SMTP is unconfigured, which callers fall back to console logging.
  return buildEnvSmtpTransport(nodemailer)
}

export async function sendVerificationEmail(email: string, verifyUrl: string): Promise<void> {
  const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
  const subject = 'Verify your Backenly email'
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">Verify your email</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">
        Thanks for signing up for Backenly! Click the button below to verify your email address (<strong style="color: #e5e7eb;">${email}</strong>).
        This link expires in <strong style="color: #e5e7eb;">24 hours</strong>.
      </p>
      <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #2563eb); color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">
        Verify email
      </a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        If you didn't create a Backenly account, you can safely ignore this email.
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${verifyUrl}</span>
      </p>
    </div>
  `

  const transporter = getTransporter()

  if (transporter) {
    await observeSend('verification', email, () =>
      transporter.sendMail({ from, to: email, subject, html }),
    )
  } else {
    reportUnconfigured({ kind: 'verification', email, preview: { 'Verify URL': verifyUrl } })
  }
}

export async function sendOrgInviteEmail(
  email: string,
  opts: { inviterName: string; orgName: string; role: string; acceptUrl: string },
): Promise<void> {
  const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
  const subject = `${opts.inviterName} invited you to ${opts.orgName} on Backenly`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 22px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">You've been invited</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">
        <strong style="color: #e5e7eb;">${opts.inviterName}</strong> invited you to join
        <strong style="color: #e5e7eb;">${opts.orgName}</strong> on Backenly as a
        <strong style="color: #e5e7eb;">${opts.role.toLowerCase()}</strong>.
      </p>
      <a href="${opts.acceptUrl}" style="display: inline-block; background: #7c3aed; color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">
        Accept invite
      </a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        Sign in with <strong style="color: #e5e7eb;">${email}</strong> to accept. This invite expires in 14 days.
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${opts.acceptUrl}</span>
      </p>
    </div>
  `
  const transporter = getTransporter()
  if (transporter) {
    await observeSend('org_invite', email, () =>
      transporter.sendMail({ from, to: email, subject, html }),
    )
  } else {
    reportUnconfigured({ kind: 'org_invite', email, preview: { 'Accept URL': opts.acceptUrl } })
  }
}

export async function sendAccountLockedEmail(email: string, lockedUntil: Date): Promise<void> {
  const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
  const subject = 'Your Backenly account has been temporarily locked'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
  const unlockUrl = `${appUrl}/auth/unlock-account?email=${encodeURIComponent(email)}`
  const lockedUntilStr = lockedUntil.toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' })

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">Account temporarily locked</h1>
      <p style="color: #9ca3af; margin: 0 0 16px; font-size: 15px;">
        Your Backenly account (<strong style="color: #e5e7eb;">${email}</strong>) has been locked because of too many failed login attempts.
      </p>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">
        Your account will automatically unlock at <strong style="color: #e5e7eb;">${lockedUntilStr}</strong>.
      </p>
      <a href="${unlockUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #2563eb); color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">
        Unlock my account now
      </a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        If this was you, you can reset your password or wait for the automatic unlock.
        If this wasn't you, your account is safe — someone was trying incorrect passwords.
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${unlockUrl}</span>
      </p>
    </div>
  `

  const transporter = getTransporter()

  if (transporter) {
    await observeSend('account_locked', email, () =>
      transporter.sendMail({ from, to: email, subject, html }),
    )
  } else {
    reportUnconfigured({
      kind: 'account_locked',
      email,
      preview: { 'Locked until': lockedUntilStr, 'Unlock URL': unlockUrl },
    })
  }
}

/**
 * Mail a flow cannot continue without: a code the person has to type back.
 *
 * Unlike the notices above, this THROWS when there is no transport, rather
 * than resolving as though it sent. The caller awaits it through
 * `deliverPlatformEmail`, which turns that into an honest refusal instead of a
 * page telling someone to wait for an email that is never coming. The
 * development preview still prints first, so a local run stays debuggable.
 */
async function sendRequiredEmail(
  kind: string,
  email: string,
  subject: string,
  html: string,
  text: string,
  preview: Record<string, string>,
): Promise<void> {
  const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
  const transporter = getTransporter()
  if (!transporter) {
    reportUnconfigured({ kind, email, preview })
    throw new EmailNotConfiguredError()
  }
  await observeSend(kind, email, () => transporter.sendMail({ from, to: email, subject, html, text }))
}

function codeEmailHtml(opts: { heading: string; intro: string; code: string; footer: string }): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">${opts.heading}</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">${opts.intro}</p>
      <div style="font-family: 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #ffffff; background: #16171d; border: 1px solid #2a2b33; border-radius: 12px; padding: 16px 20px; text-align: center; margin: 0 0 24px;">
        ${opts.code}
      </div>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">${opts.footer}</p>
    </div>
  `
}

const CODE_MINUTES = Math.round(EMAIL_CODE_TTL_MS / 60_000)

/** The code that must be entered before a new Backenly account is created. */
export async function sendSignupCodeEmail(email: string, code: string): Promise<void> {
  const subject = `${code} is your Backenly verification code`
  const html = codeEmailHtml({
    heading: 'Confirm your email',
    intro:
      `Enter this code to finish creating your Backenly account for <strong style="color: #e5e7eb;">${email}</strong>. ` +
      `It expires in <strong style="color: #e5e7eb;">${CODE_MINUTES} minutes</strong>.`,
    code,
    footer: "If you didn't try to create a Backenly account, you can ignore this email. No account is created without this code.",
  })
  const text =
    `Your Backenly verification code is ${code}\n\n` +
    `Enter it to finish creating your account for ${email}. It expires in ${CODE_MINUTES} minutes.\n\n` +
    "If you didn't try to create a Backenly account, you can ignore this email."
  await sendRequiredEmail('signup_code', email, subject, html, text, { Code: code })
}

/** The code that must be entered before a password is replaced. */
export async function sendPasswordResetCodeEmail(email: string, code: string): Promise<void> {
  const subject = `${code} is your Backenly password reset code`
  const html = codeEmailHtml({
    heading: 'Reset your password',
    intro:
      `Enter this code to choose a new password for your Backenly account (<strong style="color: #e5e7eb;">${email}</strong>). ` +
      `It expires in <strong style="color: #e5e7eb;">${CODE_MINUTES} minutes</strong>.`,
    code,
    footer:
      "If you didn't ask to reset your password, you can ignore this email. Your password stays the same unless this code is entered.",
  })
  const text =
    `Your Backenly password reset code is ${code}\n\n` +
    `Enter it to choose a new password for ${email}. It expires in ${CODE_MINUTES} minutes.\n\n` +
    "If you didn't ask to reset your password, you can ignore this email."
  await sendRequiredEmail('password_reset_code', email, subject, html, text, { Code: code })
}

/**
 * Sent instead of a signup code when the address already has an account.
 *
 * The signup page answers identically either way, so it cannot be used to find
 * out who has an account. The owner of the address learns what happened, and
 * how to get back in, from their own inbox.
 */
export async function sendAccountExistsEmail(email: string): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const loginUrl = `${appUrl}/auth/login`
  const resetUrl = `${appUrl}/auth/forgot-password?email=${encodeURIComponent(email)}`
  const subject = 'You already have a Backenly account'
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">You already have an account</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">
        Someone tried to sign up for Backenly with <strong style="color: #e5e7eb;">${email}</strong>, which already has an account.
        If that was you, sign in instead, or reset your password if you've forgotten it.
      </p>
      <a href="${loginUrl}" style="display: inline-block; background: #7c3aed; color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 16px;">
        Sign in
      </a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        <a href="${resetUrl}" style="color: #a78bfa;">Reset your password</a>.
        If this wasn't you, you can ignore this email. Nothing about your account has changed.
      </p>
    </div>
  `
  const text =
    `Someone tried to sign up for Backenly with ${email}, which already has an account.\n\n` +
    `Sign in: ${loginUrl}\nReset your password: ${resetUrl}\n\n` +
    "If this wasn't you, you can ignore this email. Nothing about your account has changed."
  await sendRequiredEmail('account_exists', email, subject, html, text, { 'Sign in': loginUrl })
}
