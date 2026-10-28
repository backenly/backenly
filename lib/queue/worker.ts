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

import {
  claimNextJobs,
  claimPurgeJobs,
  claimRegionalJobs,
  completeJob,
  completePurgeJob,
  completeRegionalJob,
  failJob,
  failPurgeJob,
  failRegionalJob,
} from './index'
import type { Prisma } from '@prisma/client'
import { emit } from '@/lib/events/bus'
import { prisma } from '@/lib/db/prisma'
import { serviceRegion } from '@/lib/data-plane/serving'
import type { CloudRegionId } from '@/lib/regions'

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

export type RetentionPurgeMode = 'off' | 'dry-run' | 'enforce'

/**
 * How the 90-day retention of approval requests and security events runs,
 * read from BACKENLY_RETENTION_PURGE. It deletes records for good, so a backup
 * is the only way back; until the founders turn it on (`enforce`) the daily
 * cleanup only counts what it would delete and logs the count, and `off`
 * skips it. Anything else is dry-run, never enforce. The 30-day pruning of
 * delivery, request and intent logs does not depend on it.
 */
export function retentionPurgeMode(raw: string | undefined = process.env.BACKENLY_RETENTION_PURGE): RetentionPurgeMode {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'off' || value === 'enforce' ? value : 'dry-run'
}

/**
 * Delete the approval requests `where` selects, after what a regional
 * project's request keeps in its region (lib/mcp/approval-request-bodies.ts):
 * the request's words and exact call, which last exactly as long as its row. A
 * request whose region cannot be reached keeps its row until a later run can
 * reach it, so no record outlives the row that names it. Returns how many rows
 * were deleted.
 */
async function deleteApprovalRequests(where: Prisma.AgentApprovalRequestWhereInput): Promise<number> {
  const keptInRegion = await prisma.agentApprovalRequest.findMany({
    where: { AND: [where, { toolArgs: { path: ['keptInRegion'], equals: true } }] },
    select: { id: true, projectId: true },
  })
  const { forgetApprovalRequests } = await import('@/lib/mcp/approval-request-bodies')
  const unreached = keptInRegion.length > 0 ? await forgetApprovalRequests(keptInRegion) : []
  const deletable = unreached.length > 0 ? { AND: [where, { id: { notIn: unreached } }] } : where
  return prisma.agentApprovalRequest.deleteMany({ where: deletable }).then(r => r.count)
}

export async function handleCleanupJob(payload: any): Promise<Record<string, any>> {
  const { cleanupType } = payload
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days
  // 90 days for two records the founders set it for (2026-10-16), both of which
  // can hold an end user's data: an approval request, counted from its decision
  // (it keeps the parked call's exact arguments, which the approver read), or
  // from its expiry when nobody decided; and a security event, which records
  // an end user's network, the path they asked for and its detail.
  const retained = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  if (cleanupType === 'old_logs') {
    const retentionMode = retentionPurgeMode()
    const approvalsPastRetention = {
      OR: [{ decidedAt: { lt: retained } }, { decidedAt: null, expiresAt: { lt: retained } }],
    }
    const eventsPastRetention = { createdAt: { lt: retained } }

    const [webhookLogs, requestLogs, intentLogs, retention] = await Promise.all([
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
      retentionMode === 'enforce'
        ? Promise.all([
            deleteApprovalRequests(approvalsPastRetention),
            prisma.securityEvent.deleteMany({ where: eventsPastRetention }).then(r => r.count),
          ])
        : retentionMode === 'dry-run'
          ? Promise.all([
              prisma.agentApprovalRequest.count({ where: approvalsPastRetention }),
              prisma.securityEvent.count({ where: eventsPastRetention }),
            ])
          : Promise.resolve(null),
    ])

    if (retentionMode === 'enforce') {
      const [approvalRequests, securityEvents] = retention!
      return { cleanupType, webhookLogs, requestLogs, intentLogs, retentionMode, approvalRequests, securityEvents }
    }
    if (retentionMode === 'dry-run') {
      const [approvalRequests, securityEvents] = retention!
      console.info(
        `[retention] dry run: ${approvalRequests} approval request(s) decided or expired before ` +
          `${retained.toISOString()} and ${securityEvents} security event(s) recorded before then are past ` +
          `90 days and were kept; BACKENLY_RETENTION_PURGE=enforce deletes them`,
      )
      return {
        cleanupType, webhookLogs, requestLogs, intentLogs, retentionMode,
        approvalRequests: 0, securityEvents: 0,
        retentionDue: { approvalRequests, securityEvents, before: retained.toISOString() },
      }
    }
    return { cleanupType, webhookLogs, requestLogs, intentLogs, retentionMode, approvalRequests: 0, securityEvents: 0 }
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

// ── Purge processor ───────────────────────────────────────────────────────────

/**
 * Finish deleting a project's files after its database rows are already gone.
 *
 * Deliberately NOT a case in `processBackgroundJobs`'s switch. Purge jobs never
 * enter the `queued` status that `claimNextJobs` selects, because a released
 * worker without this handler would complete them as unknown and destroy the
 * only durable record that a customer's backups still need deleting. See
 * PURGE_STATUS in lib/queue/index.ts for the full argument.
 *
 * Called every minute by every region's scheduler (`runRegionalSystemTasks`):
 * each purges what was kept in its own region, whose bucket and disks are its
 * own, so no region reaches into another's.
 */
export async function processPurgeJobs(region: CloudRegionId = serviceRegion()): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  const jobs = await claimPurgeJobs(5, region)
  if (jobs.length === 0) return { processed: 0, succeeded: 0, failed: 0 }

  let succeeded = 0
  let failed = 0

  await Promise.allSettled(
    jobs.map(async (job) => {
      const payload = (job.payload ?? {}) as { projectId?: unknown; storageDriver?: unknown }
      const projectId = payload.projectId

      if (typeof projectId !== 'string' || projectId.length === 0) {
        // Unrecoverable rather than transient: no amount of retrying finds a
        // target that was never recorded. Close it out instead of burning
        // attempts, and say so in the result.
        await completePurgeJob(job.id, {
          skipped: true,
          reason: 'purge job carries no projectId',
        })
        succeeded++
        return
      }

      try {
        const { purgeProjectExternals } = await import('@/lib/projects/purge')
        const report = await purgeProjectExternals(projectId, {
          storageDriver: typeof payload.storageDriver === 'string' ? payload.storageDriver : undefined,
          region,
        })
        await completePurgeJob(job.id, {
          projectId: report.projectId,
          backups: report.backups,
          storage: report.storage,
          objectsDeleted: report.objectsDeleted,
        })
        succeeded++
      } catch (err: any) {
        // Message rather than the error object: it can name a path or a bucket,
        // and it is written to a column an operator reads.
        await failPurgeJob(job.id, String(err?.message ?? err).slice(0, 500))
        failed++
      }
    }),
  )

  console.log(`[PurgeWorker] Processed ${jobs.length} purge job(s) — ${succeeded} ok, ${failed} failed`)

  return { processed: jobs.length, succeeded, failed }
}

// ── Regional job processor ────────────────────────────────────────────────────

let regionalJobsRunning = false

/**
 * Carry out what other regions asked of this one (lib/queue/index.ts, regional
 * jobs): a project's snapshot taken, or restored, where its data is, and the
 * batches of a maintenance backfill of a project kept here.
 *
 * Called every minute by every region's scheduler (`runRegionalSystemTasks`).
 * One job at a time, each a pg_dump or a restore of a whole project, and never
 * two passes at once in one process: the scheduler fires every minute whether
 * or not the last pass has finished.
 *
 * What a failure records is the platform's own sentence. The reason the
 * database gave can quote the project's rows, so it goes to this region's own
 * logs and not to the platform database in the home region.
 */
export async function processRegionalJobs(region: CloudRegionId = serviceRegion()): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  if (regionalJobsRunning) return { processed: 0, succeeded: 0, failed: 0 }
  regionalJobsRunning = true
  try {
    const jobs = await claimRegionalJobs(2, region)
    let succeeded = 0
    let failed = 0
    for (const job of jobs) {
      try {
        await completeRegionalJob(job.id, await runRegionalJob(job.type, job.payload))
        succeeded++
      } catch (err: any) {
        console.error(`[RegionalJobs] ${job.type} ${job.id} failed in ${region}:`, err?.message ?? err)
        await failRegionalJob(job.id, err instanceof RegionalJobRefusal ? err.message : failureSentence(job.type, region))
        failed++
      }
    }
    if (jobs.length > 0) {
      console.log(`[RegionalJobs] Processed ${jobs.length} job(s) in ${region}: ${succeeded} ok, ${failed} failed`)
    }
    return { processed: jobs.length, succeeded, failed }
  } finally {
    regionalJobsRunning = false
  }
}

/** A refusal whose sentence is the platform's own, so it is safe to show and store. */
class RegionalJobRefusal extends Error {}

function failureSentence(type: string, region: CloudRegionId): string {
  if (type === 'maintenance_backfill') return `The backfill batch did not complete in ${region}. The reason is in that region's logs.`
  if (type === 'evolution_backfill') return `The architecture change's copy batch did not complete in ${region}. The reason is in that region's logs.`
  if (type === 'evolution_advance') return `The architecture change did not start in ${region}. The reason is in that region's logs.`
  if (type === 'evolution_undo') return `The undo of the architecture change did not run in ${region}. The reason is in that region's logs.`
  if (type === 'evolution_rerequest') return `The architecture change was not checked again in ${region}. The reason is in that region's logs.`
  if (type === 'evolution_assess') return `The look for architecture changes did not run in ${region}. The reason is in that region's logs.`
  return type === 'workspace_restore'
    ? `The restore did not complete in ${region}. The reason is in that region's logs.`
    : `The snapshot was not taken in ${region}. The reason is in that region's logs.`
}

async function runRegionalJob(type: string, payload: unknown): Promise<Record<string, any>> {
  const { projectId, backupId, requestedBy: asker } = (payload ?? {}) as { projectId?: unknown; backupId?: unknown; requestedBy?: unknown }
  if (typeof projectId !== 'string' || projectId.length === 0) throw new RegionalJobRefusal('The job names no project.')

  if (type === 'maintenance_backfill') {
    // One batch, then the next queued in this region (primitives/backfill-job.ts).
    // A refusal is a result, read by the ladder; a batch that raised is retried.
    const { handleBackfillJob } = await import('@/lib/autonomy/maintenance/primitives/backfill-job')
    return (await handleBackfillJob(payload as any)) as unknown as Record<string, any>
  }

  if (type === 'evolution_backfill') {
    // The same for an architecture change's copy (lib/structural-evolution/backfill-job.ts).
    const { handleEvolutionBackfillJob } = await import('@/lib/structural-evolution/backfill-job')
    return (await handleEvolutionBackfillJob(payload as any)) as unknown as Record<string, any>
  }

  if (type === 'evolution_advance') {
    // An approved architecture change, run here where its tables are
    // (lib/evolution-engine/engine.ts, startWhereTheTablesAre). Where it got is
    // its decision's to record; the result is the engine's own sentence.
    const { decisionId, actor } = (payload ?? {}) as { decisionId?: unknown; actor?: unknown }
    if (typeof decisionId !== 'string' || decisionId.length === 0) throw new RegionalJobRefusal('The job names no architecture change.')
    const { advance } = await import('@/lib/evolution-engine/engine')
    const r = await advance({ projectId, decisionId, actor: typeof actor === 'string' ? actor : null })
    // Another change was running on the project and nothing of this one ran:
    // tried again after the backoff, so the start the person asked for is not lost.
    if (r.outcome?.status === 'in_flight_elsewhere') throw new RegionalJobRefusal('Another change was running on this project, so the change waited.')
    return { state: r.state, message: r.message }
  }

  if (type === 'evolution_rerequest') {
    // The table moved since the person was asked: rehearsed again here
    // (reRequestDecision), and the queue shows the version for it as it is now.
    // Only the change as it was when the person was told: one that moved on since is left as it is.
    const { decisionId, from, planVersion } = (payload ?? {}) as { decisionId?: unknown; from?: unknown; planVersion?: unknown }
    if (typeof decisionId !== 'string' || decisionId.length === 0) throw new RegionalJobRefusal('The job names no architecture change.')
    const { reRequestDecision } = await import('@/lib/evolution-engine/engine')
    return await reRequestDecision(projectId, decisionId, {
      from: typeof from === 'string' ? from : undefined,
      planVersion: typeof planVersion === 'string' ? planVersion : undefined,
    })
  }

  if (type === 'evolution_assess') {
    // A look a person asked for now. Kept at home as counts only, as every
    // record of a project kept here is.
    const { proposeChanges } = await import('@/lib/evolution-engine/engine')
    const r = await proposeChanges(projectId)
    return { assessed: r.assessed, requested: r.requested, refreshed: r.refreshed, rehearsalFailed: r.rehearsalFailed, skipped: r.skipped.length }
  }

  if (type === 'evolution_undo') {
    // A person's undo, run here for the same reason (undoWhereTheTablesAre).
    // Undo records how it went on the decision; a refusal is that outcome, and
    // only "another change is running" is tried again, after the backoff.
    const { decisionId, userId } = (payload ?? {}) as { decisionId?: unknown; userId?: unknown }
    if (typeof decisionId !== 'string' || decisionId.length === 0 || typeof userId !== 'string' || userId.length === 0) {
      throw new RegionalJobRefusal('The job names no architecture change or no person.')
    }
    const { undo, isActionRefusal } = await import('@/lib/evolution-engine/engine')
    const r = await undo({ projectId, decisionId, userId })
    if (!isActionRefusal(r)) return { state: r.state, message: r.message }
    if (r.busy) throw new RegionalJobRefusal('Another change was running on this project, so the undo waited.')
    return { refusal: r.error }
  }

  const backups = await import('@/lib/services/workspace-backup')

  if (type === 'workspace_backup') {
    const result = await backups.backupWorkspace(projectId)
    if (!result.success) throw new Error(result.error ?? 'snapshot failed')
    return { filename: result.filename, sizeBytes: Number(result.sizeBytes ?? 0) }
  }

  if (type === 'workspace_restore') {
    // Checked again where it runs: a project paused since the request was made
    // takes no writes, a restore least of all.
    const { getProjectServingState } = await import('@/lib/projects/serving-state')
    if ((await getProjectServingState(projectId)).kind === 'paused') {
      throw new RegionalJobRefusal('This project is paused. Resume it before restoring a snapshot.')
    }
    // By the person who asked, in the project's history (requestRestore carries them).
    const result = await backups.restoreWorkspace(projectId, typeof backupId === 'string' ? backupId : undefined, typeof asker === 'string' ? asker : null)
    if (!result.success) throw new Error(result.error ?? 'restore failed')
    return { restoredFrom: result.restoredFrom }
  }

  throw new RegionalJobRefusal(`No handler for regional job type '${type}'.`)
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
          case 'maintenance_backfill': {
            const { handleBackfillJob } = await import(
              '@/lib/autonomy/maintenance/primitives/backfill-job'
            )
            result = await handleBackfillJob(job.payload as any)
            break
          }
          case 'evolution_backfill': {
            const { handleEvolutionBackfillJob } = await import('@/lib/structural-evolution/backfill-job')
            result = await handleEvolutionBackfillJob(job.payload as any)
            break
          }
          case 'purge_project':
            // Unreachable by design: purge rows never sit in 'queued', so
            // claimNextJobs cannot return one. If that ever changes, throwing
            // sends it back through failJob and keeps it retryable, instead of
            // the default branch below completing it with the files still on
            // disk. The one outcome this must never have is silent success.
            throw new Error('purge_project must be processed by processPurgeJobs')
          case 'workspace_backup':
          case 'workspace_restore':
            // The same: regional jobs never sit in 'queued', and must run in
            // the project's own region (processRegionalJobs), never here.
            throw new Error(`${job.type} must be processed by processRegionalJobs`)
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
