/**
 * WHOSE STATEMENT IS IT
 * =====================
 *
 * pg_stat_statements keeps one set of statistics for the whole database, and
 * every project in a region has its schema in that one database. So before a
 * statement's timings are read as a project's traffic, the statement is given
 * to a project, and it is given by the role that ran it:
 *
 *   the project's own roles   its functions' role, its direct connections'
 *                             roles and the role that owns its schema. Their
 *                             statements are the project's, whatever they name:
 *                             they run with a search path set to the project's
 *                             schema, so they say `FROM orders`.
 *   the platform's roles      PostgREST's anon, authenticated and service_role,
 *                             which serve /api/v2 and v1 /db, and Backenly's own
 *                             application role (the one reading the statistics).
 *                             They run statements for every project, so one is
 *                             this project's when, read as SQL, it names this
 *                             project's schema (./statement-text.ts). Both
 *                             always qualify a table with its schema.
 *   any other role            an operator's session, a dump: no project's.
 *
 * The statistics are read as the application role, which holds the privileges
 * of pg_read_all_stats (tools/managed-db/regional/sql/roles.sql,
 * tools/managed-db/sql/grant-workspace-create.sql, scripts/setup-app-role.ts):
 * without them PostgreSQL hides the text of every statement another role ran.
 */

import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { namesSchema } from './statement-text'

/** The roles PostgREST switches to for a request (lib/postgrest/gateway.ts). */
export const POSTGREST_ROLES: readonly string[] = ['anon', 'authenticated', 'service_role']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The names lib/services/direct-access.ts and function-db-role.ts give a project's roles. */
const PROJECT_ROLE_PATTERN = '^bkn_(fn|ro|rw|own)_[0-9a-f]{12}$'

/** The project id a canonical `workspace_<id>` schema name carries, or null. */
function projectIdOf(schema: string): string | null {
  const id = schema.startsWith('workspace_') ? schema.slice('workspace_'.length) : ''
  return UUID.test(id) ? id : null
}

/**
 * The roles that are this project's alone. `projectId` defaults to the one the
 * schema name carries; a schema that carries none still has its function role.
 */
export function projectRoles(schema: string, projectId: string | null = projectIdOf(schema)): string[] {
  const roles = [functionRoleName(schema)]
  if (projectId && UUID.test(projectId)) {
    const { ro, rw, owner } = directAccessRoleNames(projectId)
    roles.push(ro, rw, owner)
  }
  return roles
}

/** The arrays the scope below binds: this project's roles, and the platform roles. */
export function statementRoles(schema: string, projectId?: string | null): { own: string[]; platform: string[] } {
  return { own: projectRoles(schema, projectId ?? projectIdOf(schema)), platform: [...POSTGREST_ROLES] }
}

/**
 * A WHERE condition over pg_stat_statements (`s`) joined to pg_roles (`r`, on
 * r.oid = s.userid) that keeps a statement only when it may be this project's:
 * run by one of its own roles, or by a platform role with the schema's name in
 * its text. `projectStatement` then reads that text as SQL. The arguments are
 * placeholders: the schema name, then the two arrays of statementRoles.
 *
 * `includeApplicationRole: false` leaves Backenly's own statements out, for a
 * reading of client traffic only.
 */
export function projectStatementScope(a: {
  s: string
  r: string
  schema: string
  ownRoles: string
  platformRoles: string
  includeApplicationRole?: boolean
}): string {
  const platform =
    a.includeApplicationRole === false
      ? `${a.r}.rolname = ANY(${a.platformRoles}::text[])`
      : `(${a.r}.rolname = ANY(${a.platformRoles}::text[]) OR ${a.r}.rolname = current_user)`
  return (
    `(${a.r}.rolname = ANY(${a.ownRoles}::text[])` +
    ` OR (${platform} AND position(${a.schema} in ${a.s}.query) > 0))`
  )
}

/**
 * A WHERE condition over pg_roles (`r`) that leaves out every other project's
 * own roles, for a reading that counts every role's statements but those: a
 * statement another project's role ran is that project's, whatever it names.
 */
export function notAnotherProjectsRole(r: string, ownRoles: string): string {
  return `(${r}.rolname = ANY(${ownRoles}::text[]) OR ${r}.rolname !~ '${PROJECT_ROLE_PATTERN}')`
}

/** The column projectStatementScope's rows carry to say a project role ran them. */
export function byOwnRoleColumn(r: string, ownRoles: string): string {
  return `(${r}.rolname = ANY(${ownRoles}::text[]))`
}

/**
 * Whether a row the scope kept is this project's: one of its own roles ran it,
 * or it names the project's schema as SQL rather than only inside a comment or
 * a string.
 */
export function projectStatement(row: { query: string; byOwnRole: boolean }, schema: string): boolean {
  return row.byOwnRole || namesSchema(row.query, schema)
}
