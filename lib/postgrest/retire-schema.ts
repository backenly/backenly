/**
 * A SCHEMA POSTGREST SERVES IS DROPPED ONLY AFTER POSTGREST HAS STOPPED READING IT
 * ===============================================================================
 * PostgREST builds its schema cache from the schemas the registry lists. A
 * rebuild reads the list (postgrest.pre_config) and then queries the catalog
 * for those schemas, casting their names to regnamespace, and a name that no
 * longer exists fails the whole load: CHANGELOG 13.0.0, #3644. PostgREST 14.15,
 * what Backenly runs, then clears its cache and answers every request with 503
 * PGRST002 until a retry a second later succeeds (src/PostgREST/AppState.hs,
 * retryingSchemaCacheLoad; src/PostgREST/App.hs, postgrestResponse).
 *
 * Unregistering a schema and dropping it a moment later leaves exactly that
 * window: a rebuild that read the list before the unregister reached it, and
 * queries after the drop, fails. A merge drops its branch's schema as it ends,
 * and a merge on production answered 503 "The data plane is temporarily
 * unavailable." for about 1.2 s (QA, 2026-11-16).
 *
 * So a schema PostgREST serves leaves in two steps. It stops being served now:
 * unregistered, in the caller's transaction, which tells PostgREST to read its
 * list again. And it is dropped no sooner than DROP_AFTER_MS later, by the pass
 * every region's scheduler runs each minute (dropRetiredSchemas), from a
 * platform row recorded with the change that retired it. A schema PostgREST
 * does not serve (a change vault, a paused project's, or any schema where no
 * registry is installed) is dropped at once, as before.
 *
 * The row uses statuses of its own, for the reason purge jobs do
 * (lib/queue/index.ts, PURGE_STATUS): a released worker completes a 'queued'
 * job it has no handler for, and this row is the only record that a schema
 * still has to go.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { regionRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { isProjectOwnedSchema, quoteIdent } from '@/lib/security/workspace-schema'
import { servedAmong, unregisterSchemaOn, type RegistrySql } from './registration'

export const RETIRED_SCHEMAS_JOB_TYPE = 'drop_retired_schemas' as const

export const RETIRED_SCHEMAS_STATUS = {
  /** Waiting for its time. Invisible to every released query, as a purge's is. */
  pending: 'schema_drop_pending',
  /** Claimed by a pass that understands it. */
  running: 'schema_drop_running',
  /** Retries exhausted. Terminal and never pruned: the schema is still there. */
  failed: 'schema_drop_failed',
} as const

/**
 * How long a retired schema stays before it is dropped: far longer than one
 * rebuild of the cache and the debounce before it, so any rebuild that read
 * the old list has finished.
 */
export const DROP_AFTER_MS = 2 * 60_000

/** How long a drop waits for a table lock before it gives up and tries later. */
const LOCK_TIMEOUT = '5s'
/** Backoff between failed attempts, as the job queue's. */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000, 1_800_000] as const
const RUNNING_TIMEOUT_MS = 10 * 60_000

/** Raw SQL on the database the schemas are in: a client, or a transaction on it. */
export interface SchemaSql extends RegistrySql {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

/**
 * The schema-drop step. Drops each of `schemas` PostgREST does not serve, now,
 * and stops serving the others now, returning them: record them with
 * scheduleSchemaDrop in the same platform change, and dropRetiredSchemas drops
 * them later.
 */
export async function dropOrRetireSchemas(
  db: SchemaSql,
  schemas: string[],
): Promise<{ dropped: string[]; retired: string[] }> {
  const served = new Set(await servedAmong(db, schemas))
  const dropped: string[] = []
  const retired: string[] = []
  for (const schema of schemas) {
    if (served.has(schema)) {
      await unregisterSchemaOn(db, schema)
      retired.push(schema)
    } else {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      dropped.push(schema)
    }
  }
  return { dropped, retired }
}

/**
 * Record that these schemas of a project, retired by dropOrRetireSchemas in its
 * region, are to be dropped DROP_AFTER_MS from now. Pass the transaction that
 * retired them when it is the platform's own, so the record commits with it.
 */
export async function scheduleSchemaDrop(
  platform: Pick<Prisma.TransactionClient, 'backgroundJob'>,
  entry: { projectId: string; region: CloudRegionId; schemas: string[] },
  now: Date = new Date(),
): Promise<void> {
  const schemas = entry.schemas.filter((schema) => isProjectOwnedSchema(entry.projectId, schema))
  if (schemas.length === 0) return
  await platform.backgroundJob.create({
    data: {
      type: RETIRED_SCHEMAS_JOB_TYPE,
      status: RETIRED_SCHEMAS_STATUS.pending,
      // The project's id, its region and the schema names: no rows, no credentials.
      payload: { projectId: entry.projectId, region: entry.region, schemas },
      attempts: 0,
      maxAttempts: RETRY_DELAYS_MS.length,
      runAt: new Date(now.getTime() + DROP_AFTER_MS),
      // Null as a purge's is: the project may already be gone.
      projectId: null,
    },
  })
}

/**
 * Drop this region's schemas retired at least DROP_AFTER_MS ago.
 *
 * Each named schema must belong to the project the row names, or nothing is
 * dropped. A schema served again since (re-registered) is retired again and
 * kept for another DROP_AFTER_MS, never dropped while it may be read.
 */
export async function dropRetiredSchemas(
  region: CloudRegionId = serviceRegion(),
  now: Date = new Date(),
): Promise<{ dropped: string[]; deferred: string[]; failed: number }> {
  const out = { dropped: [] as string[], deferred: [] as string[], failed: 0 }

  // A pass that died mid-drop left its rows running; they go back to waiting.
  await prisma.backgroundJob.updateMany({
    where: { type: RETIRED_SCHEMAS_JOB_TYPE, status: RETIRED_SCHEMAS_STATUS.running, timeoutAt: { lte: now } },
    data: { status: RETIRED_SCHEMAS_STATUS.pending, startedAt: null, timeoutAt: null },
  })

  // Only this region's rows: each region's database holds its own schemas.
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "background_jobs"
    WHERE "type" = ${RETIRED_SCHEMAS_JOB_TYPE}
      AND "status" = ${RETIRED_SCHEMAS_STATUS.pending}
      AND "runAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      AND COALESCE("payload"->>'region', ${HOME_REGION}) = ${region}
    ORDER BY "runAt" ASC
    LIMIT 10`
  if (due.length === 0) return out

  const ids = due.map((d) => d.id)
  await prisma.backgroundJob.updateMany({
    where: { id: { in: ids }, status: RETIRED_SCHEMAS_STATUS.pending },
    data: { status: RETIRED_SCHEMAS_STATUS.running, startedAt: now, timeoutAt: new Date(now.getTime() + RUNNING_TIMEOUT_MS) },
  })
  const jobs = await prisma.backgroundJob.findMany({ where: { id: { in: ids }, status: RETIRED_SCHEMAS_STATUS.running } })

  for (const job of jobs) {
    const payload = (job.payload ?? {}) as { projectId?: unknown; schemas?: unknown }
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
    const named = Array.isArray(payload.schemas) ? payload.schemas.filter((s): s is string => typeof s === 'string') : []
    let owned: string[] = []
    try {
      owned = named.filter((schema) => isProjectOwnedSchema(projectId, schema))
    } catch {
      owned = []
    }
    if (owned.length === 0 || owned.length !== named.length) {
      // Unrecoverable: no retry finds an owner the row never named. Kept, failed, for a person.
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: RETIRED_SCHEMAS_STATUS.failed, error: 'The row names a schema that is not this project\'s, so nothing was dropped.', completedAt: now, timeoutAt: null },
      })
      out.failed++
      continue
    }

    try {
      const db = regionRawClient(region, projectId)
      const servedAgain = await servedAmong(db, owned)
      for (const schema of servedAgain) await unregisterSchemaOn(db, schema)
      for (const schema of owned.filter((s) => !servedAgain.includes(s))) {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
          await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
        })
        out.dropped.push(schema)
      }
      if (servedAgain.length > 0) {
        out.deferred.push(...servedAgain)
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: {
            status: RETIRED_SCHEMAS_STATUS.pending,
            payload: { ...(payload as Record<string, unknown>), schemas: servedAgain },
            runAt: new Date(now.getTime() + DROP_AFTER_MS),
            startedAt: null,
            timeoutAt: null,
          },
        })
      } else {
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: { status: 'completed', result: { dropped: owned }, completedAt: now, error: null, timeoutAt: null },
        })
      }
    } catch (err) {
      out.failed++
      const attempts = job.attempts + 1
      const error = String(err instanceof Error ? err.message : err).slice(0, 500)
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data:
          attempts >= job.maxAttempts
            ? { status: RETIRED_SCHEMAS_STATUS.failed, attempts, error, completedAt: now, timeoutAt: null }
            : {
                status: RETIRED_SCHEMAS_STATUS.pending,
                attempts,
                error,
                runAt: new Date(now.getTime() + (RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])),
                startedAt: null,
                timeoutAt: null,
              },
      })
    }
  }

  if (out.dropped.length > 0 || out.failed > 0) {
    console.log(`[RetiredSchemas] region=${region} dropped=${out.dropped.length} deferred=${out.deferred.length} failed=${out.failed}`)
  }
  return out
}
