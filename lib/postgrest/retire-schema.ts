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
 * A deleted project's logins cannot be dropped while its schema is there
 * (lib/projects/logins.ts). The deletion retires them, unable to log in, and
 * names them on the row; the pass drops them right after the schemas, and
 * records any that something outside the database still names, which it
 * retires instead, as a deletion does.
 *
 * The row uses statuses of its own, for the reason purge jobs do
 * (lib/queue/index.ts, PURGE_STATUS): a released worker completes a 'queued'
 * job it has no handler for, and this row is the only record that a schema
 * still has to go.
 *
 * A project with a database of its own keeps its schemas there, a branch's
 * included: the row then names that database too (`database`), and the pass
 * drops the schema in it, on its region's data instance. A database already
 * gone, its project purged meanwhile, took the schema with it.
 */

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { databaseClient, isProjectDatabaseName, regionRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { isProjectOwnedSchema, quoteIdent } from '@/lib/security/workspace-schema'
import { dropLogins, projectLoginNames, recordRetiredLogins } from '@/lib/projects/logins'
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
/** Bounds the transaction that drops a deleted project's logins, as a deletion's own are bounded. */
const LOGINS_TRANSACTION = { timeout: 60_000, maxWait: 10_000 }
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
 *
 * `retire: false` drops a served schema now too, right after it stops being
 * served: for a deletion whose logins cannot wait for the pass
 * (lib/projects/delete.ts).
 */
export async function dropOrRetireSchemas(
  db: SchemaSql,
  schemas: string[],
  opts: { retire?: boolean } = {},
): Promise<{ dropped: string[]; retired: string[] }> {
  const served = new Set(await servedAmong(db, schemas))
  const dropped: string[] = []
  const retired: string[] = []
  for (const schema of schemas) {
    if (served.has(schema)) {
      await unregisterSchemaOn(db, schema)
      if (opts.retire !== false) {
        retired.push(schema)
        continue
      }
    }
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
    dropped.push(schema)
  }
  return { dropped, retired }
}

/**
 * Record that these schemas of a project, retired by dropOrRetireSchemas in its
 * region, are to be dropped DROP_AFTER_MS from now, and with them the logins a
 * deletion retired (`logins`, and `via`, what retired them, for the record of
 * any the pass cannot drop). Pass the transaction that retired them when it is
 * the platform's own, so the record commits with it. `database` names the
 * project's own database when the schemas are in it; omitted or null, they are
 * in the region's own database. `afterMs`, when given, is how long they wait
 * instead of DROP_AFTER_MS: what a move to a database of its own leaves behind
 * is kept for days (lib/data-plane/tenancy-migration.ts), never less than
 * DROP_AFTER_MS.
 */
export async function scheduleSchemaDrop(
  platform: Pick<Prisma.TransactionClient, 'backgroundJob'>,
  entry: {
    projectId: string
    region: CloudRegionId
    schemas: string[]
    logins?: string[]
    via?: string
    database?: string | null
    afterMs?: number
  },
  now: Date = new Date(),
): Promise<void> {
  const schemas = entry.schemas.filter((schema) => isProjectOwnedSchema(entry.projectId, schema))
  if (schemas.length === 0) return
  const logins = entry.logins ?? []
  if (entry.database !== undefined && entry.database !== null && !isProjectDatabaseName(entry.database)) {
    throw new Error(`Refusing to schedule a drop in "${String(entry.database).slice(0, 80)}": not a project database name.`)
  }
  await platform.backgroundJob.create({
    data: {
      type: RETIRED_SCHEMAS_JOB_TYPE,
      status: RETIRED_SCHEMAS_STATUS.pending,
      // The project's id, its region, the schema names and its logins' names,
      // and its own database's name when it has one: no rows, no credentials.
      payload: {
        projectId: entry.projectId,
        region: entry.region,
        schemas,
        ...(entry.database ? { database: entry.database } : {}),
        ...(logins.length > 0 ? { logins, via: entry.via ?? 'project deletion' } : {}),
      },
      attempts: 0,
      maxAttempts: RETRY_DELAYS_MS.length,
      runAt: new Date(now.getTime() + Math.max(DROP_AFTER_MS, entry.afterMs ?? DROP_AFTER_MS)),
      // Null as a purge's is: the project may already be gone.
      projectId: null,
    },
  })
}

/** Whether a project's own database is still on its region's data instance. */
async function projectDatabaseStillThere(region: CloudRegionId, database: string): Promise<boolean> {
  const { projectDatabaseExists } = await import('@/lib/data-plane/project-databases')
  return projectDatabaseExists(region, database)
}

/**
 * The logins a row names, if each is one of its project's own
 * (lib/projects/logins.ts, projectLoginNames); null if any is not.
 */
function loginsOf(payload: { logins?: unknown }, projectId: string, schemas: string[]): string[] | null {
  const named = Array.isArray(payload.logins) ? payload.logins.filter((l): l is string => typeof l === 'string') : []
  if (Array.isArray(payload.logins) && named.length !== payload.logins.length) return null
  if (named.length === 0) return []
  let own: Set<string>
  try {
    own = new Set(projectLoginNames(projectId, [], schemas))
  } catch {
    return null
  }
  return named.every((login) => own.has(login)) ? named : null
}

/**
 * Drop this region's schemas retired at least DROP_AFTER_MS ago, and then the
 * logins retired with them.
 *
 * Each named schema and login must belong to the project the row names, or
 * nothing is dropped. A schema served again since (re-registered) is retired
 * again and kept for another DROP_AFTER_MS, never dropped while it may be read,
 * and the logins wait with it. A login something outside the database still
 * names is retired, not dropped, and recorded as a deletion records one.
 */
export async function dropRetiredSchemas(
  region: CloudRegionId = serviceRegion(),
  now: Date = new Date(),
): Promise<{ dropped: string[]; deferred: string[]; failed: number; loginsDropped: string[]; loginsRetired: string[] }> {
  const out = {
    dropped: [] as string[],
    deferred: [] as string[],
    failed: 0,
    loginsDropped: [] as string[],
    loginsRetired: [] as string[],
  }

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
    const payload = (job.payload ?? {}) as { projectId?: unknown; schemas?: unknown; logins?: unknown; via?: unknown; database?: unknown }
    const projectId = typeof payload.projectId === 'string' ? payload.projectId : ''
    // A project's own database, when the row names one; anything else it names is no database of a project.
    const database = payload.database === undefined ? null : isProjectDatabaseName(payload.database) ? payload.database : undefined
    const named = Array.isArray(payload.schemas) ? payload.schemas.filter((s): s is string => typeof s === 'string') : []
    let owned: string[] = []
    try {
      owned = named.filter((schema) => isProjectOwnedSchema(projectId, schema))
    } catch {
      owned = []
    }
    const logins = owned.length === named.length ? loginsOf(payload, projectId, owned) : null
    if (owned.length === 0 || owned.length !== named.length || logins === null || database === undefined) {
      // Unrecoverable: no retry finds an owner the row never named. Kept, failed, for a person.
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: { status: RETIRED_SCHEMAS_STATUS.failed, error: 'The row names a schema, a login or a database that is not this project\'s, so nothing was dropped.', completedAt: now, timeoutAt: null },
      })
      out.failed++
      continue
    }

    try {
      if (database !== null && !(await projectDatabaseStillThere(region, database))) {
        // Dropped with its project since: the schemas went with it.
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: { status: 'completed', result: { dropped: [], databaseGone: database }, completedAt: now, error: null, timeoutAt: null },
        })
        continue
      }
      const db = database === null ? regionRawClient(region, projectId) : databaseClient(region, database, projectId)
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
        // The schemas are gone, so the logins hold no grants that would block
        // their drop. A retry after a failure here finds the schemas gone.
        const retiredLogins = logins.length === 0 ? [] : await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
          return dropLogins(tx as Prisma.TransactionClient, logins)
        }, LOGINS_TRANSACTION)
        if (retiredLogins.length > 0) {
          const via = typeof payload.via === 'string' ? payload.via : 'project deletion'
          await recordRetiredLogins(prisma, [{ projectId, region, logins: retiredLogins }], via)
          console.warn(
            `[LoginRetired] project=${projectId} region=${region} logins=${retiredLogins.join(',')} via=${via}: ` +
              'something outside the project database still names them; they cannot log in, and stay until an operator ' +
              'removes what names them and drops them (audit DATABASE_LOGIN_RETIRED)',
          )
        }
        const droppedLogins = logins.filter((login) => !retiredLogins.includes(login))
        out.loginsDropped.push(...droppedLogins)
        out.loginsRetired.push(...retiredLogins)
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            result: { dropped: owned, ...(logins.length > 0 ? { logins: { dropped: droppedLogins, retired: retiredLogins } } : {}) },
            completedAt: now,
            error: null,
            timeoutAt: null,
          },
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
    console.log(
      `[RetiredSchemas] region=${region} dropped=${out.dropped.length} deferred=${out.deferred.length} failed=${out.failed} ` +
        `logins dropped=${out.loginsDropped.length} retired=${out.loginsRetired.length}`,
    )
  }
  return out
}
