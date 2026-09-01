/**
 * Platform Notification Service
 * ==============================
 * Creates in-app notifications for developers using the Backenly platform.
 *
 * These are NOT end-user notifications (those live in workspace schemas).
 * These notify the developer about events on THEIR account:
 *   - payment_success / payment_failed
 *   - credits_low  (AI usage >= 80% of plan limit)
 *   - job_completed / job_failed  (workspace job table events)
 *   - deploy_complete
 *   - system  (maintenance, feature announcements, etc.)
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
import { buildEnvSmtpTransport } from '@/lib/email/smtp-transport'

export type PlatformNotificationType =
  | 'payment_success'
  | 'payment_failed'
  | 'credits_low'
  | 'job_completed'
  | 'job_failed'
  | 'deploy_complete'
  | 'system'
  | 'autonomous_action'   // "While you were away" — autonomous background fixes and findings

// All valid types — used for preference initialization
export const ALL_NOTIFICATION_TYPES: PlatformNotificationType[] = [
  'payment_success',
  'payment_failed',
  'credits_low',
  'job_completed',
  'job_failed',
  'deploy_complete',
  'system',
  'autonomous_action',
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
    const { subject, html } = buildNotificationEmail(type, title, body, metadata)
    const from = process.env.SMTP_FROM || 'Backenly <noreply@backenly.com>'
    const transporter = getMailTransporter()

    if (transporter) {
      await transporter.sendMail({ from, to: userEmail, subject, html })
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
 * Notify developer that their payment succeeded.
 */
export async function notifyPaymentSuccess(userId: string, planName: string, periodEnd?: Date): Promise<void> {
  await createPlatformNotification({
    userId,
    type: 'payment_success',
    title: 'Payment successful',
    body: periodEnd
      ? `Your ${planName} subscription is active until ${periodEnd.toLocaleDateString()}.`
      : `Your ${planName} subscription is now active.`,
    metadata: { planName, periodEnd: periodEnd?.toISOString() },
  })
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
