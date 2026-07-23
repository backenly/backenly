/**
 * DRIFT DETECTOR
 * ==============
 * Pillar 3.1 — Schema Drift Detection
 * Pillar 3.2 — Auth Integrity
 * Pillar 3.5 — API Coverage
 *
 * Detects deviations between the AI's intended state and the actual live state:
 *  - FK-pattern columns with no FK constraint (correctness)
 *  - Tables with no API definition (completeness)
 *  - Columns added directly to the DB, bypassing the AI (shadow mutations)
 *  - FK columns missing an index (performance)
 *  - Auth configuration gaps (security)
 *  - API endpoint coverage gaps (completeness)
 *
 * Every function returns RawFinding[] and is safe to call concurrently.
 * Each detector swallows its own errors so one failure cannot break the loop.
 */

import { prisma } from '@/lib/db/prisma'
import { queryWorkspaceSchema, executeInWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { listSchemaSnapshots, getSchemaSnapshot } from '@/lib/services/workspace-schema-snapshot'
import { isReservedWorkspaceTable, notReservedTableSql } from '@/lib/security/workspace-schema'
import type { RawFinding } from './types'

// ─── 3.1 Schema Drift ────────────────────────────────────────────────────────

/**
 * Tables that have a *_id column but no FK constraint on it.
 * Detects referential correctness gaps created when the AI builds relations
 * without explicitly wiring up FOREIGN KEY constraints.
 */
/**
 * Fail a probe loudly when its catalog query cannot run.
 *
 * Every probe below previously ended its query with `.catch(() => ({ rows: [] }))`,
 * which turns "I could not look" into "I looked and found nothing". That is the
 * precise defect that killed detectMissingRls: a duplicate bind parameter made
 * the query throw, the catch swallowed it, the probe reported no findings in
 * every environment, and the dashboard rendered green for months while the
 * flagship security check was dead.
 *
 * Throwing instead is safe and correct here: computeDesiredStateDiff runs every
 * probe under Promise.allSettled, isolates the rejection, records it in
 * `errors`, and marks the invariant UNSATISFIED — because unknown state is not
 * the same as healthy. A loud failure degrades one invariant; a silent one
 * fakes confidence across the whole report.
 */
/**
 * Exported so probes outside this file share ONE definition of "a probe that
 * could not look must not report nothing found". Copying it would let the two
 * drift, and the copy that quietly returned [] is exactly the bug this exists
 * to prevent.
 */
export function probeQueryFailed(probe: string): (err: unknown) => never {
  return (err) => {
    throw new Error(
      `[${probe}] catalog query failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function detectFkColumnsMissingConstraints(
  projectId: string,
): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`
  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = $1
      AND c.column_name LIKE '%_id'
      AND c.column_name <> 'id'
      AND ${notReservedTableSql('c.table_name')}
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema   = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema    = $1
          AND tc.table_name      = c.table_name
          AND kcu.column_name    = c.column_name
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema   = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema    = $1
          AND tc.table_name      = c.table_name
          AND kcu.column_name    = c.column_name
      )
    ORDER BY c.table_name, c.column_name
    `,
    schema,
  ).catch(probeQueryFailed('detectFkColumnsMissingConstraints'))

  const hits: Array<{ table_name: string; column_name: string }> =
    rows?.rows ?? rows ?? []

  if (hits.length === 0) return []

  // Infer the referenced table for each hit so the fix is deterministic and the
  // auto-fix engine can complete it without guessing. Build the table-name map
  // once and reuse it across every hit. When a table can be inferred the finding
  // is auto-fixable (the loop adds the FK silently); when it can't, it is left
  // for human review rather than pointed at the wrong table.
  const { buildWorkspaceTableNameMap, resolveReferencedTable } = await import('@/lib/ai/fk-repair')
  const tableMap = await buildWorkspaceTableNameMap(projectId).catch(() => new Map<string, string>())

  // Only flag a *_id column as a missing FK when we can name the table it should
  // reference. A `*_id` column with no resolvable local target is not a missing
  // foreign key — it is almost always an EXTERNAL identifier (stripe_session_id,
  // payment_intent_id) or a POLYMORPHIC reference (entity_id, subject_id). We
  // used to emit these anyway with autoFixable:false; since missing_fk became
  // auto-safe, the loop then tried to fix them and the executor correctly
  // refused ("no matching table found"), leaving a permanent false-positive
  // stuck in the review queue that nothing could ever resolve. The resolver
  // already covers plural/exact/role (sellerId→users)/self-ref/`_user` shapes,
  // so an unresolved column is real evidence it is not a foreign key at all.
  return hits.flatMap((r) => {
    const referencedTable = resolveReferencedTable(r.column_name, tableMap, r.table_name) ?? undefined
    if (!referencedTable) return []
    return [{
      type: 'missing_fk' as const,
      severity: 'warning' as const,
      details: {
        tableName: r.table_name,
        columnName: r.column_name,
        schemaName: schema,
        referencedTable,
        referencedColumn: 'id',
        reason: `Column "${r.column_name}" references "${referencedTable}" but has no FK constraint`,
      },
      autoFixable: true,
    }]
  })
}

/**
 * Tables that exist in PostgreSQL but have no generated REST API.
 *
 * NO LONGER A GAP — returns no findings. Kept exported so the observer's
 * detector list and the missing_api_definition classifier entries stay valid
 * until that vocabulary is retired in its own pass.
 *
 * This probe has been round-tripped twice, so the reasoning is worth keeping.
 * It was stubbed once as "obsolete under catalog auto-exposure", then revived
 * because it was the exact check that would have caught a real defect:
 * create_table installed a table with its RLS and realtime triggers but never
 * wrote an ApiDefinition, so list_apis answered "You don't have any APIs yet"
 * on a backend full of working tables.
 *
 * The revival diagnosed the right incident and blamed the wrong layer. Nothing
 * about reachability was broken — those tables were queryable the whole time.
 * What was broken was list_apis reading a stored projection instead of the
 * catalog, so it disagreed with the runtime. That has now been fixed at the
 * source (executeListAPIs reads listExposedTables), and executeGenerateAPI no
 * longer writes ApiDefinition rows at all.
 *
 * With the writes gone this probe would flag every table on every healthy
 * project, forever. Exposure is a question for the catalog and the grants —
 * see lib/postgrest/exposure.ts, which is what actually decides.
 */
export async function detectTablesWithNoApiDefinition(
  _projectId: string,
): Promise<RawFinding[]> {
  return []
}

/**
 * Detect columns that were added directly to the database without going through
 * the AI (shadow mutations). Compares the latest post_migration snapshot against
 * the live schema and flags new columns that appeared outside the AI pipeline.
 */
export async function detectShadowMutations(
  projectId: string,
): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  const snapshots = await listSchemaSnapshots(projectId, 5).catch(() => [])
  const lastAiSnapshot = snapshots.find(
    (s) => s.trigger === 'post_migration' || s.trigger === 'build_complete',
  )
  if (!lastAiSnapshot) return []

  const historic = await getSchemaSnapshot(projectId, lastAiSnapshot.versionNum).catch(() => null)
  if (!historic) return []

  const liveRows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    WHERE c.table_schema = $1
      AND ${notReservedTableSql('c.table_name')}
    ORDER BY c.table_name, c.ordinal_position
    `,
    schema,
  ).catch(probeQueryFailed('detectShadowMutations'))

  const live: Array<{ table_name: string; column_name: string; data_type: string }> =
    liveRows?.rows ?? liveRows ?? []

  // Build snapshot column set: tableName:columnName
  const snapshotCols = new Set<string>()
  for (const t of historic.tables) {
    for (const c of t.columns) {
      snapshotCols.add(`${t.name}:${c.name}`)
    }
  }

  const findings: RawFinding[] = []
  // Group shadow columns by table
  const byTable = new Map<string, string[]>()
  for (const row of live) {
    if (!snapshotCols.has(`${row.table_name}:${row.column_name}`)) {
      const cols = byTable.get(row.table_name) ?? []
      cols.push(row.column_name)
      byTable.set(row.table_name, cols)
    }
  }

  for (const [tableName, columns] of byTable) {
    findings.push({
      type: 'shadow_mutation' as const,
      severity: 'warning' as const,
      details: {
        tableName,
        shadowColumns: columns,
        comparedToSnapshotVersion: lastAiSnapshot.versionNum,
        reason: `${columns.length} column(s) added to "${tableName}" outside the AI pipeline`,
      },
      autoFixable: false,
    })
  }

  return findings
}

/**
 * FK-pattern columns (*_id, not primary key) that have no index.
 * Missing indexes on FK columns cause full-table scans on joins — performance risk.
 */
export async function detectMissingFkIndexes(
  projectId: string,
): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = $1
      AND c.column_name LIKE '%_id'
      AND c.column_name <> 'id'
      AND ${notReservedTableSql('c.table_name')}
      AND NOT EXISTS (
        SELECT 1
        FROM pg_indexes pi
        WHERE pi.schemaname = $1
          AND pi.tablename  = c.table_name
          AND pi.indexdef   ILIKE '%(' || c.column_name || ')%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema   = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema    = $1
          AND tc.table_name      = c.table_name
          AND kcu.column_name    = c.column_name
      )
    ORDER BY c.table_name, c.column_name
    `,
    schema,
  ).catch(probeQueryFailed('detectMissingFkIndexes'))

  const hits: Array<{ table_name: string; column_name: string }> =
    rows?.rows ?? rows ?? []

  return hits.map((r) => ({
    type: 'missing_fk_index' as const,
    severity: 'info' as const,
    details: {
      tableName: r.table_name,
      columnName: r.column_name,
      schemaName: schema,
      reason: `Column "${r.column_name}" is a likely FK column but has no index — joins will scan the full table`,
    },
    autoFixable: true,
    fix: async () => {
      const idxName = `idx_${r.table_name}_${r.column_name}`
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 63)
      await executeInWorkspaceSchema(
        projectId,
        `CREATE INDEX IF NOT EXISTS "${idxName}" ON {schema}."${r.table_name}" ("${r.column_name}")`,
      )
    },
  }))
}

// ─── Self-Protect — over-permissive RLS ──────────────────────────────────────

/**
 * Tables that have RLS *enabled* but carry a policy whose USING expression is
 * effectively unconditional (NULL or `true`) for SELECT/ALL — i.e. every row
 * is exposed to every caller the policy covers. RLS is on, so it looks
 * protected, but the policy makes it a no-op. This is a common, high-impact
 * misconfiguration that a missing-RLS check cannot catch (RLS *is* enabled).
 *
 * Scoped to tables that have a user/owner column, so tightening to the
 * `own_rows` template is the correct remediation rather than a false positive
 * on intentionally-public lookup tables. Maps to the existing
 * `rls_expression_invalid` type → the kernel already repairs it via
 * SET_PERMISSION(own_rows). Deterministic; no LLM.
 */
export async function detectOverPermissiveRls(
  projectId: string,
): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  const rows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT DISTINCT p.tablename, p.policyname
    FROM pg_policies p
    JOIN pg_class c     ON c.relname = p.tablename
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
    WHERE p.schemaname = $1
      AND c.relrowsecurity
      AND ${notReservedTableSql('p.tablename')}
      AND (p.qual IS NULL OR btrim(lower(p.qual)) IN ('true', '(true)'))
      AND p.cmd IN ('ALL', 'SELECT', '*')
      -- Role scope matters: a USING(true) policy is only an exposure if it
      -- applies to a principal the runtime request path can run as. The
      -- platform's own direct-access pass-throughs (bkn_direct_read/write,
      -- created BY DESIGN in scripts/setup-direct-access.sql, scoped to the
      -- backenly_external group / per-project bkn_% roles) are the owner's own
      -- credential — Supabase-precedent. Flagging them queued an "auto-safe"
      -- repair that could never remove them (correctly!), so every attempt
      -- failed verification and escalated to the human: 9 false approvals in
      -- prod on 2026-07-20. Keep flagging policies that reach PUBLIC (pg
      -- renders polroles = 0 as '{public}') or any non-internal role.
      AND EXISTS (
        SELECT 1 FROM unnest(p.roles) AS pr(role)
        WHERE pr.role <> 'backenly_external'
          AND pr.role NOT LIKE 'bkn\\_%' ESCAPE '\\'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = $1
          AND col.table_name   = p.tablename
          AND col.column_name IN ('user_id', 'userId', 'owner_id')
      )
    ORDER BY p.tablename
    `,
    schema,
  ).catch(probeQueryFailed('detectOverPermissiveRls'))

  const hits: Array<{ tablename: string; policyname: string }> =
    rows?.rows ?? rows ?? []

  // One finding per table (collapse multiple permissive policies).
  const seen = new Set<string>()
  const out: RawFinding[] = []
  for (const r of hits) {
    if (seen.has(r.tablename)) continue
    seen.add(r.tablename)
    out.push({
      type: 'rls_expression_invalid' as const,
      severity: 'warning' as const,
      details: {
        tableName: r.tablename,
        policyName: r.policyname,
        schemaName: schema,
        reason: `RLS is enabled on "${r.tablename}" but a policy exposes every row (USING true) — protection is effectively off`,
      },
      autoFixable: true,
    })
  }
  return out
}

// ─── 3.2 Auth Integrity ───────────────────────────────────────────────────────

/**
 * Runs all auth integrity checks for a project and returns findings.
 *
 * Checks:
 *  - jwtSecret present on the project
 *  - users table exists in workspace DB when jwtSecret is set
 *  - OAuth providers have redirectUri configured
 *  - PermissionPolicy USING expressions reference current_user_id (not a stale pattern)
 *  - Tables with a user_id column but no PermissionPolicy (unprotected user data)
 */
export async function checkAuthIntegrity(
  projectId: string,
): Promise<RawFinding[]> {
  const findings: RawFinding[] = []

  const project = await prisma.project
    .findUnique({
      where: { id: projectId },
      select: { jwtSecret: true },
    })
    .catch(() => null)

  // Evidence gate: jwtSecret and the users table are both provisioned lazily
  // (bootstrap seeds the secret; the first signup creates the table). Their
  // absence on a project with no auth usage is a provisioning state, not a
  // failure — a fresh empty project must produce zero auth findings.
  const { getEndUserAuthUsage } = await import('@/lib/services/auth-status')
  const usage = await getEndUserAuthUsage(projectId)

  // 1. jwtSecret missing while auth is demonstrably in use — real users (or a
  //    configured auth surface) exist but no token can be signed or verified.
  if (usage.inUse && !project?.jwtSecret) {
    findings.push({
      type: 'auth_jwt_missing',
      severity: 'critical',
      details: { reason: 'Project has no jwtSecret — end-user auth tokens cannot be signed' },
      autoFixable: false,
    })
  }

  // 2. users table missing while auth is configured beyond the platform
  //    defaults (enabled OAuth provider or an enabled policy on users). A
  //    missing table with no such evidence is normal — signup creates it.
  if (!usage.usersTableExists && usage.configuredEvidence) {
    findings.push({
      type: 'auth_users_table_missing',
      severity: 'critical',
      details: {
        reason: 'Auth is configured for this project but the workspace "users" table does not exist',
      },
      autoFixable: false,
    })
  }

  // 3. OAuth providers missing redirect URI
  const oauthConfigs = await prisma.workspaceOAuthConfig
    .findMany({
      where: { projectId, enabled: true },
      select: { provider: true, redirectUri: true, clientId: true },
    })
    .catch(() => [])

  for (const cfg of oauthConfigs) {
    if (!cfg.redirectUri) {
      findings.push({
        type: 'oauth_redirect_uri_missing',
        severity: 'warning',
        details: {
          provider: cfg.provider,
          reason: `OAuth provider "${cfg.provider}" is configured but has no redirect URI — OAuth flow will fail`,
        },
        autoFixable: false,
      })
    }
  }

  // 4. RLS policies with likely broken USING expressions
  const policies = await prisma.permissionPolicy
    .findMany({
      where: { projectId, enabled: true },
      select: { tableName: true, policyName: true, using: true, operation: true },
    })
    .catch(() => [])

  for (const p of policies) {
    if (!p.using) continue
    // The correct pattern references current_user_id (Backenly's session function)
    // Flag policies that reference raw 'auth.uid()' — a foreign dialect, wrong in this stack
    if (p.using.includes('auth.uid()') && !p.using.includes('current_user_id')) {
      findings.push({
        type: 'rls_expression_invalid',
        severity: 'warning',
        details: {
          tableName: p.tableName,
          policyName: p.policyName,
          using: p.using,
          reason: 'RLS USING expression references auth.uid() which is not available in this stack — use current_user_id()',
        },
        autoFixable: false,
      })
    }
  }

  // 5. Tables with user_id column but no PermissionPolicy (unprotected user data)
  const schema = `workspace_${projectId}`
  const userDataRows = await queryWorkspaceSchema(
    projectId,
    `
    SELECT DISTINCT t.tablename
    FROM pg_tables t
    JOIN information_schema.columns c
      ON c.table_schema = $1
      AND c.table_name  = t.tablename
      AND c.column_name IN ('user_id', 'userId', 'owner_id')
    WHERE t.schemaname = $1
      AND ${notReservedTableSql('t.tablename')}
    `,
    schema,
  ).catch(probeQueryFailed('checkAuthIntegrity'))

  const userDataTables: string[] = (userDataRows?.rows ?? userDataRows ?? []).map(
    (r: any) => r.tablename,
  )

  const protectedTables = new Set(policies.map((p) => p.tableName))

  for (const tableName of userDataTables) {
    if (!protectedTables.has(tableName)) {
      findings.push({
        type: 'unprotected_user_data',
        severity: 'critical',
        details: {
          tableName,
          reason: `Table "${tableName}" stores user data (has user_id column) but has no RLS permission policy`,
        },
        autoFixable: false,
      })
    }
  }

  return findings
}

// ─── 3.5 API Coverage ────────────────────────────────────────────────────────

const REQUIRED_CRUD = ['list', 'get', 'create', 'update', 'delete'] as const

/**
 * Check that every table has a complete CRUD ApiDefinition, that no endpoint
 * references a table that no longer exists, that public endpoints have rate
 * limits, and that tables with AppTriggers have realtime-ready configuration.
 */
export async function detectApiCoverageGaps(
  projectId: string,
): Promise<RawFinding[]> {
  const findings: RawFinding[] = []

  type ApiDefRow = {
    id: string
    basePath: string
    name: string
    authRequired: boolean
    rateLimit: number | null
    operations: import('@prisma/client').Prisma.JsonValue
    table: { name: string }
  }

  const [apiDefs, triggers, tables] = await Promise.all([
    prisma.apiDefinition
      .findMany({
        where: { projectId },
        select: {
          id: true,
          basePath: true,
          name: true,
          authRequired: true,
          rateLimit: true,
          operations: true,
          table: { select: { name: true } },
        },
      })
      .catch(() => [] as ApiDefRow[]),
    prisma.appTrigger
      .findMany({
        where: { projectId, enabled: true },
        select: { sourceTable: true },
      })
      .catch(() => [] as Array<{ sourceTable: string }>),
    prisma.table
      .findMany({ where: { projectId }, select: { name: true } })
      .catch(() => [] as Array<{ name: string }>),
  ])

  // Reserved internal tables are not product surface — never flag them for
  // dead-endpoint / missing-CRUD / realtime-gap findings (they carry their own
  // specialized handling and must stay invisible to the API layer).
  const registeredTableNames = new Set(
    tables.map((t) => t.name).filter((n) => !isReservedWorkspaceTable(n)),
  )
  const apiDefByTable = new Map(
    apiDefs.filter((d) => !isReservedWorkspaceTable(d.table.name)).map((d) => [d.table.name, d]),
  )
  const triggerTables = new Set(
    triggers.map((t) => t.sourceTable).filter((n) => !isReservedWorkspaceTable(n)),
  )

  // 1. Tables with no CRUD endpoint coverage
  for (const [tableName, def] of apiDefByTable) {
    const ops = def.operations as Record<string, unknown> | null
    if (!ops) continue

    const opsNorm = normaliseOps(ops)
    const missingOps = REQUIRED_CRUD.filter((op) => !opsNorm.has(op))
    if (missingOps.length > 0) {
      findings.push({
        type: 'missing_api_crud',
        severity: 'warning',
        details: {
          tableName,
          missingOperations: missingOps,
          reason: `Table "${tableName}" is missing API operations: ${missingOps.join(', ')}`,
        },
        autoFixable: false,
      })
    }
  }

  // 2. Tables with no ApiDefinition at all (catches tables that also have no ops)
  for (const tableName of registeredTableNames) {
    if (!apiDefByTable.has(tableName)) {
      // Already covered by detectTablesWithNoApiDefinition — skip to avoid duplication
    }
  }

  // 3. Dead endpoints — ApiDefinition for a table that no longer exists in the platform
  for (const def of apiDefs) {
    const tableName = def.table.name
    if (isReservedWorkspaceTable(tableName)) continue // reserved tables are excluded from registeredTableNames by design — not "dead"
    if (!registeredTableNames.has(tableName)) {
      findings.push({
        type: 'dead_api_endpoint',
        severity: 'warning',
        details: {
          apiDefinitionId: def.id,
          tableName,
          basePath: def.basePath,
          reason: `API definition "${def.name}" references table "${tableName}" which no longer exists`,
        },
        autoFixable: false,
      })
    }
  }

  // 4. (removed 2026-07-21) Public endpoints without a rate limit.
  //
  // Read `ApiDefinition.rateLimit`, a column no request path consults. Rate
  // limiting is per API key (enforceRateLimitByKeyId), and `ApiKey.rateLimit`
  // is `Int @default(1000)` — it cannot be unset, so an "unlimited public
  // endpoint" is not a state this system can be in. Reporting it anyway meant
  // a permanent warning per table describing a risk that did not exist.
  // The sibling detector in lib/autonomy/invariant-probes.ts is gone for the
  // same reason; the note there has the full account.

  // 5. Tables with triggers but no ApiDefinition (realtime events will fire but clients
  //    cannot subscribe via the SDK since there's no endpoint to attach to)
  for (const triggerTable of triggerTables) {
    if (!apiDefByTable.has(triggerTable)) {
      findings.push({
        type: 'realtime_gap',
        severity: 'info',
        details: {
          tableName: triggerTable,
          reason: `Table "${triggerTable}" has active triggers but no API definition — realtime events fire but clients cannot subscribe`,
        },
        autoFixable: false,
      })
    }
  }

  return findings
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseOps(ops: Record<string, unknown>): Set<string> {
  const out = new Set<string>()
  // Handle array form: ['list', 'get', 'create', 'update', 'delete']
  if (Array.isArray(ops)) {
    for (const v of ops) typeof v === 'string' && out.add(v.toLowerCase())
    return out
  }
  // Handle object form: { list: true, GET: true, POST: '/posts', ... }
  for (const [k, v] of Object.entries(ops)) {
    if (v) out.add(k.toLowerCase())
  }
  // Map HTTP methods → CRUD names
  if (out.has('get')) out.add('list')
  if (out.has('post')) out.add('create')
  if (out.has('patch') || out.has('put')) out.add('update')
  if (out.has('delete')) out.add('delete')
  return out
}
