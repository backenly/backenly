/**
 * Project and account deletion — the one place either is allowed to happen.
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
 *
 * `DELETE /api/projects/[id]` called `prisma.project.delete` and stopped.
 * `DELETE /api/auth/delete-account` called `project.deleteMany` then
 * `user.delete`. Neither dropped `workspace_<projectId>`, so every deleted
 * project left its tables, its rows, and its end-users' records resident in
 * PostgreSQL forever — with the Prisma row that named them gone, so nothing
 * could find them afterwards. The helper that drops the schema existed
 * (lib/billing/sandbox.ts) but was wired only to sandbox expiry.
 *
 * ── WHY ONE TRANSACTION ─────────────────────────────────────────────────────
 *
 * The workspace schemas and the Prisma tables live in the same PostgreSQL
 * database, and PostgreSQL DDL is transactional. So `DROP SCHEMA` and
 * `project.delete` can be a single atomic unit, which removes the entire class
 * of half-deleted states rather than managing them.
 *
 * That matters most in the direction people forget. Dropping first and deleting
 * the row second, non-transactionally, has an unrecoverable failure: the data is
 * gone and the row that pointed at it survives. There is no compensating action
 * for a dropped schema. Inside a transaction that outcome cannot occur — a
 * failure at any point leaves the project exactly as it was, and the user
 * retries.
 *
 * There is deliberately no per-schema error handling. Catching a failed drop and
 * continuing would produce precisely the silent partial deletion this module
 * exists to end.
 *
 * ── WHY AN OUTBOX ───────────────────────────────────────────────────────────
 *
 * Backups and storage objects cannot join that transaction. The job row that
 * records the remaining work is written INSIDE it, so it commits atomically with
 * the deletion: if the transaction rolls back there is no job, and if it commits
 * the job exists even when the process dies one instruction later.
 *
 * It reuses `BackgroundJob`, which already has attempts, backoff, dead-lettering
 * and a worker running every minute. Two properties make it correct here rather
 * than merely convenient: `projectId` is a plain column with no relation to
 * Project, so the cascade cannot delete the job that describes the cleanup; and
 * the table already exists in every deployed schema, so this needs no migration.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import {
  assertValidProjectId,
  isProjectOwnedSchema,
  projectSchemaPrefix,
  quoteIdent,
  workspaceSchemaName,
} from '@/lib/security/workspace-schema'
import { purgeProjectExternals } from '@/lib/projects/purge'
import { PURGE_JOB_TYPE, PURGE_STATUS } from '@/lib/queue'

export { PURGE_JOB_TYPE, PURGE_STATUS }

/**
 * Above this, an account delete stops being an interactive request and starts
 * being a batch job holding locks on dozens of schemas. Nobody is near it, so
 * the guard refuses loudly instead of us building a queue nothing uses yet.
 */
export const ACCOUNT_DELETE_INLINE_MAX = 25

/** Bounds the transaction so a lock fight fails fast instead of pinning a request. */
const LOCK_TIMEOUT = '5s'
const STATEMENT_TIMEOUT = '30s'
const TRANSACTION_TIMEOUT_MS = 60_000
const TRANSACTION_MAX_WAIT_MS = 10_000

export class TooManyProjectsError extends Error {
  constructor(count: number) {
    super(`Account has ${count} projects, above the inline delete limit of ${ACCOUNT_DELETE_INLINE_MAX}`)
    this.name = 'TooManyProjectsError'
  }
}

export class UnknownProjectSchemaError extends Error {
  constructor(schemaName: string) {
    super(`Refusing to delete: unrecognised schema in project namespace: ${schemaName.slice(0, 80)}`)
    this.name = 'UnknownProjectSchemaError'
  }
}

export interface DeletionResult {
  projectIds: string[]
  /** Schemas dropped, in the order they were dropped. */
  schemasDropped: string[]
  /** BackgroundJob ids written inside the transaction, one per project. */
  purgeJobIds: string[]
  /** False when the post-commit purge attempt failed and was left to the worker. */
  externalPurgeCompleted: boolean
}

type Tx = Prisma.TransactionClient

/**
 * Every schema this project owns, read from the catalog rather than inferred.
 *
 * Reading `pg_namespace` instead of enumerating known naming conventions is
 * deliberate. The conventions are spread across three modules — the canonical
 * name, `_br_<name>` branches, `_staging` — and a fourth added later would
 * silently start orphaning again. More importantly it also catches schemas whose
 * registry row was already lost to the original bug, which are exactly the ones
 * nothing else can find.
 *
 * `left(nspname, length($2)) = $2` rather than LIKE: `_` is a single-character
 * wildcard in LIKE and `workspace_` is full of them, so a LIKE pattern here
 * would need escaping to be correct and would be a quiet cross-tenant match if
 * anyone got the escaping wrong. Both parameters are bound values, never
 * identifiers, so this query cannot be injected.
 */
async function resolveProjectSchemas(tx: Tx, projectId: string): Promise<string[]> {
  assertValidProjectId(projectId)

  const canonical = workspaceSchemaName(projectId)
  const prefix = projectSchemaPrefix(projectId)

  const rows = await tx.$queryRaw<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace
    WHERE nspname = ${canonical}
       OR left(nspname, length(${prefix})) = ${prefix}
    ORDER BY nspname
  `

  const schemas = rows.map((r) => r.nspname)

  // Anything inside the project's namespace that does not match the allowlist is
  // something we do not understand. Abort the whole deletion rather than skip
  // it: skipping would leave customer data behind under a name nobody is
  // looking for, which is the failure being fixed.
  for (const schema of schemas) {
    if (!isProjectOwnedSchema(projectId, schema)) {
      throw new UnknownProjectSchemaError(schema)
    }
  }

  return schemas
}

/**
 * Drop every schema for one project and record the external work.
 *
 * Runs inside a caller-supplied transaction so a project delete and an account
 * delete share exactly one implementation. Returns what it dropped so the caller
 * can report it.
 */
async function purgeProjectInTransaction(
  tx: Tx,
  projectId: string,
): Promise<{ schemas: string[]; jobId: string }> {
  const schemas = await resolveProjectSchemas(tx, projectId)

  for (const schema of schemas) {
    // Validated against the project's own namespace above, then quoted. The
    // identifier cannot come from a request body: it came from pg_namespace.
    await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
  }

  // Written inside the transaction: this is the outbox record, and it must
  // commit with the drops or not at all. Payload carries the project id and
  // nothing else — no paths, no credentials, no user identifiers. The purge
  // service derives its own targets from configured roots.
  const job = await tx.backgroundJob.create({
    data: {
      type: PURGE_JOB_TYPE,
      // NOT 'queued'. A released worker claims 'queued' rows, has no handler
      // for this type, and would complete it as unknown — destroying the only
      // durable record that these files still need deleting. See PURGE_STATUS.
      status: PURGE_STATUS.pending,
      // projectId identifies the target; storageDriver records WHICH backend
      // held the files, so a retry after an operator changes STORAGE_DRIVER
      // still purges the backend the project actually used. Nothing else: no
      // paths, no credentials, no user identifiers.
      payload: { projectId, storageDriver: process.env.STORAGE_DRIVER || 'local' },
      attempts: 0,
      maxAttempts: 5,
      runAt: new Date(),
      // Deliberately null. `projectId` on BackgroundJob is a plain column with
      // no foreign key, but leaving it null keeps this job out of any
      // project-scoped listing for a project that no longer exists.
      projectId: null,
    },
    select: { id: true },
  })

  return { schemas, jobId: job.id }
}

/**
 * Attempt the external purge now, and report whether it finished.
 *
 * Never throws. The database work is already committed and correct; a failure
 * here only means the queued job has to finish the files, which is what it is
 * for. Throwing would turn a successful deletion into a 500 and invite a retry
 * that finds nothing left to delete.
 *
 * On success the job is closed out, so the queue does not accumulate rows whose
 * only outcome a minute later is a no-op purge. If closing it out fails, the
 * job simply stays queued and the worker repeats the purge — which is safe,
 * because the purge is idempotent. That is the right way round: a redundant
 * purge costs a directory stat, a lost job costs the customer's files staying
 * on disk.
 */
async function attemptImmediatePurge(
  targets: { projectId: string; jobId: string }[],
): Promise<boolean> {
  let allSucceeded = true

  for (const { projectId, jobId } of targets) {
    try {
      const report = await purgeProjectExternals(projectId, {
        storageDriver: process.env.STORAGE_DRIVER || 'local',
      })

      await prisma.backgroundJob
        .update({
          where: { id: jobId },
          data: {
            status: 'completed',
            completedAt: new Date(),
            result: {
              backups: report.backups,
              storage: report.storage,
              objectsDeleted: report.objectsDeleted,
            },
          },
        })
        .catch(() => {
          // Left queued on purpose. The worker will repeat an idempotent purge.
        })

      console.log(
        `[ProjectPurge] external purge complete project=${projectId} ` +
          `backups=${report.backups} storage=${report.storage} objects=${report.objectsDeleted}`,
      )
    } catch (err: any) {
      allSucceeded = false
      // Category only. The message can carry a filesystem path or a bucket name,
      // and this line goes to a shared log.
      console.warn(
        `[ProjectPurge] external purge deferred to worker project=${projectId} ` +
          `reason=${err?.name || 'Error'}`,
      )
    }
  }

  return allSucceeded
}

/**
 * Hard-delete one project: every schema it owns, every relational row, and then
 * its files.
 *
 * The caller is responsible for authorization. This function does not check
 * ownership — it deletes what it is told to, which is why nothing but an
 * authenticated route should reach it.
 */
export async function deleteProjectCompletely(projectId: string): Promise<DeletionResult> {
  assertValidProjectId(projectId)

  const { schemas, jobId } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      const result = await purgeProjectInTransaction(tx, projectId)

      // Cascades every dependent Prisma table, including WorkspaceBranch and
      // WorkspaceBackup. Last, so a constraint failure rolls back the drops.
      await tx.project.delete({ where: { id: projectId } })

      return result
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  )

  console.log(
    `[ProjectDelete] project=${projectId} schemas=${schemas.length} purgeJob=${jobId}`,
  )

  const externalPurgeCompleted = await attemptImmediatePurge([{ projectId, jobId }])

  return {
    projectIds: [projectId],
    schemasDropped: schemas,
    purgeJobIds: [jobId],
    externalPurgeCompleted,
  }
}

/**
 * Hard-delete an account: every project it owns, then the user.
 *
 * One transaction for the whole account, not one per project. Partial success is
 * worse than total failure here — a half-dismantled account cannot be retried
 * through the UI and leaves data resident with no owner to ask.
 *
 * The project ids are read first because `Project.userId` is `onDelete: Cascade`.
 * Deleting the user makes every project row vanish at the database level, so a
 * read afterwards would return nothing and the schemas would be unreachable
 * orphans with the last pointer to them gone.
 */
export async function deleteAccountCompletely(userId: string): Promise<DeletionResult> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('deleteAccountCompletely requires a userId')
  }

  const { projectIds, schemas, jobIds } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      // Read before the cascade destroys the list.
      const projects = await tx.project.findMany({
        where: { userId },
        select: { id: true },
        orderBy: { id: 'asc' },
      })

      if (projects.length > ACCOUNT_DELETE_INLINE_MAX) {
        throw new TooManyProjectsError(projects.length)
      }

      const allSchemas: string[] = []
      const allJobIds: string[] = []

      for (const project of projects) {
        const result = await purgeProjectInTransaction(tx, project.id)
        allSchemas.push(...result.schemas)
        allJobIds.push(result.jobId)
      }

      // Cascades the projects and everything under them.
      await tx.user.delete({ where: { id: userId } })

      return {
        projectIds: projects.map((p) => p.id),
        schemas: allSchemas,
        jobIds: allJobIds,
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  )

  console.log(
    `[AccountDelete] projects=${projectIds.length} schemas=${schemas.length} purgeJobs=${jobIds.length}`,
  )

  const externalPurgeCompleted = await attemptImmediatePurge(
    projectIds.map((projectId, i) => ({ projectId, jobId: jobIds[i] })),
  )

  return {
    projectIds,
    schemasDropped: schemas,
    purgeJobIds: jobIds,
    externalPurgeCompleted,
  }
}
