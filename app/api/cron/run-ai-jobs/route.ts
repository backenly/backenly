/**
 * CRON JOB RUNNER — Vercel Cron endpoint
 * ========================================
 * Called every minute by Vercel Cron (see vercel.json).
 * For self-hosted/Hetzner deployments, node-cron in instrumentation.ts
 * calls these functions directly — no HTTP overhead needed there.
 *
 * Runs two things in parallel:
 *   1. runDueCronJobs()  — user-defined AiFunction cron jobs
 *   2. runSystemTasks()  — webhook retry, stuck-job timeout, queue worker,
 *                          daily cleanup provisioning
 *
 * Security: protected by CRON_SECRET header (set in env).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runDueCronJobs, runSystemTasks } from '@/lib/services/cron-runner'

export async function GET(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.CRON_SECRET
  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [cronResult] = await Promise.allSettled([
      runDueCronJobs(),
      runSystemTasks(),
    ])

    const result = cronResult.status === 'fulfilled' ? cronResult.value : { error: (cronResult as any).reason?.message }
    return NextResponse.json({ ...result, systemTasksRan: true })
  } catch (error: any) {
    console.error('[CronRunner] Error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
