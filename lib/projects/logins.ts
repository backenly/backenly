/**
 * A project's own PostgreSQL logins: bkn_ro_ and bkn_rw_ for direct access,
 * and bkn_fn_ for its functions.
 *
 * run_query provisions bkn_ro_<hex> for any project an agent queries, the
 * owner may have enabled bkn_rw_<hex>, and the function runtime derives
 * bkn_fn_<hex> per schema. None of these died with the project: the roles are
 * cluster-level, pg_hba admits their group remotely, and the encrypted
 * passwords sat in DatabaseCredential rows the cascade could not reach — so a
 * contractor's psql kept logging in to the production cluster after the
 * project was "permanently" deleted. A deletion drops them
 * (lib/projects/delete.ts).
 *
 * When the deletion drops the project's schema later, because PostgREST still
 * served it (lib/postgrest/retire-schema.ts), the logins cannot go first:
 * dropping a login revokes what it was granted on the schema's objects, which
 * belong to the project's owner role, and on Amazon RDS the definer holds none
 * of that role's privileges. So the deletion retires them at once
 * (retireLogins), and the pass that drops the schema drops them with it
 * (dropLogins).
 */

import type { Prisma } from '@prisma/client'
import { quoteIdent, workspaceSchemaName } from '@/lib/security/workspace-schema'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import type { CloudRegionId } from '@/lib/regions'

type Tx = Prisma.TransactionClient

/**
 * Every login the project may own: its credentials' roles, the names derived
 * from the project (direct access, and the function login of its own schema),
 * and one function login per schema still found. The derived names reach a
 * login nothing else leads to any more: one retired when its credential was
 * revoked (revokeDirectAccess), or a function login a region retired in a
 * deletion whose platform step then failed, which dropped the schema its name
 * was derived from. dropLogins skips any that does not exist.
 */
export function projectLoginNames(projectId: string, credentialRoles: string[], schemas: string[]): string[] {
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
export async function dropLogins(tx: Tx, candidates: string[]): Promise<string[]> {
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
export interface RetiredLogins {
  projectId: string
  region: CloudRegionId
  logins: string[]
}

/**
 * Record each retirement inside the deletion's own transaction, as the purge outbox is recorded, so a retired login
 * is never left without a record: it commits with the deletion or not at all. A retirement means something outside
 * the project's database, typically a copy of its data, still names the login, and nothing drops it later on its
 * own, so the row is what an operator works from. projectId is unset so the project's cascade does not take it.
 * The pass that drops a deleted project's schema later records the logins it could not drop the same way
 * (lib/postgrest/retire-schema.ts).
 */
export async function recordRetiredLogins(
  tx: Pick<Prisma.TransactionClient, 'auditLog'>,
  groups: RetiredLogins[],
  via: string,
): Promise<void> {
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

/** Whether a login of this name exists in the cluster `tx` is connected to. */
async function loginExists(tx: Tx, role: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`
  return Number(rows[0]?.n ?? 0) > 0
}

/** The retire helpers this database has, and whether this login is a superuser, which may retire any login itself. */
async function retireMeans(tx: Tx): Promise<{ direct: boolean; fn: boolean; superuser: boolean }> {
  const [row] = await tx.$queryRaw<{ direct: boolean; fn: boolean; superuser: boolean }[]>`
    SELECT to_regprocedure('public.backenly_direct_retire_role(text)') IS NOT NULL AS direct,
           to_regprocedure('public.backenly_fn_role_retire(text)') IS NOT NULL AS fn,
           coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser`
  return { direct: Boolean(row?.direct), fn: Boolean(row?.fn), superuser: Boolean(row?.superuser) }
}

/**
 * Whether retireLogins can retire every one of these logins that exists: the
 * helper for its kind is installed (scripts/setup-direct-access.sql,
 * scripts/sql/function-roles.sql), or this login is a superuser. Where it
 * cannot, a deletion drops the project's schemas at once, as it did before
 * they were kept for PostgREST, so that its logins can be dropped with them.
 */
export async function loginsRetirable(tx: Tx, candidates: string[]): Promise<boolean> {
  const existing: string[] = []
  for (const role of candidates) if (await loginExists(tx, role)) existing.push(role)
  if (existing.length === 0) return true
  const means = await retireMeans(tx)
  if (means.superuser) return true
  return existing.every((role) => (/^bkn_fn_/.test(role) ? means.fn : means.direct))
}

/**
 * Retire these logins now, to drop them later with their project's schema:
 * NOLOGIN with no password, so each authenticates by no means, and its
 * sessions ended. Through the definer helpers where they are installed,
 * otherwise directly, which loginsRetirable allows only to a superuser. A
 * session that logged in before the caller commits outlives the retirement,
 * so the caller calls again after its commit; the call is idempotent.
 *
 * Returns the logins that exist, each now unable to log in.
 */
export async function retireLogins(tx: Tx, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return []
  const means = await retireMeans(tx)
  const retired: string[] = []
  for (const role of candidates) {
    if (!(await loginExists(tx, role))) continue
    // Each helper validates its argument against its own role shape.
    if (means.direct && /^bkn_(ro|rw)_/.test(role)) {
      await tx.$queryRaw`SELECT public.backenly_direct_retire_role(${role}) AS retired`
    } else if (means.fn && /^bkn_fn_/.test(role)) {
      await tx.$queryRaw`SELECT public.backenly_fn_role_retire(${role}) AS retired`
    } else {
      await tx.$executeRawUnsafe(`ALTER ROLE ${quoteIdent(role)} NOLOGIN PASSWORD NULL`)
      await tx.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`)
    }
    retired.push(role)
  }
  return retired
}
