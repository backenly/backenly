/**
 * BACKGROUND JOB WORKER
 * ======================
 * Called every minute from the system cron scheduler.
 * Claims up to 10 due jobs, dispatches them by type, records results.
 *
 * To add a new job type:
 *   1. Add the type to JobType in lib/queue/index.ts
 *   2. Add a handler function here
 *   3. Add a case to the switch in processBackgroundJobs()
 *
 * Progress is broadcast via the event bus so realtime SSE clients can
 * pick it up without this worker knowing about the transport layer.
 */

import { claimNextJobs, completeJob, failJob } from './index'
import { emit } from '@/lib/events/bus'
import { prisma } from '@/lib/db/prisma'

// ── Job Handlers ──────────────────────────────────────────────────────────────

async function handleEmailJob(payload: any): Promise<Record<string, any>> {
  const { to, subject, body, html } = payload

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    return { skipped: true, reason: 'SMTP not configured' }
  }

  // Lazy-load nodemailer so missing package just skips instead of crashing
  const nodemailer = await import('nodemailer').catch(() => null)
  if (!nodemailer) return { skipped: true, reason: 'nodemailer not installed' }

  // Shared builder normalizes port 465 -> 587 (STARTTLS) so queued email works
  // on hosts that block implicit-TLS outbound (e.g. Hetzner).
  const { buildEnvSmtpTransport } = await import('@/lib/email/smtp-transport')
  const transporter = buildEnvSmtpTransport((nodemailer as any).default)
  if (!transporter) return { skipped: true, reason: 'SMTP not configured' }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: body,
    html: html || undefined,
  })

  return { delivered: true, to }
}

async function handleWebhookDeliveryJob(payload: any): Promise<Record<string, any>> {
  // Inline single-attempt webhook delivery for jobs queued by the retry system
  const { targetUrl, secret, webhookPayload, logId, webhookId } = payload

  if (!targetUrl || !secret || !webhookPayload) {
    throw new Error('Missing required webhook delivery fields: targetUrl, secret, webhookPayload')
  }

  const { deliverSingleAttempt } = await import('@/lib/webhooks/index')
  return deliverSingleAttempt(webhookId, targetUrl, secret, webhookPayload, logId)
}

async function handleCleanupJob(payload: any): Promise<Record<string, any>> {
  const { cleanupType } = payload
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days

  if (cleanupType === 'old_logs') {
    const [webhookLogs, requestLogs, intentLogs] = await Promise.all([
      prisma.webhookLog
        .deleteMany({ where: { createdAt: { lt: cutoff }, status: 'SUCCESS' } })
        .then(r => r.count),
      prisma.apiRequestLog
        .deleteMany({ where: { timestamp: { lt: cutoff } } })
        .then(r => r.count),
      // intentLog can grow large — prune entries older than 30 days
      prisma.intentLog
        .deleteMany({ where: { timestamp: { lt: cutoff } } })
        .then(r => r.count)
        .catch(() => 0), // intentLog may not exist in all environments
    ])

    return { cleanupType, webhookLogs, requestLogs, intentLogs }
  }

  if (cleanupType === 'dead_letter_jobs') {
    // Remove dead_letter jobs older than 7 days (they've been notified already)
    const dlCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const removed = await prisma.backgroundJob.deleteMany({
      where: { status: 'dead_letter', completedAt: { lt: dlCutoff } },
    })
    return { cleanupType, removed: removed.count }
  }

  return { cleanupType, skipped: true, reason: 'Unknown cleanup type' }
}

// ── Main Processor ────────────────────────────────────────────────────────────

/**
 * Claim and process up to 10 queued background jobs.
 * Safe to call concurrently — job claiming is atomic.
 */
export async function processBackgroundJobs(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  const jobs = await claimNextJobs(10)
  if (jobs.length === 0) return { processed: 0, succeeded: 0, failed: 0 }

  let succeeded = 0
  let failed = 0

  await Promise.allSettled(
    jobs.map(async (job) => {
      try {
        let result: Record<string, any>

        switch (job.type) {
          case 'email':
            result = await handleEmailJob(job.payload as any)
            break
          case 'webhook_delivery':
            result = await handleWebhookDeliveryJob(job.payload as any)
            break
          case 'cleanup':
            result = await handleCleanupJob(job.payload as any)
            break
          default:
            // Unknown type — complete immediately with a note rather than loop forever
            result = { skipped: true, reason: `No handler for job type '${job.type}'` }
        }

        await completeJob(job.id, result)
        succeeded++

        // Broadcast to realtime clients in the project's channel
        if (job.projectId) {
          emit('execution.complete', job.projectId, {
            action: `job.${job.type}`,
            jobId: job.id,
            result,
          })
        }
      } catch (err: any) {
        const message = err?.message || String(err)
        await failJob(job.id, message)
        failed++

        if (job.projectId) {
          emit('execution.failed', job.projectId, {
            action: `job.${job.type}`,
            jobId: job.id,
            error: message,
          })
        }
      }
    })
  )

  if (jobs.length > 0) {
    console.log(
      `[JobWorker] Processed ${jobs.length} job(s) — ${succeeded} ok, ${failed} failed`
    )
  }

  return { processed: jobs.length, succeeded, failed }
}
