/**
 * A REGION'S COPY CHECKED AGAINST HOME, HOURLY
 * ============================================
 * Every change reaches a region's copy through the capture triggers' record of
 * it (lib/auth-projection/deliver.ts). A path that removed such a record before
 * it was delivered, or changed the watched tables with triggers off (a
 * data-only restore, replication), would leave the copy holding a row home no
 * longer has while its watermark stays fresh: a revoked key, a deleted project.
 * Or holding a row as it was: a lock, a pause, a rotated secret or a key's
 * narrowed permissions that never reached the region. Nothing would ever
 * correct it. The deletion sweep did exactly that until backenly/backenly#434.
 *
 * This check bounds any such gap to an hour. Each row in the copy is looked up
 * at home: one home no longer has, or no longer copies, is queued for removal;
 * one whose contents differ from what a delivery would write now is queued to
 * be written again. The next delivery carries out both the usual way. A row
 * with a change already waiting for delivery is in flight, and left to it. A row
 * missing from the copy needs no check, because a reader asks home for it.
 * Finding anything is a defect somewhere else, so it is reported as an error,
 * by counts only: never a value.
 */

import { prisma } from '@/lib/db/prisma'
import { regionRawClient } from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'

/** Rows looked up per query, on each side. */
const PAGE = 2_000

interface Queued {
  entity: 'project' | 'api_key' | 'branch'
  projectId: string
  entityId: string
}

export interface Reconciliation {
  checked: number
  /** Rows queued for delivery again: gone or no longer copied at home, or holding other contents than home's. */
  queued: number
  /** Of those, the rows home still copies whose contents differ from home's. */
  drifted: number
}

// What a delivery writes, field by field (deliver.ts, apply). The signing secret
// is compared by its value: the copy keeps it encrypted afresh, so its text never
// equals home's.
const PROJECT_FIELDS = ['lockedDownAt', 'lockedDownReason', 'pausedAt', 'pauseReason', 'userId', 'organizationId'] as const
const KEY_FIELDS = [
  'projectId', 'keyHash', 'name', 'keyPrefix', 'userId', 'role', 'permissions', 'capabilities',
  'expiresAt', 'rateLimit', 'rateLimitWindow', 'scope', 'keyType', 'serviceRole', 'branchId',
] as const
const BRANCH_FIELDS = ['projectId', 'name', 'status', 'schemaName'] as const

type Row = Record<string, unknown> & { id: string }

/** Equal as a delivery writes it: instants for dates, members in order for lists, the value otherwise. */
export function sameDelivered(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null)
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i])
  }
  return (a ?? null) === (b ?? null)
}

/** A signing secret's value, or null when there is none or it cannot be read: delivery copies those as none. */
function secretValue(stored: unknown): string | null {
  if (typeof stored !== 'string' || !stored) return null
  try {
    return JWTSecretManager.resolve(stored)
  } catch {
    return null
  }
}

/**
 * The rows of this kind with a change recorded for the region and not delivered yet: in flight, so neither gone nor
 * drifted. The next delivery writes them as home has them now.
 */
async function inFlight(region: CloudRegionId, entity: Queued['entity'], ids: string[]): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<{ entityId: string }[]>`
    SELECT DISTINCT "entityId" FROM "auth_projection_changes"
     WHERE "region" = ${region} AND "entity" = ${entity} AND "deliveredAt" IS NULL AND "entityId" = ANY(${ids}::text[])`
  return new Set(rows.map((row) => row.entityId))
}

/** The copied rows to deliver again: gone at home, or holding other contents, unless a delivery already carries them. */
function stale(rows: Row[], home: Row[], pending: Set<string>, fields: readonly string[], result: Reconciliation, extra?: (copied: Row, atHome: Row) => boolean): Row[] {
  const byId = new Map(home.map((row) => [row.id, row]))
  return rows.filter((copied) => {
    if (pending.has(copied.id)) return false
    const atHome = byId.get(copied.id)
    if (!atHome) return true
    const drifted = fields.some((field) => !sameDelivered(copied[field], atHome[field])) || (extra?.(copied, atHome) ?? false)
    if (drifted) result.drifted++
    return drifted
  })
}

export async function reconcileRegionCopy(region: CloudRegionId): Promise<Reconciliation> {
  const copy = regionRawClient(region)
  const result: Reconciliation = { checked: 0, queued: 0, drifted: 0 }

  // Projects: present at home, in this region, and as home has them.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<Row[]>`
      SELECT "id", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId"
        FROM public.auth_projection_projects WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    const home = await prisma.$queryRaw<Row[]>`
      SELECT "id", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId"
        FROM "projects" WHERE "id" = ANY(${ids}::text[]) AND "region" = ${region}`
    const pending = await inFlight(region, 'project', ids)
    const queue_ = stale(rows, home, pending, PROJECT_FIELDS, result, (copied, atHome) => secretValue(copied.jwtSecret) !== secretValue(atHome.jwtSecret))
    result.queued += await queue(region, queue_.map((row) => ({ entity: 'project', projectId: row.id, entityId: row.id })))
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  // Keys: present at home, in a project of this region, still copied, and as home has them.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<Row[]>`
      SELECT "id", "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions", "capabilities",
             "expiresAt", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "branchId"
        FROM public.auth_projection_keys WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    // As delivery reads them (deliver.ts, currentState): a list a key was created without is an empty list.
    const home = await prisma.$queryRaw<Row[]>`
      SELECT k."id", k."projectId", k."keyHash", k."name", k."keyPrefix", k."userId", k."role",
             COALESCE(k."permissions", '{}'::text[]) AS "permissions", COALESCE(k."capabilities", '{}'::text[]) AS "capabilities",
             k."expiresAt", k."rateLimit", k."rateLimitWindow", k."scope", k."keyType", k."serviceRole", k."branchId"
        FROM "api_keys" k JOIN "projects" p ON p."id" = k."projectId"
       WHERE k."id" = ANY(${ids}::text[]) AND p."region" = ${region}
         AND k."scope" = 'runtime' AND k."serviceRole" = false AND k."keyType" = 'public'`
    const queue_ = stale(rows, home, await inFlight(region, 'api_key', ids), KEY_FIELDS, result)
    result.queued += await queue(
      region,
      queue_.map((row) => ({ entity: 'api_key', projectId: String(row.projectId), entityId: row.id })),
    )
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  // Branches: present at home, in a project of this region, and as home has them.
  for (let after = ''; ; ) {
    const rows = await copy.$queryRaw<Row[]>`
      SELECT "id", "projectId", "name", "status", "schemaName"
        FROM public.auth_projection_branches WHERE "id" > ${after} ORDER BY "id" LIMIT ${PAGE}`
    if (rows.length === 0) break
    const ids = rows.map((row) => row.id)
    const home = await prisma.$queryRaw<Row[]>`
      SELECT b."id", b."projectId", b."name", b."status", b."schemaName"
        FROM "workspace_branches" b JOIN "projects" p ON p."id" = b."projectId"
       WHERE b."id" = ANY(${ids}::text[]) AND p."region" = ${region}`
    const queue_ = stale(rows, home, await inFlight(region, 'branch', ids), BRANCH_FIELDS, result)
    result.queued += await queue(
      region,
      queue_.map((row) => ({ entity: 'branch', projectId: String(row.projectId), entityId: row.id })),
    )
    result.checked += ids.length
    after = ids[ids.length - 1]
    if (rows.length < PAGE) break
  }

  if (result.queued > 0) {
    console.error(
      `[auth-projection] ${region}: the copy held ${result.queued - result.drifted} row(s) home no longer has or copies ` +
        `and ${result.drifted} whose contents differ from home's, so changes never reached it; they are queued for ` +
        'delivery again. Something removed their records before delivery.',
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
