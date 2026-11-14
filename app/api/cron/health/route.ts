/**
 * GET /api/cron/health — confirm the cron scheduler is alive
 * Used by monitoring systems to verify the cron runtime is running.
 *
 * Liveness (mode, start time, leadership) answers anyone. What the scheduler
 * has run is about every project's functions (how many are scheduled, and the
 * name and status of the last one to run), so it answers only a caller with
 * this server's CRON_SECRET (lib/security/cron-auth.ts).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isSchedulerLeader } from '@/lib/scheduler/leader'
import { RUNNABLE_FUNCTION_STATUS_FILTER } from '@/lib/services/ai-functions/status'
import { isCronRequest } from '@/lib/security/cron-auth'

export async function GET(request: NextRequest) {
  const schedulerStartedAt = (globalThis as any).__cronSchedulerStartedAt ?? null
  const isVercel = !!process.env.VERCEL
  const liveness = {
    ok: true,
    mode: isVercel ? 'vercel-cron' : 'node-cron',
    schedulerStartedAt,
    // Whether THIS instance runs the jobs. With several instances exactly one
    // answers true; the others schedule but stand by (lib/scheduler/leader.ts).
    schedulerLeader: isVercel ? null : isSchedulerLeader(),
  }
  if (!isCronRequest(request, { query: true })) return NextResponse.json(liveness)

  // Find the most recently-run cron AiFunction to confirm execution happened
  const lastRunJob = await prisma.aiFunction.findFirst({
    where: { triggerType: 'cron', lastRun: { not: null } },
    orderBy: { lastRun: 'desc' },
    select: { name: true, lastRun: true, status: true },
  }).catch(() => null)

  const activeCronJobs = await prisma.aiFunction.count({
    where: { triggerType: 'cron', status: RUNNABLE_FUNCTION_STATUS_FILTER },
  }).catch(() => 0)

  return NextResponse.json({
    ...liveness,
    activeCronJobs,
    lastExecutedJob: lastRunJob
      ? { name: lastRunJob.name, lastRun: lastRunJob.lastRun, status: lastRunJob.status }
      : null,
  })
}
