/**
 * Platform Notification Service
 * ==============================
 * Creates in-app notifications for developers using the Backenly platform.
 *
 * These are NOT end-user notifications (those live in workspace schemas).
 * These notify the developer about events on THEIR account:
 *   - payment_success / payment_failed
 *   - credits_low  (AI usage >= 80% of plan limit)
 *   - usage_limit  (a usage quota or the spend limit crossed a threshold; lib/usage/alerts.ts)
 *   - job_completed / job_failed  (workspace job table events)
 *   - deploy_complete
 *   - system  (maintenance, feature announcements, etc.)
 *   - health_alert  (a critical problem in one of their backends that needs them)
 *   - approval_requested  (their coding agent parked a call that waits for their approval)
 *
 * Every `createPlatformNotification` call:
 *   1. Checks NotificationPreference — if inAppEnabled=false, skips DB insert.
 *   2. Inserts DB record (if inAppEnabled).
 *   3. Checks NotificationPreference — if emailEnabled=false, skips email.
 *   4. Looks up user email and sends templated email (if emailEnabled).
 */

import nodemailer from 'nodemailer'
import { prisma } from '@/lib/db/prisma'
import { buildNotificationEmail } from './email-templates'
import { formatAmount, formatLongDate, type PaymentReceipt } from './payment-receipt-email'
import { buildEnvSmtpTransport } from '@/lib/email/smtp-transport'
import { planDisplayName } from '@/lib/entitlements/plan-names'

export type PlatformNotificationType =
  | 'payment_success'
  | 'payment_failed'
  | 'credits_low'
  | 'usage_limit'         // A usage quota or the spend limit crossed 50/80/100% (lib/usage/alerts.ts)
  | 'job_completed'
  | 'job_failed'
  | 'deploy_complete'
  | 'system'
  | 'autonomous_action'   // "While you were away" — autonomous background fixes and findings
  | 'health_alert'        // A confirmed critical in one of their backends, still unresolved
  | 'support_update'      // Backenly replied to or resolved one of their support cases
  | 'approval_requested'  // Their coding agent parked a call for approval; it expires unanswered

// All valid types — used for preference initialization
export const ALL_NOTIFICATION_TYPES: PlatformNotificationType[] = [
  'payment_success',
  'payment_failed',
  'credits_low',
  'usage_limit',
  'job_completed',
  'job_failed',
  'deploy_complete',
  'system',
  'autonomous_action',
  'health_alert',
  'support_update',
  'approval_requested',
]

export interface CreateNotificationInput {
  userId: string
  type: PlatformNotificationType
  title: string
  body: string
  metadata?: Record<string, any>
}

// ─── Preference helpers ───────────────────────────────────────────────────────

interface NotificationChannelPrefs {
  inAppEnabled: boolean
  emailEnabled: boolean
}

/**
 * Fetch the effective preference for (userId, type).
 * If no row exists the defaults are both true (opt-in by default).
 */
async function getChannelPrefs(
  userId: string,
  type: PlatformNotificationType
): Promise<NotificationChannelPrefs> {
  try {
    const pref = await prisma.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
      select: { inAppEnabled: true, emailEnabled: true },
    })
    return pref ?? { inAppEnabled: true, emailEnabled: true }
  } catch {
    // Never let a preference failure block a notification
    return { inAppEnabled: true, emailEnabled: true }
  }
}

// ─── Email transport ──────────────────────────────────────────────────────────

function getMailTransporter(): nodemailer.Transporter | null {
  // Shared builder normalizes port 465 -> 587 (STARTTLS) so notifications send
  // on hosts that block implicit-TLS outbound (e.g. Hetzner).
  return buildEnvSmtpTransport(nodemailer)
}

async function getUserEmail(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
    return user?.email ?? null
  } catch {
    return null
  }
}

async function sendNotificationEmail(
  userEmail: string,
  type: PlatformNotificationType,
  title: string,
  body: string,
  metadata: Record<string, any>
): Promise<void> {
  try {
    const { subject, html, text, replyTo, attachments } = buildNotificationEmail(type, title, body, metadata)
    const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
    const transporter = getMailTransporter()

    if (transporter) {
      await transporter.sendMail({ from, to: userEmail, subject, html, text, replyTo, attachments })
    } else {
      // Dev fallback: log instead of dropping
      console.log(`\n========== NOTIFICATION EMAIL ==========`)
      console.log(`To:      ${userEmail}`)
      console.log(`Subject: ${subject}`)
      console.log(`Type:    ${type}`)
      console.log(`Body:    ${body}`)
      console.log(`========================================\n`)
    }
  } catch (err: any) {
    console.warn('[PlatformNotification] Email send failed:', err?.message)
  }
}

// ─── Core: create notification ────────────────────────────────────────────────

/**
 * Create a single platform notification for a user.
 *
 * Flow:
 *  1. Load channel prefs (default: both enabled).
 *  2. If inAppEnabled → insert DB record.
 *  3. If emailEnabled → look up user email and send templated email.
 *
 * Non-throwing — logs and continues so callers never crash.
 */
export async function createPlatformNotification(input: CreateNotificationInput): Promise<void> {
  const { userId, type, title, body, metadata = {} } = input

  try {
    const prefs = await getChannelPrefs(userId, type)

    // --- In-app notification ---
    if (prefs.inAppEnabled) {
      try {
        await prisma.platformNotification.create({
          data: { userId, type, title, body, metadata },
        })
      } catch (err: any) {
        console.warn('[PlatformNotification] DB insert failed:', err?.message)
      }
    }

    // --- Email notification ---
    if (prefs.emailEnabled) {
      const userEmail = await getUserEmail(userId)
      if (userEmail) {
        await sendNotificationEmail(userEmail, type, title, body, metadata)
      }
    }
  } catch (err: any) {
    console.warn('[PlatformNotification] createPlatformNotification error:', err?.message)
  }
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Tell the payer their plan payment went through, with a receipt.
 *
 * `receipt` is what the payment provider's paid invoice states; Backenly Cloud
 * passes it from its billing webhook, and the email names only what it is
 * given (./payment-receipt-email). The plan is named as customers know it
 * (Pro, not BUILDER), and dates are written out in UTC rather than in the
 * server's locale, where November 25 came out as "11/25/2026".
 */
export async function notifyPaymentSuccess(
  userId: string,
  planName: string,
  periodEnd?: Date,
  receipt: PaymentReceipt = {},
): Promise<void> {
  const plan = planDisplayName(planName)
  const amount =
    typeof receipt.amountPaid === 'number' && receipt.currency ? formatAmount(receipt.amountPaid, receipt.currency) : null
  const next = periodEnd
    ? receipt.renews === false
      ? ` It stays active until ${formatLongDate(periodEnd)}.`
      : ` It renews on ${formatLongDate(periodEnd)}.`
    : ''
  await createPlatformNotification({
    userId,
    type: 'payment_success',
    title: 'Payment received',
    body: (amount ? `We received ${amount} for your ${plan} plan.` : `We received your payment for the ${plan} plan.`) + next,
    metadata: { ...receiptMetadata(receipt), planName, periodEnd: periodEnd?.toISOString() },
  })
}

/** A receipt as notification metadata: JSON, so dates as ISO strings, and only what is known. */
function receiptMetadata(receipt: PaymentReceipt): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(receipt)) {
    if (value === null || value === undefined) continue
    out[key] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

/**
 * Notify developer that their payment failed.
 */
export async function notifyPaymentFailed(userId: string, graceUntil?: Date): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'payment_failed',
    title: 'Payment failed',
    body: graceUntil
      ? `We couldn't process your payment. You have a grace period until ${graceUntil.toLocaleDateString()} — please update your billing details.`
      : `We couldn't process your payment. Please update your billing details to keep your subscription active.`,
    metadata: { graceUntil: graceUntil?.toISOString() },
  })
}

/**
 * Notify developer that their subscription is scheduled to end.
 *
 * A voluntary cancellation used to send notifyPaymentFailed, telling customers
 * "We couldn't process your payment" about a payment that never failed and a
 * grace period that no longer exists. `endsAt` is the provider's date, so this
 * states when paid access actually stops.
 *
 * Deliberately typed `system` rather than adding a ninth notification type:
 * the type union drives preference initialisation and the email template switch,
 * and neither belongs in a billing-semantics change.
 */
export async function notifySubscriptionCanceled(userId: string, endsAt?: Date): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'system',
    title: 'Subscription cancelled',
    body: endsAt
      ? `Your subscription is cancelled and stays active until ${endsAt.toLocaleDateString()}. After that your account moves to the free plan. You can resubscribe any time.`
      : `Your subscription is cancelled and stays active until the end of the period you have paid for. After that your account moves to the free plan.`,
    metadata: { endsAt: endsAt?.toISOString() },
  })
}

/**
 * Notify developer when their AI build action usage crosses 80% of plan limit.
 */
export async function notifyCreditsLow(
  userId: string,
  used: number,
  limit: number,
  month: string
): Promise<void> {
  const pct = Math.round((used / limit) * 100)
  await createPlatformNotification({
    userId,
    type: 'credits_low',
    title: 'AI credits running low',
    body: `You've used ${pct}% of your AI build actions for ${month} (${used}/${limit}). Upgrade your plan or wait until next month to get more.`,
    metadata: { used, limit, pct, month },
  })
}

/**
 * Notify developer that a generation/render job completed.
 */
export async function notifyJobCompleted(
  userId: string,
  projectId: string,
  table: string,
  jobId: string,
  outputUrl?: string
): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'job_completed',
    title: 'Generation job completed',
    body: outputUrl
      ? `Your job finished successfully. The output is ready.`
      : `Job ${jobId} in project ${projectId} completed.`,
    metadata: { projectId, table, jobId, outputUrl },
  })
}

/**
 * Notify developer that a generation/render job failed.
 */
export async function notifyJobFailed(
  userId: string,
  projectId: string,
  table: string,
  jobId: string,
  errorMessage?: string
): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'job_failed',
    title: 'Generation job failed',
    body: errorMessage
      ? `Job failed: ${errorMessage.slice(0, 200)}`
      : `Job ${jobId} in project ${projectId} failed. Check your logs for details.`,
    metadata: { projectId, table, jobId, errorMessage },
  })
}

/**
 * Notify developer that a deployment finished.
 */
export async function notifyDeployComplete(
  userId: string,
  projectId: string,
  projectName: string,
  url?: string
): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'deploy_complete',
    title: 'Deployment complete',
    body: url
      ? `Project "${projectName}" deployed successfully. Your backend is live.`
      : `Project "${projectName}" deployed successfully.`,
    metadata: { projectId, projectName, url },
  })
}

/**
 * Tell a project's owner that their coding agent parked a call for approval.
 *
 * The request runs only once a human approves it and expires unanswered after
 * a day. Nothing else announced it: it appeared only in the Review Queue on the
 * Autonomy page, so a request nobody happened to look for simply ran out
 * (AUT-08).
 *
 * `target` is null for a project kept in another region: its notice names the
 * action only (lib/data-plane/residency.ts).
 */
/** What a restore request asks, when its target cannot be quoted. */
const RESTORE_ASKS: Record<string, string> = {
  rollback_deploy: 'restore the backend to a published version',
  revert_schema_change: 'restore the state before a change',
}

export async function notifyApprovalRequested(
  userId: string,
  request: { projectId: string; projectName: string; approvalId: string; tool: string; target: string | null; expiresAt: Date },
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
  // A restore says what it restores; its target is already a sentence
  // ("Restore the backend to v3, …"), not a thing a tool runs on.
  const restore = RESTORE_ASKS[request.tool]
  const asked = restore
    ? request.target ? request.target.charAt(0).toLowerCase() + request.target.slice(1) : restore
    : `run ${request.tool}${request.target ? ` on ${request.target}` : ''}`
  await createPlatformNotification({
    userId,
    type: 'approval_requested',
    title: `Your agent is waiting for your approval in "${request.projectName}"`,
    body:
      `It asked to ${asked}. Approve or reject it in the ` +
      `Review Queue on the Autonomy page. Nothing runs until you do, and the request expires ${request.expiresAt.toUTCString()}.`,
    metadata: {
      projectId: request.projectId,
      approvalId: request.approvalId,
      tool: request.tool,
      ...(request.target ? { target: request.target } : {}),
      expiresAt: request.expiresAt.toISOString(),
      actionUrl: `${appUrl}/app/projects/${request.projectId}/autonomy`,
    },
  })
}

/**
 * Check if we should send a credits_low notification.
 * Avoids re-notifying if we already sent one in the same month.
 */
export async function checkAndNotifyCreditsLow(
  userId: string,
  month: string,
  used: number,
  limit: number
): Promise<void> {
  if (!limit || used < limit * 0.8) return

  const alreadyNotified = await prisma.platformNotification.findFirst({
    where: {
      userId,
      type: 'credits_low',
      createdAt: {
        gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      },
    },
    select: { id: true },
  })

  if (alreadyNotified) return

  await notifyCreditsLow(userId, used, limit, month)
}
