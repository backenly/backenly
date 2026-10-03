/**
 * Workspace schema name — single source of truth.
 *
 * Why this file exists: 30+ routes used to interpolate `workspace_${projectId}`
 * into raw SQL with no validation. If a non-UUID projectId ever flowed through
 * one of those paths, that's identifier injection. This helper hard-validates
 * before producing a name.
 *
 * Rule (canonical): `workspace_<uuid-with-hyphens>`. Hyphens are kept because
 * Postgres accepts them inside double-quoted identifiers, and every existing
 * row in production uses this form. Two earlier call sites used
 * `replace(/-/g, '_')` — those are bugs and must be migrated to the canonical
 * form via a separate one-time script. New code MUST go through this helper.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class InvalidProjectIdError extends Error {
  constructor(value: unknown) {
    super(`Invalid projectId for workspace schema: ${typeof value === 'string' ? value.slice(0, 40) : typeof value}`)
    this.name = 'InvalidProjectIdError'
  }
}

/**
 * Strict UUID v4-ish check (we accept any RFC-4122 layout, since some legacy
 * rows used v1). Anything not matching is rejected — never interpolated into SQL.
 */
export function assertValidProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
    throw new InvalidProjectIdError(projectId)
  }
}

/**
 * Returns the canonical workspace schema name for a project.
 * Throws InvalidProjectIdError if projectId is not a valid UUID.
 *
 * Always use this instead of building schema names inline.
 */
export function workspaceSchemaName(projectId: unknown): string {
  assertValidProjectId(projectId)
  return `workspace_${projectId}`
}

/**
 * Workspace realtime notification channel name (`workspace_<id>_changes`).
 * Same validation; same rules.
 */
export function workspaceChannelName(projectId: unknown): string {
  assertValidProjectId(projectId)
  return `workspace_${projectId}_changes`
}

/**
 * Quote an identifier for inclusion in raw SQL. Doubles any embedded quote.
 * Use ONLY for identifiers that have already been validated; this is a defense
 * in depth, not a replacement for validation.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * The prefix every schema belonging to a project shares: `workspace_<uuid>_`.
 *
 * A project owns more than its canonical schema. Branches live at
 * `workspace_<id>_br_<name>` (lib/branches/diff.ts) and a staging copy at
 * `workspace_<id>_staging` (executeCreateStaging in lib/ai/minimal-executor.ts),
 * and both hold real customer rows. Deletion has to find all of them.
 *
 * Safe as a namespace boundary because a UUID is fixed-length: for two distinct
 * ids A and B, `workspace_<A>_` can never prefix `workspace_<B>`, since the
 * character following the id is `_` and a UUID contains no underscore. So a
 * prefix match here cannot reach another project's data.
 */
export function projectSchemaPrefix(projectId: unknown): string {
  assertValidProjectId(projectId)
  return `workspace_${projectId}_`
}

/**
 * True when `schemaName` is the canonical schema for this project, or one of
 * its suffixed schemas (branch, staging, or any future variant).
 *
 * Deliberately a strict allowlist rather than a prefix check alone. Branch
 * schema names are derived from a user-supplied branch name, so the catalog
 * could in principle hold something with a quote or a space in it. Callers must
 * treat a `false` here as a reason to abort, never as a reason to skip: a
 * schema inside the project's namespace that does not match this pattern is
 * something we do not understand, and dropping data we do not understand is
 * worse than refusing to.
 */
export function isProjectOwnedSchema(projectId: unknown, schemaName: string): boolean {
  assertValidProjectId(projectId)
  if (typeof schemaName !== 'string') return false
  if (schemaName === `workspace_${projectId}`) return true
  if (!schemaName.startsWith(`workspace_${projectId}_`)) return false
  const suffix = schemaName.slice(`workspace_${projectId}_`.length)
  return suffix.length > 0 && /^[A-Za-z0-9_]+$/.test(suffix)
}

// ─── Reserved workspace tables — single source of truth ───────────────────────
//
// A workspace schema holds two kinds of tables:
//   1. Product tables the developer/end-users own (posts, comments, users, …).
//   2. Backenly-internal plumbing the runtime creates on the developer's behalf,
//      which must NEVER surface as product (no dashboard row, no generated API,
//      no realtime stream, no autonomy "fix", no count).
//
// Internal plumbing is, by hard convention, ANY leading-underscore table name:
//   • realtime/presence : _backenly_presence, _backenly_*
//   • auth runtime       : _token_blacklist, _email_verifications,
//                          _magic_links, _password_resets
//   • migrations         : _prisma_migrations
//   • any future _-prefixed internal table — covered automatically
// plus the Postgres/system namespaces (pg_*, information_schema, sql_*).
//
// BEFORE THIS HELPER: ~12 call sites each re-implemented their own filter, most
// only excluding `_backenly_%`. The auth-runtime tables (`_email_verifications`,
// `_token_blacklist`, …) slipped through every incomplete filter and leaked into
// the table count, got REST APIs generated on them by the autonomy loop, and —
// worst — were reachable over HTTP with no RLS (they hold single-use auth
// tokens). This predicate is the ONE rule every reader/writer must call so a new
// internal table is covered everywhere the instant it is named with a `_`.
//
// NOTE: `users` is a REAL end-user table (auth) and is NOT reserved. A caller
// that also wants to skip `users` (e.g. a synthetic CRUD self-test) must exclude
// it explicitly — it is product data, not plumbing.
const SYSTEM_TABLE_PREFIXES: readonly string[] = ['pg_', 'information_schema', 'sql_']

/**
 * True when `tableName` is a Backenly-internal / Postgres-system workspace table
 * that must be hidden from every product surface. Case-insensitive; null-safe.
 *
 * Use this everywhere a list of workspace tables is turned into product surface
 * (dashboard counts, API generation, proof, realtime, drift scans, the runtime
 * CRUD executor). Never hand-roll a `startsWith('_backenly_')` filter again.
 */
export function isReservedWorkspaceTable(tableName: string | null | undefined): boolean {
  if (typeof tableName !== 'string') return false
  const name = tableName.trim().toLowerCase()
  if (name.length === 0) return false
  if (name.startsWith('_')) return true
  return SYSTEM_TABLE_PREFIXES.some((p) => name.startsWith(p))
}

/**
 * A SQL predicate fragment (for a column holding a table name) that excludes
 * every reserved table — the raw-SQL equivalent of `!isReservedWorkspaceTable`.
 * Pass the already-quoted/qualified column expression, e.g.
 *   `WHERE ${notReservedTableSql('t.tablename')}`
 * Matches the TS predicate exactly: leading underscore + pg_/information_schema/sql_.
 * The column reference is trusted (caller-supplied literal), never user input.
 */
export function notReservedTableSql(colExpr: string): string {
  return (
    `${colExpr} NOT LIKE '\\_%' ESCAPE '\\' ` +
    `AND ${colExpr} NOT LIKE 'pg\\_%' ESCAPE '\\' ` +
    `AND lower(${colExpr}) NOT LIKE 'information_schema%' ` +
    `AND ${colExpr} NOT LIKE 'sql\\_%' ESCAPE '\\'`
  )
}
