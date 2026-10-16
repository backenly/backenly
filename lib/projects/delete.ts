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
 * ── A PROJECT IN ANOTHER REGION ─────────────────────────────────────────────
 *
 * Its schemas and its logins live in its region's database cluster, which no
 * transaction on the platform database can reach. They are dropped first, in
 * their region, in a transaction of their own (dropRegionalProjectData); the
 * platform transaction follows. Two databases cannot commit as one, so the order
 * is chosen to leave only a retryable state: a failure between the two leaves a
 * project row with nothing behind it in its region, never regional data with no
 * row pointing at it.
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
import { projectRegion, regionOfRecord, regionRawClient } from '@/lib/data-plane/regional'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import {
  assertValidProjectId,
  isProjectOwnedSchema,
  projectSchemaPrefix,
  quoteIdent,
  workspaceSchemaName,
} from '@/lib/security/workspace-schema'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { purgeProjectExternals } from '@/lib/projects/purge'
import { PURGE_JOB_TYPE, PURGE_STATUS } from '@/lib/queue'
import { purgeAccountState } from '@/lib/usage/account'

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

export class ProjectCreatedDuringDeletionError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was created in another region while its account was being deleted; retry the deletion`)
    this.name = 'ProjectCreatedDuringDeletionError'
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

// ── Rows the Project cascade cannot reach ────────────────────────────────────
//
// Dozens of models carry a bare `projectId` column with no relation to
// Project, so `project.delete` left them behind: full DDL snapshots (rawDdl
// that can recreate the schema), PITR/state graph snapshots, MCP OAuth codes
// and access tokens, security events — after a deletion whose Settings copy
// says "every receipt". The list is DERIVED from the Prisma schema at module
// load, so a future model with a bare projectId is swept automatically instead
// of quietly joining the orphan class.
//
// Deliberately NOT swept:
const SWEEP_EXCLUDED: Record<string, string> = {
  // A session belongs to the USER; projectId only records which project was
  // open. Deleting the row would log the owner out mid-deletion — the pointer
  // is nulled instead.
  Session: 'nulled, not deleted',
  // Billed usage happened and is owed by the billing ACCOUNT. The ledger rows
  // must survive the project so the month still closes truthfully.
  UsageDaily: 'billing ledger',
  UsageMetric: 'billing ledger',
  // Platform telemetry about Backenly itself, not customer content.
  ProductEvent: 'platform telemetry',
}

/** Exported for the deletion test, which seeds and sweeps this exact list. */
export const ORPHANED_PROJECT_MODELS: string[] = Prisma.dmmf.datamodel.models
  .filter(
    (m) =>
      m.fields.some((f) => f.name === 'projectId' && f.kind === 'scalar') &&
      !m.fields.some((f) => f.kind === 'object' && f.type === 'Project') &&
      !(m.name in SWEEP_EXCLUDED),
  )
  .map((m) => m.name)

/**
 * Remove every row the cascade left behind. Runs AFTER the project (or user)
 * row is deleted, inside the same transaction: by then every cascade-covered
 * table is already empty, intra-model children (ApiUsageLog,
 * MaintenanceStepExecution) are gone with their parents, and whatever still
 * carries this projectId is precisely the orphan class being removed.
 */
async function sweepOrphanedProjectRows(tx: Tx, projectId: string): Promise<void> {
  await tx.session.updateMany({ where: { projectId }, data: { projectId: null } })
  for (const model of ORPHANED_PROJECT_MODELS) {
    const delegate = (tx as any)[model.charAt(0).toLowerCase() + model.slice(1)]
    await delegate.deleteMany({ where: { projectId } })
  }
}

/**
 * Drop the project's own PostgreSQL LOGIN roles.
 *
 * run_query provisions bkn_ro_<hex> for any project an agent queries, the
 * owner may have enabled bkn_rw_<hex>, and the function runtime derives
 * bkn_fn_<hex> per schema. None of these died with the project: the roles are
 * cluster-level, pg_hba admits their group remotely, and the encrypted
 * passwords sat in DatabaseCredential rows the cascade could not reach — so a
 * contractor's psql kept logging in to the production cluster after the
 * project was "permanently" deleted.
 */
async function dropProjectDatabaseRoles(tx: Tx, projectId: string, schemas: string[]): Promise<void> {
  await dropRoles(tx, projectRoleNames(await credentialRoleNames(tx, projectId), schemas))
}

/** The login roles the project's credentials name, read from the platform database. */
async function credentialRoleNames(db: Pick<Tx, 'databaseCredential'>, projectId: string): Promise<string[]> {
  return (await db.databaseCredential.findMany({ where: { projectId }, select: { roleName: true } })).map(
    (r) => r.roleName,
  )
}

/** Every login the project may own: its credentials' roles, and one function role per schema. */
function projectRoleNames(credentialRoles: string[], schemas: string[]): string[] {
  const fnRoles = schemas.map((schema) => functionRoleName(schema))
  return [...new Set([...credentialRoles, ...fnRoles])].filter((name) => /^bkn_(ro|rw|fn)_[0-9a-f]{12}$/.test(name))
}

/**
 * Drop these login roles in the cluster `tx` is connected to.
 *
 * Uses public.backenly_direct_drop_role (terminates sessions, strips
 * policies, reassigns, drops) where the installer created it; otherwise a
 * guarded manual drop. Existence is CHECKED rather than caught: an error
 * inside the transaction would abort the whole deletion.
 */
async function dropRoles(tx: Tx, candidates: string[]): Promise<void> {
  if (candidates.length === 0) return

  const helper = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'backenly_direct_drop_role'`
  const hasHelper = Number(helper[0]?.n ?? 0) > 0

  for (const role of candidates) {
    const exists = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`
    if (Number(exists[0]?.n ?? 0) === 0) continue

    // The installer's helper validates its argument against the direct-access
    // role shapes (bkn_ro_/bkn_rw_) and refuses bkn_fn_ — those take the
    // manual path even where the helper exists.
    if (hasHelper && /^bkn_(ro|rw)_/.test(role)) {
      await tx.$queryRaw`SELECT public.backenly_direct_drop_role(${role})`
    } else {
      // The schemas are already dropped in this transaction, so the role's
      // grants on them are gone; DROP OWNED clears anything else it holds.
      await tx.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`,
      )
      await tx.$executeRawUnsafe(`DROP OWNED BY ${quoteIdent(role)}`)
      await tx.$executeRawUnsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`)
    }
  }
}

/**
 * A project outside the home region keeps its schemas, and its logins, in its
 * region's database cluster, which the platform transaction cannot reach: the
 * drops there find nothing, so the project's data and its direct-access logins
 * would outlive the project. They are dropped first, in their region, in a
 * transaction of their own on that region's database.
 *
 * Before the platform transaction, not after. If the platform step then fails,
 * the project's row survives with nothing left in its region, and the user's
 * retry finishes the deletion: this step is idempotent and finds nothing to
 * drop the second time. The other order could commit the deletion and leave the
 * regional data with no row pointing at it, the failure this module ends.
 *
 * Returns the schemas dropped. Home-region projects return none: their
 * schemas and roles are dropped inside the platform transaction, as before.
 */
async function dropRegionalProjectData(projectId: string, region: CloudRegionId): Promise<string[]> {
  if (region === HOME_REGION) return []

  // The credentials are platform rows: read them here, drop their roles there.
  const credentialRoles = await credentialRoleNames(prisma, projectId)
  return regionRawClient(region, projectId).$transaction(
    async (rtx) => {
      await rtx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await rtx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
      const schemas = await resolveProjectSchemas(rtx, projectId)
      for (const schema of schemas) {
        await rtx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      }
      // After the schemas, so the roles hold no grants that would block the drop.
      await dropRoles(rtx, projectRoleNames(credentialRoles, schemas))
      return schemas
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  )
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
  region: CloudRegionId,
): Promise<{ schemas: string[]; jobId: string }> {
  const schemas = await resolveProjectSchemas(tx, projectId)

  for (const schema of schemas) {
    // Validated against the project's own namespace above, then quoted. The
    // identifier cannot come from a request body: it came from pg_namespace.
    await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
  }

  // After the schemas, so the roles hold no grants that would block the drop.
  await dropProjectDatabaseRoles(tx, projectId, schemas)

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
      // still purges the backend the project actually used; region records
      // where they live, which no later read can recover once the project's
      // row is gone. Nothing else: no paths, no credentials, no user
      // identifiers.
      payload: { projectId, storageDriver: process.env.STORAGE_DRIVER || 'local', region },
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

  // Read while the row exists; a region error stops the deletion here, before
  // anything is dropped anywhere.
  const region = await projectRegion(projectId)
  const regionalSchemas = await dropRegionalProjectData(projectId, region)

  const { schemas, jobId } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      const result = await purgeProjectInTransaction(tx, projectId, region)
      result.schemas.unshift(...regionalSchemas)

      // Cascades every dependent Prisma table, including WorkspaceBranch and
      // WorkspaceBackup — so a constraint failure rolls back the drops.
      await tx.project.delete({ where: { id: projectId } })

      // After the cascade: whatever still carries this projectId is an orphan.
      await sweepOrphanedProjectRows(tx, projectId)

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

  // Projects outside the home region first, each in its region, before the
  // platform transaction (dropRegionalProjectData explains the order).
  const owned = await prisma.project.findMany({
    where: { userId },
    select: { id: true, region: true },
    orderBy: { id: 'asc' },
  })
  if (owned.length > ACCOUNT_DELETE_INLINE_MAX) {
    throw new TooManyProjectsError(owned.length)
  }
  const regions = new Map<string, CloudRegionId>()
  const regionalSchemas: string[] = []
  for (const project of owned) {
    const region = regionOfRecord(project.id, project.region)
    regions.set(project.id, region)
    regionalSchemas.push(...(await dropRegionalProjectData(project.id, region)))
  }

  const { projectIds, schemas, jobIds } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      // Read before the cascade destroys the list.
      const projects = await tx.project.findMany({
        where: { userId },
        select: { id: true, region: true },
        orderBy: { id: 'asc' },
      })

      if (projects.length > ACCOUNT_DELETE_INLINE_MAX) {
        throw new TooManyProjectsError(projects.length)
      }

      const allSchemas: string[] = [...regionalSchemas]
      const allJobIds: string[] = []

      for (const project of projects) {
        const region = regions.get(project.id) ?? regionOfRecord(project.id, project.region)
        // A project created in another region after the regional drops above
        // still has its data there: refuse, and the retry drops it too.
        if (!regions.has(project.id) && region !== HOME_REGION) {
          throw new ProjectCreatedDuringDeletionError(project.id)
        }
        const result = await purgeProjectInTransaction(tx, project.id, region)
        allSchemas.push(...result.schemas)
        allJobIds.push(result.jobId)
      }

      // The account's own AI usage and credit balances, which do not cascade.
      await purgeAccountState(tx, userId)

      // Cascades the projects and everything under them.
      await tx.user.delete({ where: { id: userId } })

      // After the cascade: sweep each project's orphaned rows.
      for (const project of projects) {
        await sweepOrphanedProjectRows(tx, project.id)
      }

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
