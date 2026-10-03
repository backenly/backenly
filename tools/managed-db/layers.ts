/**
 * The five layers of a managed Backenly database, and who may mutate each.
 *
 * This exists because the lineage investigation found that the managed database
 * is not one artifact with one owner. Forcing all of it into Prisma migrations
 * is what produced the gap this project is closing.
 *
 * The rule the baseline work depends on:
 *
 *   the baseline owns the canonical schema and NOTHING else.
 *
 * Prose cannot enforce that a year from now, so the boundary is executable here:
 * `auditBaselineSql` reads generated baseline SQL and refuses anything that
 * reaches another layer, and `classifyObject` says which layer a captured object
 * belongs to. A rehearsal can then fail on its own rather than relying on a
 * reviewer remembering the rule.
 */

export type ManagedDbLayer =
  | 'server_config'
  | 'extensions'
  | 'canonical_schema'
  | 'managed_provisioning'
  | 'tenant_state'

export interface LayerOwnership {
  layer: ManagedDbLayer
  owner: string
  /** Whether the Prisma baseline/migration mechanism may change this layer. */
  baselineMayMutate: boolean
  /** 'never' is stronger than false: not even with a future flag. */
  strength: 'no' | 'never' | 'yes'
  contains: string
}

export const LAYER_OWNERSHIP: Record<ManagedDbLayer, LayerOwnership> = {
  server_config: {
    layer: 'server_config',
    owner: 'infrastructure (RDS parameter groups, reboots)',
    baselineMayMutate: false,
    strength: 'no',
    contains: 'shared_preload_libraries and other instance-level parameters',
  },
  extensions: {
    layer: 'extensions',
    owner: 'managed database provisioning',
    baselineMayMutate: false,
    strength: 'no',
    contains: 'pg_stat_statements, pgstattuple, vector',
  },
  canonical_schema: {
    layer: 'canonical_schema',
    owner: 'Prisma baseline and migrations',
    baselineMayMutate: true,
    strength: 'yes',
    contains: 'the platform tables, columns, constraints, indexes and enums generated from schema.prisma',
  },
  managed_provisioning: {
    layer: 'managed_provisioning',
    owner: 'provisioning installers (postgrest-*.sql, setup-direct-access.sql, roles)',
    baselineMayMutate: false,
    strength: 'no',
    contains: 'PostgREST registry, DDL sync, direct access, event triggers, support routines, roles and grants',
  },
  tenant_state: {
    layer: 'tenant_state',
    owner: 'runtime and project lifecycle',
    baselineMayMutate: false,
    strength: 'never',
    contains: 'workspace_* schemas, tenant tables, tenant RLS policies and data',
  },
}

const PROVISIONING_NAME = /^(backenly_pgrst_|backenly_direct_|backenly_capture_|backenly_app_role|backenly_ddl_watch|backenly_drop_watch)/
const PROVISIONING_SCHEMA = new Set(['postgrest', 'backenly_pgrst_idle'])

/** Which layer a captured object (a diff key, "<kind> <identity>") belongs to. */
export function classifyObject(key: string): ManagedDbLayer {
  const [kind, ...rest] = key.split(' ')
  const identity = rest.join(' ')
  const schema = identity.split('.')[0]
  const name = identity.split('.').pop() ?? ''

  if (kind === 'extension') return 'extensions'
  if (schema.startsWith('workspace_')) return 'tenant_state'
  if (kind === 'schema' && (identity.startsWith('workspace_') )) return 'tenant_state'
  if (kind === 'event_trigger') return 'managed_provisioning'
  if (PROVISIONING_SCHEMA.has(schema) || PROVISIONING_SCHEMA.has(identity)) return 'managed_provisioning'
  if (PROVISIONING_NAME.test(name) || PROVISIONING_NAME.test(identity)) return 'managed_provisioning'
  return 'canonical_schema'
}

export interface BaselineAuditFinding {
  layer: ManagedDbLayer
  why: string
  excerpt: string
}

interface ForbiddenStatement {
  pattern: RegExp
  layer: ManagedDbLayer
  why: string
}

/**
 * Statements a canonical-schema baseline must never contain.
 *
 * Shape-based rather than name-based wherever possible, so a new provisioning
 * object does not silently become baseline-owned by virtue of not being listed.
 */
const FORBIDDEN_IN_BASELINE: ForbiddenStatement[] = [
  { pattern: /CREATE\s+EXTENSION/i, layer: 'extensions', why: 'extensions are provisioning, not schema' },
  { pattern: /DROP\s+EXTENSION/i, layer: 'extensions', why: 'extensions are provisioning, not schema' },
  { pattern: /ALTER\s+SYSTEM/i, layer: 'server_config', why: 'server configuration is infrastructure' },
  { pattern: /\b(CREATE|ALTER|DROP)\s+ROLE\b/i, layer: 'managed_provisioning', why: 'roles are provisioning' },
  { pattern: /\b(GRANT|REVOKE)\b/i, layer: 'managed_provisioning', why: 'privileges are provisioning' },
  { pattern: /\bCREATE\s+EVENT\s+TRIGGER\b/i, layer: 'managed_provisioning', why: 'event triggers are provisioning' },
  { pattern: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, layer: 'managed_provisioning', why: 'default privileges are provisioning' },
  // Tenant schemas are `workspace_` plus a UUID-derived hex run. Requiring
  // eight hex characters keeps canonical platform tables like `workspace_files`
  // and `workspace_backups` out of it: those start with hex letters but are not
  // hex runs, and flagging them would block every baseline this gate exists to
  // protect.
  { pattern: /workspace_[0-9a-f]{8}/i, layer: 'tenant_state', why: 'tenant schemas are never baseline-owned' },
  { pattern: /\bbackenly_pgrst_\w+/i, layer: 'managed_provisioning', why: 'PostgREST registry objects are provisioning' },
  { pattern: /\bbackenly_direct_\w+/i, layer: 'managed_provisioning', why: 'direct-access objects are provisioning' },
  { pattern: /\bCREATE\s+SCHEMA\s+(IF\s+NOT\s+EXISTS\s+)?"?(postgrest|backenly_pgrst_idle)\b/i, layer: 'managed_provisioning', why: 'provisioning schemas are not baseline-owned' },
]

/**
 * Refuse a baseline that reaches outside the canonical schema.
 *
 * Returns every finding rather than the first, so one run tells you the whole
 * story instead of one problem at a time.
 */
export function auditBaselineSql(sql: string): BaselineAuditFinding[] {
  return FORBIDDEN_IN_BASELINE.flatMap(({ pattern, layer, why }) => {
    const match = sql.match(pattern)
    if (!match) return []
    const at = match.index ?? 0
    return [{ layer, why, excerpt: sql.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ') }]
  })
}

export function assertBaselineOwnsOnlyCanonicalSchema(sql: string): void {
  const findings = auditBaselineSql(sql)
  if (findings.length === 0) return
  const detail = findings.map(f => `  ${f.layer}: ${f.why}\n    …${f.excerpt}…`).join('\n')
  throw new Error(`the baseline reaches outside the canonical schema:\n${detail}`)
}
