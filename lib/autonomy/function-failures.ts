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
 *
 * One kind of failure is certain before any run: code that reads a variable
 * Backenly no longer gives functions (readingWithheldVariables, below).
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { isFunctionSwitchedOff } from '@/lib/services/ai-functions/status'
import { NOT_A_RUN } from '@/lib/services/ai-functions/record-kinds'
import { readsWithheldEnv, WITHHELD_ENV_NAMES } from '@/lib/services/ai-functions/route-module-runner'

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
       -- Records of runs that did not happen, and notices, say nothing about
       -- the code (record-kinds.ts): a function at its monthly cap is not failing.
       AND "triggerType" <> ALL(${[...NOT_A_RUN]}::text[])
     GROUP BY "functionId"`

  const failing = counts.filter(
    (c) => c.failures >= FAILING_MIN_FAILURES && c.lastFailedAt !== null && c.lastFailedAt.getTime() === c.lastAt.getTime(),
  )
  const findings = await failingRuns(projectId, failing)
  // One row per function (workspace-observer keys these on functionId): a
  // function whose runs already show the failure is reported from its runs.
  const reported = new Set(findings.map((f) => String(f.details.functionId)))
  return [...findings, ...(await readingWithheldVariables(projectId, reported))]
}

async function failingRuns(projectId: string, failing: RunCounts[]): Promise<RawFinding[]> {
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
      where: { functionId: c.functionId, success: false, triggerType: { notIn: [...NOT_A_RUN] } },
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

/**
 * Functions whose stored code reads a variable Backenly no longer gives
 * function code: the project's signing secret or its admin key. Every call to
 * one fails, so it is reported from its code, before anyone calls it.
 *
 * Deploying such code is refused (validateRouteModule), and Backenly's own
 * template code was rewritten when the variables were withheld
 * (scripts/stop-functions-reading-withheld-env.ts), so what this finds is code
 * its owner wrote before then. Never repaired here: the code is the owner's.
 * It clears once the code no longer reads the variable, or the function is
 * switched off or removed.
 */
async function readingWithheldVariables(projectId: string, reported: Set<string>): Promise<RawFinding[]> {
  const functions = await prisma.aiFunction.findMany({
    // The names, as a cheap first pass; readsWithheldEnv decides.
    where: { projectId, OR: WITHHELD_ENV_NAMES.map((name) => ({ generatedCode: { contains: name } })) },
    select: { id: true, name: true, status: true, triggerType: true, triggerTable: true, generatedCode: true },
  })
  const findings: RawFinding[] = []
  for (const fn of functions) {
    if (reported.has(fn.id) || isFunctionSwitchedOff(fn.status)) continue
    const variable = readsWithheldEnv(fn.generatedCode)
    if (!variable) continue
    findings.push({
      type: 'function_failing',
      // Nothing has run yet to show the damage; a call that fails three times
      // is reported from its runs instead, as critical when every run failed.
      severity: 'warning',
      autoFixable: false,
      details: {
        functionId: fn.id,
        functionName: fn.name,
        trigger: fn.triggerType,
        ...(fn.triggerType.startsWith('on_db_') && fn.triggerTable ? { tableName: fn.triggerTable } : {}),
        reason: 'reads_withheld_variable',
        variable,
      },
    })
  }
  return findings
}
