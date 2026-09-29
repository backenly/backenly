/**
 * GET /api/cron/health — confirm the cron scheduler is alive
 * Used by monitoring systems to verify the cron runtime is running.
 * Returns the scheduler start time and last known execution stats.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isSchedulerLeader } from '@/lib/scheduler/leader'

export async function GET() {
  const schedulerStartedAt = (globalThis as any).__cronSchedulerStartedAt ?? null
  const isVercel = !!process.env.VERCEL

  // Find the most recently-run cron AiFunction to confirm execution happened
  const lastRunJob = await prisma.aiFunction.findFirst({
    where: { triggerType: 'cron', lastRun: { not: null } },
    orderBy: { lastRun: 'desc' },
    select: { name: true, lastRun: true, status: true, projectId: true },
  }).catch(() => null)

  const activeCronJobs = await prisma.aiFunction.count({
    where: { triggerType: 'cron', status: 'active' },
  }).catch(() => 0)

  return NextResponse.json({
    ok: true,
    mode: isVercel ? 'vercel-cron' : 'node-cron',
    schedulerStartedAt,
    // Whether THIS instance runs the jobs. With several instances exactly one
    // answers true; the others schedule but stand by (lib/scheduler/leader.ts).
    schedulerLeader: isVercel ? null : isSchedulerLeader(),
    activeCronJobs,
    lastExecutedJob: lastRunJob
      ? { name: lastRunJob.name, lastRun: lastRunJob.lastRun, status: lastRunJob.status }
      : null,
  })
}
