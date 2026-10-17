/**
 * DELIVERING EACH REGION ITS COPY OF WHAT AUTHORIZES ITS REQUESTS
 * ===============================================================
 * A request to a project kept outside the home region is authorized from rows
 * in the home platform database: the project's lock, pause and end-user signing
 * secret, its publishable keys, and the branches they are bound to. Each such
 * request crosses to Mumbai for them. Option C (founders, 2026-10-16) gives each
 * region a copy of those rows for its own projects instead, and bounds how
 * stale a copy may be before it is not trusted:
 *
 *   capture    triggers on projects, api_keys and workspace_branches record
 *              which of a regional project's rows changed, in the same
 *              transaction as the change (migration 20261017120000_auth_projection)
 *   delivery   this module, every AUTH_PROJECTION_DELIVERY_SECONDS in the home
 *              region: the current state of every changed row, or its removal
 *              when it is gone or no longer copied, applied in the region's
 *              database in one transaction (scripts/sql/auth-projection.sql)
 *   watermark  applied in the same transaction: every change committed at home
 *              before it is in the copy. A delivery that leaves nothing
 *              pending moves it, even when there was nothing to deliver, so a
 *              delivery is also the heartbeat
 *   fence      each copied row keeps the change it was delivered at, and an
 *              older delivery never overwrites a newer one
 *   epoch      the region keeps the epoch and round of the last delivery it
 *              applied, as home does. When they differ, one side was restored,
 *              or a delivery committed in the region but not here: the copy is
 *              emptied and delivered afresh. Until then its watermark is the
 *              old one, which no reader trusts
 *
 * The state is read in a REPEATABLE READ snapshot taken after the transaction
 * began, and the watermark is that transaction's start: every change committed
 * before it is in the snapshot, so once none is left pending the copy holds all
 * of them. A change committed later is delivered next time.
 *
 * Only publishable keys are copied. A service-role key, an MCP key or a
 * dashboard key is never in a region's copy, so it is always authorized at home:
 * the founders' sensitive path. A row missing from a copy is not evidence of
 * anything; a reader asks home.
 *
 * Nothing reads the copy yet: BACKENLY_AUTH_PROJECTION (lib/auth-projection/mode.ts).
 */

import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { regionDatabaseUrl, regionRawClient, type WorkspaceRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { CLOUD_REGIONS, HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'

type Entity = 'project' | 'api_key' | 'branch'
type Tx = Prisma.TransactionClient

/** Changes delivered per round; a region with more is delivered in several. */
const BATCH = 500
/** How long one run keeps delivering to a region before leaving the rest to the next. */
const REGION_BUDGET_MS = 4_000
const LOCK_PREFIX = 'auth-projection:'
const PRUNE_EVERY_MS = 60 * 60 * 1000
const REPORT_EVERY_MS = 5 * 60 * 1000

export type DeliveryOutcome = 'delivered' | 'resynced' | 'busy' | 'unavailable' | 'failed'

export interface RegionDelivery {
  region: CloudRegionId
  outcome: DeliveryOutcome
  /** Changed rows this run applied in the region. */
  applied: number
  /** The region's watermark after this run, or null when it has none or the run failed. */
  watermarkAt: Date | null
  error?: string
}

interface PendingChange {
  id: bigint
  entity: Entity
  entityId: string
  projectId: string
}

interface DeliveryState {
  region: string
  epoch: string
  round: bigint
  watermarkAt: Date | null
}

interface ProjectState {
  id: string
  lockedDownAt: Date | null
  lockedDownReason: string | null
  pausedAt: Date | null
  pauseReason: string | null
  jwtSecret: string | null
  userId: string | null
  organizationId: string | null
}

interface KeyState {
  id: string
  projectId: string
  keyHash: string
  name: string
  keyPrefix: string
  userId: string
  role: string
  permissions: string[]
  capabilities: string[]
  expiresAt: Date | null
  rateLimit: number
  rateLimitWindow: number
  scope: string
  keyType: string
  serviceRole: boolean
  branchId: string | null
}

interface BranchState {
  id: string
  projectId: string
  name: string
  status: string
  schemaName: string
}

type Versioned<T> = T & { version: string }

interface Delivery {
  projects: { upsert: Versioned<ProjectState>[]; remove: string[] }
  keys: { upsert: Versioned<KeyState>[]; remove: string[] }
  branches: { upsert: Versioned<BranchState>[]; remove: string[] }
}

/** The region's database holds another region's copy: its connection names the wrong database. */
export class MisdirectedCopyError extends Error {
  constructor(
    readonly region: CloudRegionId,
    readonly holds: string,
  ) {
    super(`The database this process reaches as ${region} keeps the copy for ${holds}; nothing was delivered to it.`)
    this.name = 'MisdirectedCopyError'
  }
}

/** The region's delivery state changed under this delivery, which was not applied. */
class CopyMovedError extends Error {
  constructor(readonly region: CloudRegionId) {
    super(`The copy in ${region} changed during the delivery, which was not applied; it is checked again next time.`)
    this.name = 'CopyMovedError'
  }
}

/** Every region other than home that this process has a database connection for. */
export function deliveryRegions(env: Readonly<Record<string, string | undefined>> = process.env): CloudRegionId[] {
  return CLOUD_REGIONS.map((region) => region.id).filter(
    (id) => id !== HOME_REGION && regionDatabaseUrl(id, 'app', env) !== undefined,
  )
}

let delivering = false
let lastPruneAt = 0

/**
 * Deliver each region its pending changes and a new watermark. Run by the home
 * region's scheduler (instrumentation.ts). A run still going when the next one
 * is due makes the next one a no-op rather than a second delivery beside it;
 * other home processes are kept out per region by an advisory lock.
 */
export async function deliverAuthProjection(options: { regions?: CloudRegionId[] } = {}): Promise<RegionDelivery[]> {
  if (!isHome() || delivering) return []
  delivering = true
  try {
    const regions = options.regions ?? deliveryRegions()
    const results = await Promise.all(regions.map((region) => deliverRegion(region)))
    results.forEach(report)
    if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
      lastPruneAt = Date.now()
      await pruneDeliveredChanges().catch((err) => console.error('[auth-projection] pruning delivered changes failed:', describe(err)))
    }
    return results
  } finally {
    delivering = false
  }
}

function isHome(): boolean {
  try {
    return serviceRegion() === HOME_REGION
  } catch {
    return false
  }
}

/**
 * Deliver one region what is pending for it, in rounds of BATCH changes, until
 * nothing is left or REGION_BUDGET_MS has passed. A copy found out of step is
 * emptied and delivered afresh first.
 */
export async function deliverRegion(
  region: CloudRegionId,
  { budgetMs = REGION_BUDGET_MS, batch = BATCH }: { budgetMs?: number; batch?: number } = {},
): Promise<RegionDelivery> {
  if (region === HOME_REGION) throw new Error('The home region authorizes from the platform database; it keeps no copy.')
  const started = Date.now()
  let applied = 0
  let resynced = false
  for (;;) {
    let round: Round
    try {
      round = await deliveryRound(region, batch)
    } catch (err) {
      const error = describe(err)
      await recordFailure(region, error).catch(() => {})
      return { region, outcome: isMissingCopy(err) ? 'unavailable' : 'failed', applied, watermarkAt: null, error }
    }
    if (round.kind === 'busy') return { region, outcome: 'busy', applied, watermarkAt: null }
    if (round.kind === 'resynced') {
      // Once per run: a copy out of step straight after it was delivered
      // afresh means something else is delivering to it, and that is reported.
      if (resynced) {
        const error = `The copy in ${region} went out of step again straight after it was delivered afresh.`
        await recordFailure(region, error).catch(() => {})
        return { region, outcome: 'failed', applied, watermarkAt: null, error }
      }
      resynced = true
      continue
    }
    applied += round.applied
    if (round.drained || Date.now() - started >= budgetMs) {
      return { region, outcome: resynced ? 'resynced' : 'delivered', applied, watermarkAt: round.watermarkAt }
    }
  }
}

type Round =
  | { kind: 'busy' }
  | { kind: 'resynced' }
  | { kind: 'delivered'; applied: number; drained: boolean; watermarkAt: Date | null }

async function deliveryRound(region: CloudRegionId, batch: number): Promise<Round> {
  const copy = regionRawClient(region)
  return prisma.$transaction(
    async (tx) => {
      // The snapshot is taken here, after the transaction began: every change
      // committed before startedAt is visible from now on.
      const [{ locked, startedAt }] = await tx.$queryRaw<{ locked: boolean; startedAt: Date }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${LOCK_PREFIX + region}, 0)) AS "locked",
               now() AS "startedAt"`
      if (!locked) return { kind: 'busy' } as const

      const [home] = await tx.$queryRaw<DeliveryState[]>`
        SELECT "region", "epoch", "round", "watermarkAt" FROM "auth_projection_regions" WHERE "region" = ${region}`
      const states = await copy.$queryRaw<DeliveryState[]>`
        SELECT "region", "epoch", "round", "watermarkAt" FROM public.auth_projection_state`
      const misdirected = states.find((state) => state.region !== region)
      if (misdirected) throw new MisdirectedCopyError(region, misdirected.region)
      const there = states[0]

      if (!home || !there || home.epoch !== there.epoch || BigInt(home.round) !== BigInt(there.round)) {
        await resync(tx, copy, region)
        return { kind: 'resynced' } as const
      }

      const pending = await tx.$queryRaw<PendingChange[]>`
        SELECT "id", "entity", "entityId", "projectId" FROM "auth_projection_changes"
         WHERE "region" = ${region} AND "deliveredAt" IS NULL
         ORDER BY "id"
         LIMIT ${batch + 1}`
      const drained = pending.length <= batch
      const changes = pending.slice(0, batch)
      const delivery = await currentState(tx, region, changes)
      const watermarkAt = drained ? startedAt : null
      const watermark = watermarkAt ? watermarkAt.toISOString() : null

      await copy.$transaction(
        async (rtx) => {
          await apply(rtx, delivery)
          const moved = await rtx.$executeRaw`
            UPDATE public.auth_projection_state
               SET "round" = "round" + 1,
                   "watermarkAt" = COALESCE(${watermark}::timestamptz, "watermarkAt"),
                   "deliveredAt" = now()
             WHERE "region" = ${region} AND "epoch" = ${home.epoch} AND "round" = ${home.round}`
          if (moved !== 1) throw new CopyMovedError(region)
        },
        { maxWait: 5_000, timeout: 10_000 },
      )

      if (changes.length > 0) {
        await tx.$executeRaw`
          UPDATE "auth_projection_changes" SET "deliveredAt" = (now() AT TIME ZONE 'UTC')
           WHERE "id" = ANY(${changes.map((change) => change.id.toString())}::bigint[])`
      }
      await tx.$executeRaw`
        UPDATE "auth_projection_regions"
           SET "round" = "round" + 1,
               "watermarkAt" = COALESCE((${watermark}::timestamptz AT TIME ZONE 'UTC'), "watermarkAt"),
               "deliveredAt" = (now() AT TIME ZONE 'UTC'),
               "lastError" = NULL,
               "lastErrorAt" = NULL
         WHERE "region" = ${region}`
      return { kind: 'delivered', applied: changes.length, drained, watermarkAt: watermarkAt ?? there.watermarkAt } as const
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 20_000 },
  )
}

/**
 * Empty the region's copy and queue every row it may hold, under a new epoch.
 * The region goes first: its copy is empty and has no watermark, so nothing
 * trusts it until the deliveries that follow have applied every row. Should
 * this transaction then fail, the two epochs differ and the next run does this
 * again.
 */
async function resync(tx: Tx, copy: WorkspaceRawClient, region: CloudRegionId): Promise<void> {
  const epoch = randomUUID()
  await copy.$transaction(
    async (rtx) => {
      await rtx.$executeRaw`DELETE FROM public.auth_projection_keys`
      await rtx.$executeRaw`DELETE FROM public.auth_projection_branches`
      await rtx.$executeRaw`DELETE FROM public.auth_projection_projects`
      await rtx.$executeRaw`
        INSERT INTO public.auth_projection_state ("region", "epoch", "round", "watermarkAt", "deliveredAt", "resyncedAt")
        VALUES (${region}, ${epoch}, 0, NULL, now(), now())
        ON CONFLICT ("region") DO UPDATE
           SET "epoch" = EXCLUDED."epoch", "round" = 0, "watermarkAt" = NULL,
               "deliveredAt" = EXCLUDED."deliveredAt", "resyncedAt" = EXCLUDED."resyncedAt"`
    },
    { maxWait: 5_000, timeout: 10_000 },
  )
  await tx.$executeRaw`
    INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId")
    SELECT p."region", p."id", 'project', p."id"
      FROM "projects" p
     WHERE p."region" = ${region}
    UNION ALL
    SELECT p."region", k."projectId", 'api_key', k."id"
      FROM "api_keys" k JOIN "projects" p ON p."id" = k."projectId"
     WHERE p."region" = ${region}
       AND k."scope" = 'runtime' AND k."serviceRole" = false AND k."keyType" = 'public'
    UNION ALL
    SELECT p."region", b."projectId", 'branch', b."id"
      FROM "workspace_branches" b JOIN "projects" p ON p."id" = b."projectId"
     WHERE p."region" = ${region}`
  await tx.$executeRaw`
    INSERT INTO "auth_projection_regions" ("region", "epoch", "round", "watermarkAt", "deliveredAt", "resyncedAt", "lastError", "lastErrorAt")
    VALUES (${region}, ${epoch}, 0, NULL, NULL, (now() AT TIME ZONE 'UTC'), NULL, NULL)
    ON CONFLICT ("region") DO UPDATE
       SET "epoch" = EXCLUDED."epoch", "round" = 0, "watermarkAt" = NULL, "resyncedAt" = EXCLUDED."resyncedAt"`
}

/**
 * The state each changed row has now, in this transaction's snapshot, at the
 * newest of its changes: the row as the copy keeps it, or its removal when it
 * is gone, belongs to a project in another region, or is a key that is not
 * copied.
 */
async function currentState(tx: Tx, region: CloudRegionId, changes: PendingChange[]): Promise<Delivery> {
  const newest = new Map<string, bigint>()
  for (const change of changes) {
    const key = `${change.entity}:${change.entityId}`
    const seen = newest.get(key)
    if (seen === undefined || change.id > seen) newest.set(key, change.id)
  }
  const idsOf = (entity: Entity) =>
    [...newest.keys()].filter((key) => key.startsWith(`${entity}:`)).map((key) => key.slice(entity.length + 1))
  const versionOf = (entity: Entity, id: string) => (newest.get(`${entity}:${id}`) as bigint).toString()

  const projectIds = idsOf('project')
  const keyIds = idsOf('api_key')
  const branchIds = idsOf('branch')

  const projects =
    projectIds.length === 0
      ? []
      : await tx.$queryRaw<ProjectState[]>`
          SELECT "id", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId"
            FROM "projects"
           WHERE "id" = ANY(${projectIds}::text[]) AND "region" = ${region}`
  const keys =
    keyIds.length === 0
      ? []
      : await tx.$queryRaw<KeyState[]>`
          SELECT k."id", k."projectId", k."keyHash", k."name", k."keyPrefix", k."userId", k."role",
                 k."permissions", k."capabilities", k."expiresAt", k."rateLimit", k."rateLimitWindow",
                 k."scope", k."keyType", k."serviceRole", k."branchId"
            FROM "api_keys" k JOIN "projects" p ON p."id" = k."projectId"
           WHERE k."id" = ANY(${keyIds}::text[]) AND p."region" = ${region}
             AND k."scope" = 'runtime' AND k."serviceRole" = false AND k."keyType" = 'public'`
  const branches =
    branchIds.length === 0
      ? []
      : await tx.$queryRaw<BranchState[]>`
          SELECT b."id", b."projectId", b."name", b."status", b."schemaName"
            FROM "workspace_branches" b JOIN "projects" p ON p."id" = b."projectId"
           WHERE b."id" = ANY(${branchIds}::text[]) AND p."region" = ${region}`

  const found = (rows: { id: string }[]) => new Set(rows.map((row) => row.id))
  const foundProjects = found(projects)
  const foundKeys = found(keys)
  const foundBranches = found(branches)
  return {
    projects: {
      upsert: projects.map((project) => ({
        ...project,
        jwtSecret: sealedSecret(project),
        version: versionOf('project', project.id),
      })),
      remove: projectIds.filter((id) => !foundProjects.has(id)),
    },
    keys: {
      upsert: keys.map((key) => ({ ...key, version: versionOf('api_key', key.id) })),
      remove: keyIds.filter((id) => !foundKeys.has(id)),
    },
    branches: {
      upsert: branches.map((branch) => ({ ...branch, version: versionOf('branch', branch.id) })),
      remove: branchIds.filter((id) => !foundBranches.has(id)),
    },
  }
}

/**
 * The signing secret as the copy keeps it: encrypted under the active key,
 * whatever form it is stored in here. One that cannot be read is copied as
 * none, which refuses every token in the region, as the unreadable secret
 * does at home.
 */
function sealedSecret(project: ProjectState): string | null {
  if (!project.jwtSecret) return null
  try {
    return JWTSecretManager.atRest(project.jwtSecret)
  } catch (err) {
    console.error(`[auth-projection] the signing secret of project ${project.id} could not be read, so none is copied:`, describe(err))
    return null
  }
}

/** Apply a delivery in the region: removals first, so an id freed at home is free there before anything takes it. */
async function apply(rtx: Tx, delivery: Delivery): Promise<void> {
  const { projects, keys, branches } = delivery
  if (projects.remove.length > 0) {
    // A project leaves with its keys and branches: when it is deleted, theirs
    // go in the same statement at home, before their own triggers could name
    // its region.
    await rtx.$executeRaw`DELETE FROM public.auth_projection_keys WHERE "projectId" = ANY(${projects.remove}::text[])`
    await rtx.$executeRaw`DELETE FROM public.auth_projection_branches WHERE "projectId" = ANY(${projects.remove}::text[])`
    await rtx.$executeRaw`DELETE FROM public.auth_projection_projects WHERE "id" = ANY(${projects.remove}::text[])`
  }
  if (keys.remove.length > 0) {
    await rtx.$executeRaw`DELETE FROM public.auth_projection_keys WHERE "id" = ANY(${keys.remove}::text[])`
  }
  if (branches.remove.length > 0) {
    await rtx.$executeRaw`DELETE FROM public.auth_projection_branches WHERE "id" = ANY(${branches.remove}::text[])`
  }
  if (projects.upsert.length > 0) {
    await rtx.$executeRaw`
      INSERT INTO public.auth_projection_projects AS t
             ("id", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId", "version")
      SELECT "id", "lockedDownAt", "lockedDownReason", "pausedAt", "pauseReason", "jwtSecret", "userId", "organizationId", "version"
        FROM jsonb_populate_recordset(NULL::public.auth_projection_projects, ${JSON.stringify(projects.upsert)}::jsonb)
      ON CONFLICT ("id") DO UPDATE
         SET "lockedDownAt" = EXCLUDED."lockedDownAt", "lockedDownReason" = EXCLUDED."lockedDownReason",
             "pausedAt" = EXCLUDED."pausedAt", "pauseReason" = EXCLUDED."pauseReason",
             "jwtSecret" = EXCLUDED."jwtSecret", "userId" = EXCLUDED."userId",
             "organizationId" = EXCLUDED."organizationId", "version" = EXCLUDED."version", "projectedAt" = now()
       WHERE t."version" < EXCLUDED."version"`
  }
  if (branches.upsert.length > 0) {
    await rtx.$executeRaw`
      INSERT INTO public.auth_projection_branches AS t ("id", "projectId", "name", "status", "schemaName", "version")
      SELECT "id", "projectId", "name", "status", "schemaName", "version"
        FROM jsonb_populate_recordset(NULL::public.auth_projection_branches, ${JSON.stringify(branches.upsert)}::jsonb)
      ON CONFLICT ("id") DO UPDATE
         SET "projectId" = EXCLUDED."projectId", "name" = EXCLUDED."name", "status" = EXCLUDED."status",
             "schemaName" = EXCLUDED."schemaName", "version" = EXCLUDED."version", "projectedAt" = now()
       WHERE t."version" < EXCLUDED."version"`
  }
  if (keys.upsert.length > 0) {
    await rtx.$executeRaw`
      INSERT INTO public.auth_projection_keys AS t
             ("id", "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions", "capabilities",
              "expiresAt", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "branchId", "version")
      SELECT "id", "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions", "capabilities",
             "expiresAt", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "branchId", "version"
        FROM jsonb_populate_recordset(NULL::public.auth_projection_keys, ${JSON.stringify(keys.upsert)}::jsonb)
      ON CONFLICT ("id") DO UPDATE
         SET "projectId" = EXCLUDED."projectId", "keyHash" = EXCLUDED."keyHash", "name" = EXCLUDED."name",
             "keyPrefix" = EXCLUDED."keyPrefix", "userId" = EXCLUDED."userId", "role" = EXCLUDED."role",
             "permissions" = EXCLUDED."permissions", "capabilities" = EXCLUDED."capabilities",
             "expiresAt" = EXCLUDED."expiresAt", "rateLimit" = EXCLUDED."rateLimit",
             "rateLimitWindow" = EXCLUDED."rateLimitWindow", "scope" = EXCLUDED."scope",
             "keyType" = EXCLUDED."keyType", "serviceRole" = EXCLUDED."serviceRole",
             "branchId" = EXCLUDED."branchId", "version" = EXCLUDED."version", "projectedAt" = now()
       WHERE t."version" < EXCLUDED."version"`
  }
}

async function recordFailure(region: CloudRegionId, error: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "auth_projection_regions"
       SET "lastError" = ${error}, "lastErrorAt" = (now() AT TIME ZONE 'UTC')
     WHERE "region" = ${region}`
}

/** Delivered changes are kept a day, for an operator tracing one; pending ones until delivered. */
export async function pruneDeliveredChanges(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "auth_projection_changes"
     WHERE "deliveredAt" < (now() AT TIME ZONE 'UTC') - interval '1 day'`
}

function isMissingCopy(err: unknown): boolean {
  return /relation "public\.auth_projection_\w+" does not exist|auth_projection_\w+" does not exist/.test(describe(err))
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500)
}

// One line per region per distinct problem every REPORT_EVERY_MS, and one when
// it clears, so a region that stays out of reach does not fill the log.
const lastReported = new Map<CloudRegionId, { error: string; at: number }>()

function report(result: RegionDelivery): void {
  const previous = lastReported.get(result.region)
  if (result.outcome === 'failed' || result.outcome === 'unavailable') {
    const error = result.error ?? 'unknown error'
    if (previous && previous.error === error && Date.now() - previous.at < REPORT_EVERY_MS) return
    lastReported.set(result.region, { error, at: Date.now() })
    const hint =
      result.outcome === 'unavailable'
        ? ' The region has no copy to deliver to: its database procedure has not run the auth-projection step.'
        : ''
    console.error(`[auth-projection] ${result.region}: not delivered, so its copy goes stale and its requests are authorized at home.${hint} ${error}`)
    return
  }
  if (previous && result.outcome !== 'busy') {
    lastReported.delete(result.region)
    console.log(`[auth-projection] ${result.region}: delivering again`)
  }
  if (result.outcome === 'resynced') {
    console.log(`[auth-projection] ${result.region}: the copy was out of step, so it was emptied and delivered afresh (${result.applied} rows)`)
  }
}
