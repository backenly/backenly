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
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import {
  assertValidProjectId,
  isProjectOwnedSchema,
  projectSchemaPrefix,
  quoteIdent,
  workspaceSchemaName,
} from '@/lib/security/workspace-schema'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { purgeProjectExternals } from '@/lib/projects/purge'
import { PURGE_JOB_TYPE, PURGE_STATUS } from '@/lib/queue'
import { purgeAccountState } from '@/lib/usage/account'
import { confirmPropagation, type Propagation } from '@/lib/auth-projection/confirm'

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
  /**
   * Logins kept as NOLOGIN with no password instead of dropped, because
   * something outside the project's database still names them (see dropRoles).
   * They cannot authenticate. Each is audited as DATABASE_LOGIN_RETIRED with the
   * deletion and logged as [LoginRetired], and stays until an operator removes
   * what names it and drops it.
   */
  retiredLogins: string[]
  /**
   * Whether the project's region has the deletion yet, for a single project
   * kept outside the home region (lib/auth-projection/confirm.ts). Unset for an
   * account deletion, whose projects' deletions are delivered all the same.
   */
  propagation?: Propagation
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
  // The deletion itself, on its way to the project's region. The delete
  // trigger records it in this same transaction, and the region removes the
  // project and its keys from its authorization copy only when this row is
  // delivered (lib/auth-projection/deliver.ts). Swept here, the region would
  // never hear of the deletion while its copy stayed fresh, and the deleted
  // project's keys would keep working there. Delivered rows are pruned a day
  // later; they hold ids only.
  AuthProjectionChange: 'carries the deletion to its region',
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
async function dropProjectDatabaseRoles(tx: Tx, projectId: string, schemas: string[]): Promise<string[]> {
  return dropRoles(tx, projectRoleNames(projectId, await credentialRoleNames(tx, projectId), schemas))
}

/** The login roles the project's credentials name, read from the platform database. */
async function credentialRoleNames(db: Pick<Tx, 'databaseCredential'>, projectId: string): Promise<string[]> {
  return (await db.databaseCredential.findMany({ where: { projectId }, select: { roleName: true } })).map(
    (r) => r.roleName,
  )
}

/**
 * Every login the project may own: its credentials' roles, the names derived
 * from the project (direct access, and the function login of its own schema),
 * and one function login per schema still found. The derived names reach a
 * login nothing else leads to any more: one retired when its credential was
 * revoked (revokeDirectAccess), or a function login a region retired in a
 * deletion whose platform step then failed, which dropped the schema its name
 * was derived from. dropRoles skips any that does not exist.
 */
function projectRoleNames(projectId: string, credentialRoles: string[], schemas: string[]): string[] {
  const { ro, rw } = directAccessRoleNames(projectId)
  const fnRoles = [workspaceSchemaName(projectId), ...schemas].map((schema) => functionRoleName(schema))
  return [...new Set([...credentialRoles, ro, rw, ...fnRoles])].filter((name) => /^bkn_(ro|rw|fn)_[0-9a-f]{12}$/.test(name))
}

/**
 * Drop these login roles in the cluster `tx` is connected to.
 *
 * Through the definer helpers where the installer created them:
 * public.backenly_direct_drop_role for bkn_ro_/bkn_rw_ (terminates sessions,
 * strips policies, reassigns, drops) and public.backenly_fn_role_drop for
 * bkn_fn_. Otherwise a guarded manual drop, which only a login that may drop
 * the role can run: the app role on a managed database is NOCREATEROLE and
 * holds none of these roles' privileges, so there it fails with 42501.
 * Existence is CHECKED rather than caught: an error inside the transaction
 * would abort the whole deletion.
 *
 * A login that anything outside this database still names is retired, not
 * dropped: DROP OWNED reaches only this database, so DROP ROLE would fail with
 * 2BP01 and abort the deletion, and what lies outside is not this module's to
 * change. Retired is NOLOGIN with no password, so the login authenticates by no
 * means. The helpers do the same; see public.backenly_direct_drop_role. It
 * stays retired: nothing drops it later on its own. An operator removes what
 * names it elsewhere and then calls the helper, using the record that
 * recordRetiredLogins keeps of each one.
 *
 * Returns the logins retired rather than dropped.
 */
async function dropRoles(tx: Tx, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return []

  const [helpers] = await tx.$queryRaw<{ direct: boolean; fn: boolean }[]>`
    SELECT to_regprocedure('public.backenly_direct_drop_role(text)') IS NOT NULL AS direct,
           to_regprocedure('public.backenly_fn_role_drop(text)') IS NOT NULL AS fn`

  const retired: string[] = []
  for (const role of candidates) {
    const exists = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`
    if (Number(exists[0]?.n ?? 0) === 0) continue

    // Each helper validates its argument against its own role shape, and
    // answers false for a login it retired.
    if (helpers?.direct && /^bkn_(ro|rw)_/.test(role)) {
      const [{ gone }] = await tx.$queryRaw<{ gone: boolean }[]>`SELECT public.backenly_direct_drop_role(${role}) AS gone`
      if (!gone) retired.push(role)
    } else if (helpers?.fn && /^bkn_fn_/.test(role)) {
      const [{ gone }] = await tx.$queryRaw<{ gone: boolean }[]>`SELECT public.backenly_fn_role_drop(${role}) AS gone`
      if (!gone) retired.push(role)
    } else {
      // The schemas are already dropped in this transaction, so the role's
      // grants on them are gone; DROP OWNED clears anything else it holds here.
      await tx.$executeRawUnsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`,
      )
      await tx.$executeRawUnsafe(`DROP OWNED BY ${quoteIdent(role)}`)
      if (await namedOutsideThisDatabase(tx, role)) {
        await tx.$executeRawUnsafe(`ALTER ROLE ${quoteIdent(role)} NOLOGIN PASSWORD NULL`)
        retired.push(role)
      } else {
        await tx.$executeRawUnsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`)
      }
    }
  }
  return retired
}

/**
 * Whether anything outside the current database still names the role: another
 * database's objects, or a server-level one (dbid 0), such as a database-level
 * privilege DROP OWNED could not revoke.
 */
async function namedOutsideThisDatabase(tx: Tx, role: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ outside: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid
       WHERE s.refclassid = 'pg_authid'::regclass AND r.rolname = ${role}
         AND s.dbid <> (SELECT oid FROM pg_database WHERE datname = current_database())
    ) AS outside`
  return Boolean(row?.outside)
}

/** Logins a deletion retired, with the project and the region whose cluster holds them. */
interface RetiredLogins {
  projectId: string
  region: CloudRegionId
  logins: string[]
}

/**
 * Record each retirement inside the deletion's own transaction, as the purge outbox is recorded, so a retired login
 * is never left without a record: it commits with the deletion or not at all. A retirement means something outside
 * the project's database, typically a copy of its data, still names the login, and nothing drops it later on its
 * own, so the row is what an operator works from. projectId is unset so the project's cascade does not take it.
 */
async function recordRetiredLogins(tx: Tx, groups: RetiredLogins[], via: string): Promise<void> {
  for (const { projectId, region, logins } of groups) {
    if (logins.length === 0) continue
    await tx.auditLog.create({
      data: {
        action: 'DATABASE_LOGIN_RETIRED',
        type: 'security',
        details: JSON.stringify({ projectId, region, logins, via }),
        timestamp: new Date(),
      },
    })
  }
}

/**
 * After the deletion has committed: end any session that outlived the retirement, and say what is still retired.
 *
 * A session that logged in between a helper ending the login's sessions and the commit outlived them, because the
 * login was LOGIN until the commit; it is NOLOGIN now, so ending its sessions once more leaves none. The helpers are
 * idempotent, and the second answer is the one reported: a login the platform step dropped after its region retired
 * it (one cluster serving both) is not reported as retired. Bounded like the deletion's own transactions, so a lock
 * cannot hold the response of a deletion that has already committed.
 *
 * Each retirement is a warning with a stable tag for alarms; recordRetiredLogins already wrote its audit row.
 *
 * Never throws: the deletion is committed. A failure here leaves the pre-commit list as the answer.
 */
async function settleRetiredLogins(groups: RetiredLogins[], via: string): Promise<string[]> {
  const retired: string[] = []
  for (const { projectId, region, logins } of groups) {
    if (logins.length === 0) continue
    let still = logins
    try {
      const db = region === HOME_REGION ? prisma : regionRawClient(region, projectId)
      still = await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
          return dropRoles(tx as Tx, logins)
        },
        { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
      )
    } catch (err: any) {
      console.warn(`[LoginRetired] project=${projectId} second pass failed reason=${err?.name || 'Error'}`)
    }
    if (still.length === 0) continue
    retired.push(...still)
    console.warn(
      `[LoginRetired] project=${projectId} region=${region} logins=${still.join(',')} via=${via}: ` +
        'something outside the project database still names them; they cannot log in, and stay until an operator ' +
        'removes what names them and drops them (audit DATABASE_LOGIN_RETIRED)',
    )
  }
  return [...new Set(retired)]
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
 * Returns the schemas dropped and the logins retired. Home-region projects
 * return none: their schemas and roles are dropped inside the platform
 * transaction, as before.
 */
async function dropRegionalProjectData(
  projectId: string,
  region: CloudRegionId,
): Promise<{ schemas: string[]; retiredLogins: string[] }> {
  if (region === HOME_REGION) return { schemas: [], retiredLogins: [] }

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
      // The project's customer data kept off its platform rows
      // (lib/data-plane/regional-bodies.ts) goes with it, not 30 days later.
      // A database the procedure has not given the table yet holds none.
      const [{ present }] = await rtx.$queryRaw<{ present: boolean }[]>`
        SELECT to_regclass('public.regional_bodies') IS NOT NULL AS present`
      if (present) await rtx.$executeRaw`DELETE FROM public.regional_bodies WHERE "projectId" = ${projectId}`
      // After the schemas, so the roles hold no grants that would block the drop.
      const retiredLogins = await dropRoles(rtx, projectRoleNames(projectId, credentialRoles, schemas))
      return { schemas, retiredLogins }
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
): Promise<{ schemas: string[]; jobId: string; retiredLogins: string[] }> {
  const schemas = await resolveProjectSchemas(tx, projectId)

  for (const schema of schemas) {
    // Validated against the project's own namespace above, then quoted. The
    // identifier cannot come from a request body: it came from pg_namespace.
    await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
  }

  // After the schemas, so the roles hold no grants that would block the drop.
  const retiredLogins = await dropProjectDatabaseRoles(tx, projectId, schemas)

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

  return { schemas, jobId: job.id, retiredLogins }
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
  targets: { projectId: string; jobId: string; region: CloudRegionId }[],
): Promise<boolean> {
  let allSucceeded = true

  for (const { projectId, jobId, region } of targets) {
    // A project kept in another region is purged there, by that region's
    // scheduler (lib/queue/worker.ts processPurgeJobs): its bucket and disks
    // are not this process's. The job stays pending until it does.
    if (region !== serviceRegion()) {
      allSucceeded = false
      continue
    }
    try {
      const report = await purgeProjectExternals(projectId, {
        storageDriver: process.env.STORAGE_DRIVER || 'local',
        region,
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
  const regional = await dropRegionalProjectData(projectId, region)

  const { schemas, jobId, retiredLogins: platformRetired } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)

      const result = await purgeProjectInTransaction(tx, projectId, region)
      result.schemas.unshift(...regional.schemas)
      await recordRetiredLogins(
        tx,
        [
          { projectId, region, logins: regional.retiredLogins },
          { projectId, region: HOME_REGION, logins: result.retiredLogins },
        ],
        'project deletion',
      )

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

  const retiredLogins = await settleRetiredLogins(
    [
      { projectId, region, logins: regional.retiredLogins },
      { projectId, region: HOME_REGION, logins: platformRetired },
    ],
    'project deletion',
  )

  const externalPurgeCompleted = await attemptImmediatePurge([{ projectId, jobId, region }])
  // Its keys stop working in its region once the region has the deletion
  // (lib/auth-projection/confirm.ts); `pending` says it is still in flight.
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId })

  return {
    projectIds: [projectId],
    schemasDropped: schemas,
    purgeJobIds: [jobId],
    externalPurgeCompleted,
    retiredLogins,
    propagation,
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
  const retiredGroups: RetiredLogins[] = []
  for (const project of owned) {
    const region = regionOfRecord(project.id, project.region)
    regions.set(project.id, region)
    const regional = await dropRegionalProjectData(project.id, region)
    regionalSchemas.push(...regional.schemas)
    retiredGroups.push({ projectId: project.id, region, logins: regional.retiredLogins })
  }

  const { projectIds, schemas, jobIds, platformRetired } = await prisma.$transaction(
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
      const homeRetired: RetiredLogins[] = []

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
        homeRetired.push({ projectId: project.id, region: HOME_REGION, logins: result.retiredLogins })
      }
      await recordRetiredLogins(tx, [...retiredGroups, ...homeRetired], 'account deletion')

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
        platformRetired: homeRetired,
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  )

  console.log(
    `[AccountDelete] projects=${projectIds.length} schemas=${schemas.length} purgeJobs=${jobIds.length}`,
  )

  const retiredLogins = await settleRetiredLogins([...retiredGroups, ...platformRetired], 'account deletion')

  const externalPurgeCompleted = await attemptImmediatePurge(
    projectIds.map((projectId, i) => ({ projectId, jobId: jobIds[i], region: regions.get(projectId) ?? HOME_REGION })),
  )

  return {
    projectIds,
    schemasDropped: schemas,
    purgeJobIds: jobIds,
    externalPurgeCompleted,
    retiredLogins,
  }
}
