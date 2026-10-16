/**
 * BACKGROUND WORK SKIPS WHAT IT CANNOT REACH, AND SAYS SO
 * =======================================================
 * A project's data lives in the region it was created in
 * (lib/data-plane/regional.ts). A process with no connection to that region
 * cannot check, repair, measure or back the project up, and every pass that
 * tried would read the failure the way its fail-soft catches read any failure:
 * no tables, no findings, nothing to fix, 0 bytes. A project nobody could look
 * at would be reported as healthy.
 *
 * So the background passes ask first. Projects this process cannot reach are
 * left out of the pass, and the skip is recorded:
 *   - one log line per pass, grouped by region, for the operator;
 *   - an AUTONOMY_SKIPPED audit row per project, at most once an hour per
 *     process, so the project's own history shows that it was not checked and
 *     why, rather than going quiet.
 *
 * Before that, a pass takes only the projects of the region this process
 * serves (BACKENLY_SERVICE_REGION, lib/data-plane/serving.ts), even ones it
 * could reach over peering: each region's own worker checks, repairs and backs
 * up its own projects, so no fleet pass runs across regions by accident and a
 * regional outage is not quietly covered from elsewhere. That is the normal
 * division of work, not a failure, so it is not recorded.
 */

import { prisma } from '@/lib/db/prisma'
import { partitionReachable, type UnreachableProject } from '@/lib/data-plane/regional'
import { partitionServed } from '@/lib/data-plane/serving'

export const AUTONOMY_SKIPPED = 'AUTONOMY_SKIPPED'

const RECORD_EVERY_MS = 60 * 60 * 1000
const RECORDED_MAX = 10_000
const lastRecorded = new Map<string, number>()

/**
 * The targets this process serves and can reach. Another region's projects are
 * left to that region; the unreachable rest are logged and recorded as skipped
 * for `pass` (a short name of the background work, e.g. 'reconciler').
 */
export async function skipUnreachable<T extends { id: string }>(targets: T[], pass: string): Promise<T[]> {
  const { served } = await partitionServed(targets)
  const { reachable, unreachable } = await partitionReachable(served)
  if (unreachable.length > 0) {
    console.warn(`[${pass}] skipped ${unreachable.length} project(s) this process cannot reach: ${summarize(unreachable)}`)
    await recordSkips(unreachable, pass)
  }
  return reachable
}

/** skipUnreachable for one project: whether `pass` may go ahead with it here. */
export async function canReach(projectId: string, pass: string): Promise<boolean> {
  return (await skipUnreachable([{ id: projectId }], pass)).length === 1
}

function summarize(unreachable: UnreachableProject[]): string {
  const groups = new Map<string, number>()
  for (const u of unreachable) {
    const why = u.code === 'REGION_NOT_CONFIGURED' ? `${u.variable} is not set` : 'a region this build does not know'
    const key = `${u.region} (${why})`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return [...groups].map(([key, n]) => `${key}: ${n}`).join('; ')
}

async function recordSkips(unreachable: UnreachableProject[], pass: string): Promise<void> {
  const now = Date.now()
  for (const u of unreachable) {
    const last = lastRecorded.get(u.projectId)
    if (last !== undefined && now - last < RECORD_EVERY_MS) continue
    if (lastRecorded.size >= RECORDED_MAX) lastRecorded.clear()
    lastRecorded.set(u.projectId, now)
    await prisma.auditLog
      .create({
        data: {
          projectId: u.projectId,
          action: AUTONOMY_SKIPPED,
          type: 'autonomy',
          details: JSON.stringify({ reason: u.code, region: u.region, variable: u.variable ?? null, pass }),
          timestamp: new Date(now),
        },
      })
      .catch(() => {})
  }
}

/** Test seam: forget which skips were recorded. */
export function resetSkipRecords(): void {
  lastRecorded.clear()
}
