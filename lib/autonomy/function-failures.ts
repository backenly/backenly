/**
 * Functions that keep failing.
 *
 * Production QA (2026-11-09): a function a coding agent deployed on order
 * updates failed on every real update for two hours, while the loop reported
 * "27 guarantees checked, 0 broken". Nothing read the run log. The function's
 * code belongs to whoever wrote it, so this never repairs anything: it says
 * which function, how often it failed, the last error, and what to do.
 *
 * A function is reported when it failed at least FAILING_MIN_FAILURES times in
 * the last FAILING_WINDOW_MS and its most recent run failed too, so one that
 * has been fixed stops being reported with its first good run. A function that
 * is switched off runs nothing and is not reported.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { isFunctionSwitchedOff } from '@/lib/services/ai-functions/status'

export const FAILING_WINDOW_MS = 24 * 60 * 60_000
export const FAILING_MIN_FAILURES = 3

interface RunCounts {
  functionId: string
  runs: number
  failures: number
  lastAt: Date
  lastFailedAt: Date | null
}

/** The first line of an error, as the function's logs page shows it, kept short. */
function firstLine(error: string | null | undefined): string | null {
  if (!error) return null
  const line = error.split('\n')[0].replace(/\s+/g, ' ').trim()
  if (!line) return null
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

export async function detectFailingFunctions(projectId: string): Promise<RawFinding[]> {
  const since = new Date(Date.now() - FAILING_WINDOW_MS)
  // "createdAt" holds UTC without a zone: the bound is given in UTC whatever
  // the session's time zone.
  const counts = await prisma.$queryRaw<RunCounts[]>`
    SELECT "functionId",
           count(*)::int AS runs,
           (count(*) FILTER (WHERE NOT success))::int AS failures,
           max("createdAt") AS "lastAt",
           max("createdAt") FILTER (WHERE NOT success) AS "lastFailedAt"
      FROM ai_function_logs
     WHERE "projectId" = ${projectId}
       AND "createdAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
     GROUP BY "functionId"`

  const failing = counts.filter(
    (c) => c.failures >= FAILING_MIN_FAILURES && c.lastFailedAt !== null && c.lastFailedAt.getTime() === c.lastAt.getTime(),
  )
  if (failing.length === 0) return []

  const functions = await prisma.aiFunction.findMany({
    where: { projectId, id: { in: failing.map((c) => c.functionId) } },
    select: { id: true, name: true, status: true, triggerType: true, triggerTable: true },
  })
  const byId = new Map(functions.map((f) => [f.id, f]))

  const findings: RawFinding[] = []
  for (const c of failing) {
    const fn = byId.get(c.functionId)
    if (!fn || isFunctionSwitchedOff(fn.status)) continue
    const last = await prisma.aiFunctionLog.findFirst({
      where: { functionId: c.functionId, success: false },
      orderBy: { createdAt: 'desc' },
      select: { error: true },
    })
    findings.push({
      type: 'function_failing',
      // Every run in the window failed: whatever it does is not happening.
      severity: c.failures === c.runs ? 'critical' : 'warning',
      autoFixable: false,
      details: {
        functionId: fn.id,
        functionName: fn.name,
        trigger: fn.triggerType,
        ...(fn.triggerType.startsWith('on_db_') && fn.triggerTable ? { tableName: fn.triggerTable } : {}),
        runs: c.runs,
        failures: c.failures,
        lastFailedAt: c.lastFailedAt!.toISOString(),
        lastError: firstLine(last?.error),
        windowHours: FAILING_WINDOW_MS / 3_600_000,
      },
    })
  }
  return findings
}
