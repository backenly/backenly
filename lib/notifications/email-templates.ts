/**
 * Notification Email Templates
 * =============================
 * One HTML template per PlatformNotificationType.
 * All templates share the same dark-branded shell used in lib/auth/email.ts.
 */

import { PlatformNotificationType } from './platform'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'

function shell(content: string): string {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0A0E1A;color:#f0f0f5;border-radius:16px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">Backenly</span>
  </div>
  ${content}
  <hr style="border:none;border-top:1px solid #1f2937;margin:28px 0 20px;" />
  <p style="color:#4b5563;font-size:12px;margin:0;">
    You're receiving this because you have an active Backenly account.<br/>
    <a href="${APP_URL}/settings/notifications" style="color:#7c3aed;text-decoration:none;">Manage notification preferences</a>
  </p>
</div>`
}

function button(text: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:12px 28px;border-radius:12px;margin:20px 0;">${text}</a>`
}

export interface NotificationEmailContent {
  subject: string
  html: string
}

export function buildNotificationEmail(
  type: PlatformNotificationType,
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  switch (type) {
    case 'payment_success':
      return buildPaymentSuccessEmail(title, body, metadata)
    case 'payment_failed':
      return buildPaymentFailedEmail(title, body, metadata)
    case 'credits_low':
      return buildCreditsLowEmail(title, body, metadata)
    case 'job_completed':
      return buildJobCompletedEmail(title, body, metadata)
    case 'job_failed':
      return buildJobFailedEmail(title, body, metadata)
    case 'deploy_complete':
      return buildDeployCompleteEmail(title, body, metadata)
    case 'system':
      return buildSystemEmail(title, body, metadata)
    default:
      return buildGenericEmail(title, body)
  }
}

// ─── Individual templates ─────────────────────────────────────────────────────

function buildPaymentSuccessEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#ffffff;">🎉 ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 20px;font-size:15px;line-height:1.6;">${body}</p>
    ${metadata.planName ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Plan: <strong style="color:#e5e7eb;">${metadata.planName}</strong></p>` : ''}
    ${metadata.periodEnd ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Active until: <strong style="color:#e5e7eb;">${new Date(metadata.periodEnd).toLocaleDateString()}</strong></p>` : ''}
    ${button('Manage subscription', `${APP_URL}/settings/billing`)}
  `)
  return { subject: `✅ ${title} — Backenly`, html }
}

function buildPaymentFailedEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#f87171;">⚠️ ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 20px;font-size:15px;line-height:1.6;">${body}</p>
    ${metadata.graceUntil ? `<p style="color:#6b7280;font-size:13px;margin:0 0 16px;">Grace period ends: <strong style="color:#fbbf24;">${new Date(metadata.graceUntil).toLocaleDateString()}</strong></p>` : ''}
    ${button('Update billing details', `${APP_URL}/settings/billing`)}
  `)
  return { subject: `⚠️ ${title} — action required`, html }
}

function buildCreditsLowEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const pct = metadata.pct ?? Math.round(((metadata.used ?? 0) / (metadata.limit ?? 1)) * 100)
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#fbbf24;">🔔 ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 16px;font-size:15px;line-height:1.6;">${body}</p>
    <div style="background:#111827;border-radius:8px;padding:14px 16px;margin:0 0 20px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#6b7280;font-size:13px;">Used</span>
        <span style="color:#e5e7eb;font-size:13px;font-weight:600;">${metadata.used ?? '–'} / ${metadata.limit ?? '–'} (${pct}%)</span>
      </div>
      <div style="background:#1f2937;border-radius:4px;height:6px;overflow:hidden;">
        <div style="background:linear-gradient(90deg,#f59e0b,#ef4444);width:${Math.min(pct, 100)}%;height:100%;border-radius:4px;"></div>
      </div>
    </div>
    ${button('Upgrade plan', `${APP_URL}/pricing`)}
  `)
  return { subject: `🔔 AI credits running low (${pct}% used) — Backenly`, html }
}

function buildJobCompletedEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const projectLink = metadata.projectId
    ? `${APP_URL}/app/projects/${metadata.projectId}`
    : `${APP_URL}/app`
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#34d399;">✅ ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 16px;font-size:15px;line-height:1.6;">${body}</p>
    ${metadata.jobId ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Job ID: <code style="color:#a78bfa;">${metadata.jobId}</code></p>` : ''}
    ${metadata.table ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Table: <code style="color:#a78bfa;">${metadata.table}</code></p>` : ''}
    ${metadata.outputUrl
      ? button('View output', metadata.outputUrl)
      : button('View project', projectLink)}
  `)
  return { subject: `✅ Job completed — Backenly`, html }
}

function buildJobFailedEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const projectLink = metadata.projectId
    ? `${APP_URL}/app/projects/${metadata.projectId}`
    : `${APP_URL}/app`
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#f87171;">❌ ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 16px;font-size:15px;line-height:1.6;">${body}</p>
    ${metadata.jobId ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Job ID: <code style="color:#a78bfa;">${metadata.jobId}</code></p>` : ''}
    ${metadata.errorMessage
      ? `<div style="background:#111827;border-left:3px solid #ef4444;padding:10px 14px;border-radius:0 6px 6px 0;margin:12px 0 16px;">
           <code style="color:#fca5a5;font-size:12px;word-break:break-all;">${String(metadata.errorMessage).slice(0, 300)}</code>
         </div>`
      : ''}
    ${button('View project logs', projectLink)}
  `)
  return { subject: `❌ Job failed — Backenly`, html }
}

function buildDeployCompleteEmail(
  title: string,
  body: string,
  metadata: Record<string, any>
): NotificationEmailContent {
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#60a5fa;">🚀 ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 16px;font-size:15px;line-height:1.6;">${body}</p>
    ${metadata.url ? `<p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Live at: <a href="${metadata.url}" style="color:#7c3aed;">${metadata.url}</a></p>` : ''}
    ${metadata.url ? button('Open live URL', metadata.url) : ''}
  `)
  return { subject: `🚀 Deployment complete — Backenly`, html }
}

function buildSystemEmail(title: string, body: string, metadata: Record<string, any> = {}): NotificationEmailContent {
  const actionUrl = metadata.actionUrl ?? (APP_URL + '/app')
  const buttonLabel = metadata.actionUrl ? 'Review in Auto-fix Center' : 'Go to dashboard'
  const isHealthAlert = title.includes('critical health') || title.includes('health issue')
  const icon = isHealthAlert ? '🔴' : '📢'
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#ffffff;">${icon} ${title}</h1>
    <p style="color:#9ca3af;margin:0 0 20px;font-size:15px;line-height:1.6;">${body}</p>
    ${isHealthAlert && metadata.types?.length ? `
      <div style="background:#1a0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
        <p style="color:#fca5a5;font-size:13px;margin:0 0 6px;font-weight:700;">Issues detected:</p>
        <ul style="margin:0;padding-left:16px;">
          ${(metadata.types as string[]).map(t => `<li style="color:#f87171;font-size:13px;margin:2px 0;">${t.replace(/_/g, ' ')}</li>`).join('')}
        </ul>
      </div>` : ''}
    ${button(buttonLabel, actionUrl)}
  `)
  return { subject: `${isHealthAlert ? '🔴 ' : ''}${title} — Backenly`, html }
}

function buildGenericEmail(title: string, body: string): NotificationEmailContent {
  const html = shell(`
    <h1 style="font-size:22px;font-weight:800;margin:0 0 8px;color:#ffffff;">${title}</h1>
    <p style="color:#9ca3af;margin:0 0 20px;font-size:15px;line-height:1.6;">${body}</p>
    ${button('Go to dashboard', APP_URL + '/app')}
  `)
  return { subject: `${title} — Backenly`, html }
}
