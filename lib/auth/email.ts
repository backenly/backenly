import nodemailer from 'nodemailer'
import { buildEnvSmtpTransport } from '@/lib/email/smtp-transport'
import { observeSend, reportUnconfigured } from '@/lib/email/send-outcome'

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

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
  const subject = 'Reset your Backenly password'
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #0A0E1A; color: #f0f0f5; border-radius: 16px;">
      <h1 style="font-size: 24px; font-weight: 800; margin: 0 0 8px; color: #ffffff;">Reset your password</h1>
      <p style="color: #9ca3af; margin: 0 0 24px; font-size: 15px;">
        We received a request to reset the password for your Backenly account (<strong style="color: #e5e7eb;">${email}</strong>).
        Click the button below to choose a new password. This link expires in <strong style="color: #e5e7eb;">1 hour</strong>.
      </p>
      <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #2563eb); color: #ffffff; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 12px; margin-bottom: 24px;">
        Reset password
      </a>
      <p style="color: #6b7280; font-size: 13px; margin: 0;">
        If you didn't request a password reset, you can safely ignore this email — your password won't change.
        <br/><br/>
        Or copy this URL into your browser:<br/>
        <span style="color: #a78bfa; word-break: break-all;">${resetUrl}</span>
      </p>
    </div>
  `

  const transporter = getTransporter()

  if (transporter) {
    await observeSend('password_reset', email, () =>
      transporter.sendMail({ from, to: email, subject, html }),
    )
  } else {
    // Development: log the reset link so you can test without SMTP
    reportUnconfigured({ kind: 'password_reset', email, preview: { 'Reset URL': resetUrl } })
  }
}
