/**
 * A REGION'S COPY CHECKED AGAINST HOME, HOURLY
 * ============================================
 * Every change reaches a region's copy through the capture triggers' record of
 * it (lib/auth-projection/deliver.ts). A path that removed such a record before
 * it was delivered, or changed the watched tables with triggers off (a
 * data-only restore, replication), would leave the copy holding a row home no
 * longer has while its watermark stays fresh: a revoked key, a deleted project.
 * Nothing would ever correct it. The deletion sweep did exactly that until
 * backenly/backenly#434.
 *
 * This check bounds any such gap to an hour. Each row in the copy is looked up
 * at home; one home no longer has, or no longer copies, is queued for removal,
 * and the next delivery carries it out the usual way. A row missing from the
 * copy needs no check, because a reader asks home for it. Finding anything is
 * a defect somewhere else, so it is reported as an error.
 */

import { prisma } from '@/lib/db/prisma'
import { regionRawClient } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'

/** Rows looked up per query, on each side. */
const PAGE = 2_000

interface Queued {
  entity: 'project' | 'api_key' | 'branch'
  projectId: string
  entityId: string
}

export interface Reconciliation {
  checked: number
  /** Rows the copy held that home no longer has or copies, now queued for removal. */
  queued: number
}

export async function reconcileRegionCopy(region: CloudRegionId): Promise<Reconciliation> {
  const copy = regionRawClient(region)
  const result: Reconciliation = { checked: 0, queued: 0 }

  // Projects: present at home, and in this region.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM public.auth_projection_projects WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    const home = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "projects" WHERE "id" = ANY(${ids}::text[]) AND "region" = ${region}`
    const present = new Set(home.map((row) => row.id))
    result.queued += await queue(
      region,
      ids.filter((id) => !present.has(id)).map((id) => ({ entity: 'project', projectId: id, entityId: id })),
    )
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  // Keys: present at home, in a project of this region, and still copied.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<{ id: string; projectId: string }[]>`
      SELECT "id", "projectId" FROM public.auth_projection_keys WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    const home = await prisma.$queryRaw<{ id: string }[]>`
      SELECT k."id" FROM "api_keys" k JOIN "projects" p ON p."id" = k."projectId"
       WHERE k."id" = ANY(${ids}::text[]) AND p."region" = ${region}
         AND k."scope" = 'runtime' AND k."serviceRole" = false AND k."keyType" = 'public'`
    const present = new Set(home.map((row) => row.id))
    result.queued += await queue(
      region,
      rows.filter((row) => !present.has(row.id)).map((row) => ({ entity: 'api_key', projectId: row.projectId, entityId: row.id })),
    )
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  // Branches: present at home, in a project of this region.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<{ id: string; projectId: string }[]>`
      SELECT "id", "projectId" FROM public.auth_projection_branches WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    const home = await prisma.$queryRaw<{ id: string }[]>`
      SELECT b."id" FROM "workspace_branches" b JOIN "projects" p ON p."id" = b."projectId"
       WHERE b."id" = ANY(${ids}::text[]) AND p."region" = ${region}`
    const present = new Set(home.map((row) => row.id))
    result.queued += await queue(
      region,
      rows.filter((row) => !present.has(row.id)).map((row) => ({ entity: 'branch', projectId: row.projectId, entityId: row.id })),
    )
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  if (result.queued > 0) {
    console.error(
      `[auth-projection] ${region}: the copy held ${result.queued} row(s) home no longer has or copies, ` +
        'so a change never reached it; they are queued for removal. Something removed their records before delivery.',
    )
  }
  return result
}

async function queue(region: CloudRegionId, rows: Queued[]): Promise<number> {
  if (rows.length === 0) return 0
  return prisma.$executeRaw`
    INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
    SELECT ${region}, r."projectId", r."entity", r."entityId"
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r("entity" text, "projectId" text, "entityId" text)`
}
