/**
 * Keeping the change ledger true over time, for the projects one region serves.
 *
 *   settleInterruptedChangesHere  changes a process stopped working on (a
 *                                 recovery whose lease ran out, a change that
 *                                 never closed) are settled from the catalog,
 *                                 never re-run (recovery.ts reconcileChanges)
 *   purgeExpiredVaultsHere        vaults past their project's retention window
 *                                 are dropped (retention.ts purgeExpiredVaults)
 *
 * Run by each region's scheduler (lib/services/cron-runner.ts
 * runRegionalSystemTasks) for the projects that region serves. A project's
 * catalog and vaults are in its own region's database, so only that region's
 * worker touches them, as for every other background pass
 * (lib/autonomy/region-skip.ts). A project this process cannot reach is skipped
 * and the skip recorded.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { heldInRegionWhere, serviceRegion } from '@/lib/data-plane/serving'
import { skipUnreachable } from '@/lib/autonomy/region-skip'
import { HOME_REGION } from '@/lib/regions'
import { interruptedChangesWhere, reconcileChanges } from './recovery'
import { purgeExpiredVaults } from './retention'
import { VAULT_GRACE_DAYS } from './policy'

const DAY_MS = 24 * 60 * 60 * 1000

/** Projects visited in one pass; the rest are reached by the next. */
const PROJECTS_PER_PASS = 200

export interface UpkeepPass {
  /** Projects this pass visited. */
  projects: number
  /** Changes settled, or vaults dropped. */
  done: number
  /** Projects whose upkeep failed; each is logged and retried next pass. */
  failed: number
}

async function eachProject(
  ids: string[],
  pass: string,
  work: (projectId: string) => Promise<number>,
): Promise<UpkeepPass> {
  const projects = await skipUnreachable(ids.map((id) => ({ id })), pass)
  const result: UpkeepPass = { projects: projects.length, done: 0, failed: 0 }
  for (const { id } of projects) {
    try {
      result.done += await work(id)
    } catch (err) {
      result.failed++
      console.error(`[ChangeUpkeep] ${pass} failed for project=${id}:`, err instanceof Error ? err.message : err)
    }
  }
  return result
}

/** Settle this region's changes that a process stopped working on. */
export async function settleInterruptedChangesHere(now = new Date()): Promise<UpkeepPass> {
  const rows = await prisma.backendChange.findMany({
    where: { ...interruptedChangesWhere(now), project: heldInRegionWhere(serviceRegion()) },
    select: { projectId: true },
    distinct: ['projectId'],
    take: PROJECTS_PER_PASS,
  })
  return eachProject(rows.map((r) => r.projectId), 'change-settle', (projectId) => reconcileChanges(projectId, now))
}

/**
 * Drop this region's change vaults that are past their retention window.
 *
 * The projects visited are those with a vault still kept and older than the
 * grace week, the earliest any vault can expire; purgeExpiredVaults applies
 * each project's own window. The oldest go first, so a pass that stops at its
 * limit leaves the newest for the next. A vault no record names (a process
 * that died before recording it) is dropped when its project is next visited.
 */
export async function purgeExpiredVaultsHere(now = new Date()): Promise<UpkeepPass> {
  const region = serviceRegion()
  const cutoff = new Date(now.getTime() - VAULT_GRACE_DAYS * DAY_MS)
  // The SQL form of heldInRegionWhere(region): the home region also holds every
  // project created before regions, which records none.
  const inRegion = region === HOME_REGION
    ? Prisma.sql`(p."region" IS NULL OR p."region" = ${region})`
    : Prisma.sql`p."region" = ${region}`
  const rows = await prisma.$queryRaw<Array<{ projectId: string }>>`
    SELECT c."projectId"
      FROM "backend_changes" c
      JOIN "projects" p ON p."id" = c."projectId"
     WHERE c."preserved" IS NOT NULL
       AND c."preserved"->>'purgedAt' IS NULL
       AND c."createdAt" < ${cutoff}
       AND ${inRegion}
     GROUP BY c."projectId"
     ORDER BY min(c."createdAt")
     LIMIT ${PROJECTS_PER_PASS}`
  return eachProject(
    rows.map((r) => r.projectId),
    'vault-purge',
    async (projectId) => (await purgeExpiredVaults(projectId, now)).purged.length,
  )
}
