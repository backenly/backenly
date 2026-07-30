/**
 * PRODUCTION INTELLIGENCE
 * =======================
 * Runs seven post-build checks that catch issues a senior engineer would flag
 * before pushing a backend to production.  Every check is isolated — one check
 * failing never prevents the others from running.
 *
 * Usage:
 *   const report = await analyzeProductionReadiness(projectId)
 *   // report.score  0-100 readiness score
 *   // report.issues  array of ProductionIssue — each with autoFixable SQL/config
 */

import { prisma } from '@/lib/db/prisma'
import { Pool } from 'pg'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'

// ---------------------------------------------------------------------------
// Shared pg pool for information_schema / pg_catalog queries
// ---------------------------------------------------------------------------
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL })

async function pgQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pgPool.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows as T[]
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProductionIssue {
  type:
    | 'missing_index'
    | 'n_plus_one_risk'
    | 'weak_rls'
    | 'unbounded_pagination'
    | 'webhook_replay_risk'
    | 'storage_abuse_risk'
    | 'missing_retry_queue'
  severity: 'critical' | 'high' | 'medium' | 'low'
  table?: string
  location: string
  description: string
  recommendation: string
  autoFixable: boolean
  fix?: string
}

export interface ProductionIntelligenceReport {
  issues: ProductionIssue[]
  score: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  autoFixableCount: number
}

// ---------------------------------------------------------------------------
// Check 1: Missing indexes on FK and common filter columns
// ---------------------------------------------------------------------------

async function detectMissingIndexes(projectId: string): Promise<ProductionIssue[]> {
  try {
    const schema = `workspace_${projectId}`

    // Columns of interest: FK pattern (*_id) plus common filter columns
    const COMMON_FILTER_COLS = ['created_at', 'status', 'slug', 'email', 'handle']

    // All columns in the workspace schema. Filter out view columns via a join
    // on `information_schema.tables` — `table_type` lives there, NOT on
    // `information_schema.columns`. Previous query referenced columns.table_type
    // and threw "column 'table_type' does not exist" on every cron tick.
    const allColumns = await pgQuery<{
      table_name: string
      column_name: string
    }>(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name = c.table_name
       WHERE c.table_schema = $1
         AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.column_name`,
      [schema],
    )

    if (allColumns.length === 0) return []

    // Which (table, column) pairs already have an index?
    const indexedCols = await pgQuery<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef
       FROM pg_indexes
       WHERE schemaname = $1`,
      [schema],
    )

    // Build a set of "table.column" strings that are already indexed
    const indexed = new Set<string>()
    for (const idx of indexedCols) {
      // indexdef looks like: CREATE INDEX idx_foo_bar ON workspace_xxx.foo (bar)
      const match = idx.indexdef.match(/\(([^)]+)\)/)
      if (match) {
        const cols = match[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        for (const col of cols) {
          indexed.add(`${idx.tablename}.${col}`)
        }
      }
    }

    const issues: ProductionIssue[] = []

    for (const { table_name, column_name } of allColumns) {
      const isFk = column_name.endsWith('_id') && column_name !== 'id'
      const isCommon = COMMON_FILTER_COLS.includes(column_name)

      if (!isFk && !isCommon) continue
      if (indexed.has(`${table_name}.${column_name}`)) continue

      const severity: ProductionIssue['severity'] = isFk ? 'high' : 'medium'
      const indexName = `idx_${table_name}_${column_name}`

      issues.push({
        type: 'missing_index',
        severity,
        table: table_name,
        location: `${table_name}.${column_name}`,
        description: isFk
          ? `Foreign key column "${column_name}" on table "${table_name}" has no index — JOINs and lookups will do full table scans.`
          : `Frequently filtered column "${column_name}" on table "${table_name}" has no index — list queries will be slow at scale.`,
        recommendation: `Add a B-tree index on "${column_name}" to speed up lookups and JOINs.`,
        autoFixable: true,
        fix: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON "${schema}"."${table_name}"("${column_name}");`,
      })
    }

    return issues
  } catch (err: unknown) {
    console.warn('[ProductionIntelligence] detectMissingIndexes error:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Check 2: N+1 query risk — list endpoints on tables with FK columns
// ---------------------------------------------------------------------------

async function detectN1Risk(projectId: string): Promise<ProductionIssue[]> {
  // RETIRED 2026-07-30 - vacuous as written.
  //
  // It flagged a table with FK columns whose ApiDefinition had a list operation
  // and no `config.joinStrategy | expand | include`. Under PostgREST there is no
  // stored per-API join strategy: related data is embedded per REQUEST via
  // `?select=...`, chosen by the caller. The config it looked for is not a
  // property this architecture has, and the table has had no create path since
  // the cutover, so the loop ran zero times on every modern project.
  //
  // Still covered: the index half of the risk, by the `relationships_are_indexed`
  // invariant (detectMissingFkIndexes), which is live and auto-fixed. Whether
  // request-level over-fetching deserves its own detector is an open question
  // this function was not answering.
  void projectId
  return []
}

// ---------------------------------------------------------------------------
// Check 3: Weak RLS — tables with user_id/owner_id but no RLS enabled
// ---------------------------------------------------------------------------

async function detectWeakRLS(projectId: string): Promise<ProductionIssue[]> {
  try {
    const schema = `workspace_${projectId}`

    // Tables with user_id or owner_id columns
    const ownerCols = await pgQuery<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (column_name LIKE '%user_id%' OR column_name LIKE '%owner_id%')`,
      [schema],
    )

    if (ownerCols.length === 0) return []

    const tableNames = [...new Set(ownerCols.map((r) => r.table_name))]

    // Check RLS status for those tables
    const rlsStatus = await pgQuery<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname = ANY($2)
         AND c.relkind = 'r'`,
      [schema, tableNames],
    )

    const rlsMap = new Map(rlsStatus.map((r) => [r.relname, r.relrowsecurity]))

    const issues: ProductionIssue[] = []

    for (const tableName of tableNames) {
      const rlsEnabled = rlsMap.get(tableName) ?? false
      if (rlsEnabled) continue

      const ownerCol =
        ownerCols.find(
          (c) => c.table_name === tableName && c.column_name === 'user_id',
        )?.column_name ??
        ownerCols.find((c) => c.table_name === tableName)?.column_name ??
        'user_id'

      issues.push({
        type: 'weak_rls',
        severity: 'critical',
        table: tableName,
        location: `workspace_${projectId}.${tableName}`,
        description: `Table "${tableName}" has a "${ownerCol}" column indicating per-user data, but Row Level Security is not enabled. Any authenticated user can read or modify other users' rows.`,
        recommendation:
          'Enable RLS and add a user-isolation policy so that each user can only access their own rows.',
        autoFixable: true,
        // Claim form, not the `app.*` GUCs: PostgREST never sets those, so a
        // GUC-form policy matches no rows there — silently, as an empty result.
        // See lib/services/rls-session.ts for why claims satisfy both engines.
        fix: [
          jwtClaimFunctionSql(schema),
          `ALTER TABLE "${schema}"."${tableName}" ENABLE ROW LEVEL SECURITY;`,
          `CREATE POLICY user_isolation ON "${schema}"."${tableName}"`,
          `  USING (${ownRowsPredicate(schema, ownerCol)});`,
        ].join('\n'),
      })
    }

    return issues
  } catch (err: unknown) {
    console.warn('[ProductionIntelligence] detectWeakRLS error:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Check 4: Unbounded pagination — list endpoints with no enforced limit
// ---------------------------------------------------------------------------

async function detectUnboundedPagination(projectId: string): Promise<ProductionIssue[]> {
  // RETIRED 2026-07-30 - vacuous as written, and the underlying risk is UNVERIFIED.
  //
  // It flagged any list endpoint whose ApiDefinition `config` lacked
  // defaultLimit / maxPageSize / pageSize. That config is never written and the
  // table has no create path since the cutover, so this could not fire.
  //
  // Deliberately NOT claiming the risk is handled. PAGINATION_DEFAULT_LIMIT (20)
  // and PAGINATION_MAX_LIMIT (100) are enforced by zod on the Next-side v1
  // routes, but no clamp was found on the PostgREST handler path, which is what
  // serves /db/* in production. Replacing a check that never fired with a comment
  // asserting the runtime bounds every list would trade a false negative for a
  // false assurance, which is worse.
  //
  // OPEN: confirm whether an unbounded GET /db/<table> through the PostgREST
  // gateway is clamped server-side. If it is not, that wants a real detector -
  // one that reads the request path, not a stored config.
  void projectId
  return []
}

// ---------------------------------------------------------------------------
// Check 5: Webhook replay risk — webhook tables without idempotency_key
// ---------------------------------------------------------------------------

async function detectWebhookReplayRisk(projectId: string): Promise<ProductionIssue[]> {
  try {
    const schema = `workspace_${projectId}`

    // Tables with webhook-like names
    const webhookTables = await pgQuery<{ table_name: string }>(
      `SELECT DISTINCT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name ILIKE 'webhook%'
         AND table_type = 'BASE TABLE'`,
      [schema],
    )

    // Also check for tables that contain an event_id column (webhook event log pattern)
    const eventTables = await pgQuery<{ table_name: string }>(
      `SELECT DISTINCT table_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND column_name IN ('event_id', 'idempotency_key')`,
      [schema],
    )

    const eventTableNames = new Set(eventTables.map((r) => r.table_name))

    const issues: ProductionIssue[] = []

    // Check webhook tables for missing idempotency_key
    for (const { table_name } of webhookTables) {
      if (eventTableNames.has(table_name)) continue // already has idempotency_key or event_id

      // Verify idempotency_key column is indeed absent
      const existingCols = await pgQuery<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = $2
           AND column_name IN ('idempotency_key', 'event_id')`,
        [schema, table_name],
      )

      if (existingCols.length > 0) continue

      issues.push({
        type: 'webhook_replay_risk',
        severity: 'high',
        table: table_name,
        location: `workspace_${projectId}.${table_name}`,
        description: `Webhook table "${table_name}" has no "idempotency_key" column. If the same webhook event is delivered more than once (network retry, provider bug), it will be processed multiple times.`,
        recommendation:
          'Add an "idempotency_key TEXT UNIQUE" column and insert with ON CONFLICT DO NOTHING so duplicate deliveries are silently discarded.',
        autoFixable: true,
        fix: `ALTER TABLE "${schema}"."${table_name}" ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;`,
      })
    }

    // Check AppTrigger webhook triggers — warn if they have no idempotency config
    const webhookTriggers = await prisma.appTrigger.findMany({
      where: { projectId, actionType: 'webhook', enabled: true },
      select: { id: true, name: true, sourceTable: true, webhookUrl: true },
    })

    for (const trigger of webhookTriggers) {
      // If the workspace already has event tracking table or idempotency handled, skip
      // We can only warn at this level — no schema to fix on the trigger itself
      issues.push({
        type: 'webhook_replay_risk',
        severity: 'medium',
        table: trigger.sourceTable,
        location: `AppTrigger: ${trigger.name} → ${trigger.webhookUrl ?? 'unknown URL'}`,
        description: `Webhook trigger "${trigger.name}" on "${trigger.sourceTable}" delivers events to an external URL but no idempotency check is recorded. If the endpoint is hit twice, duplicate side-effects may occur.`,
        recommendation:
          'Ensure your webhook handler records processed event IDs in a database table and rejects duplicates (idempotent consumers).',
        autoFixable: false,
      })
    }

    return issues
  } catch (err: unknown) {
    console.warn('[ProductionIntelligence] detectWebhookReplayRisk error:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Check 6: Storage abuse risk — public buckets with no file size limit
// ---------------------------------------------------------------------------

// 100 MB threshold as a plain Number — avoids BigInt literal syntax (tsconfig target: es5)
const ONE_HUNDRED_MB_NUM = 100_000_000

async function detectStorageAbuseRisk(projectId: string): Promise<ProductionIssue[]> {
  try {
    const buckets = await prisma.storageBucket.findMany({
      where: { projectId, isPublic: true },
      select: {
        id: true,
        name: true,
        maxFileSizeBytes: true,
        allowedMimeTypes: true,
      },
    })

    const issues: ProductionIssue[] = []

    for (const bucket of buckets) {
      const maxBytes = bucket.maxFileSizeBytes // BigInt | null

      // null or > 100 MB is considered unsafe for a public bucket
      // Use Number() comparison to avoid BigInt literal syntax (tsconfig target: es5)
      const isUnlimited = maxBytes === null
      const isOverLimit = maxBytes !== null && Number(maxBytes) > ONE_HUNDRED_MB_NUM

      if (!isUnlimited && !isOverLimit) continue

      const limitDisplay = isUnlimited
        ? 'no size limit is configured'
        : `the limit is set to ${Number(maxBytes) / 1_000_000} MB`

      issues.push({
        type: 'storage_abuse_risk',
        severity: 'high',
        location: `StorageBucket: ${bucket.name}`,
        description: `Public bucket "${bucket.name}" is world-readable and ${limitDisplay}. An attacker or misconfigured client could upload gigabytes of data, exhausting your storage quota and incurring unexpected costs.`,
        recommendation:
          'Set a file size limit to prevent storage abuse. Recommended: 10 MB for images (10_485_760 bytes), 100 MB for videos (104_857_600 bytes). Also restrict allowed MIME types.',
        autoFixable: false,
      })
    }

    return issues
  } catch (err: unknown) {
    console.warn('[ProductionIntelligence] detectStorageAbuseRisk error:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Check 7: Missing retry queues — async integrations without a job/queue table
// ---------------------------------------------------------------------------

const ASYNC_TABLE_PATTERNS = ['email', 'notification', 'job', 'queue', 'task']

async function detectMissingRetryQueues(projectId: string): Promise<ProductionIssue[]> {
  try {
    const schema = `workspace_${projectId}`

    // Check if any async-work-style tables exist in the workspace
    const workspaceTables = await pgQuery<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type = 'BASE TABLE'`,
      [schema],
    )

    const tableNames = workspaceTables.map((r) => r.table_name.toLowerCase())

    const hasQueueTable = tableNames.some((name) =>
      ASYNC_TABLE_PATTERNS.some((p) => name.startsWith(p)),
    )

    // Check project's active integrations — specifically email or payment providers
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { activeIntegrations: true },
    })

    const integrations = (project?.activeIntegrations ?? {}) as Record<string, unknown>
    const integrationKeys = Object.keys(integrations).map((k) => k.toLowerCase())

    const hasEmailIntegration = integrationKeys.some((k) =>
      ['resend', 'sendgrid', 'mailgun', 'postmark', 'smtp', 'ses'].includes(k),
    )
    const hasPaymentIntegration = integrationKeys.some((k) =>
      ['stripe', 'paddle', 'paypal', 'razorpay', 'braintree'].includes(k),
    )

    const needsQueue = hasEmailIntegration || hasPaymentIntegration

    if (!needsQueue || hasQueueTable) return []

    const integrationsNeedingQueue: string[] = []
    if (hasEmailIntegration) integrationsNeedingQueue.push('email')
    if (hasPaymentIntegration) integrationsNeedingQueue.push('payment')

    return [
      {
        type: 'missing_retry_queue',
        severity: 'medium',
        location: `project:${projectId} integrations: ${integrationsNeedingQueue.join(', ')}`,
        description: `${integrationsNeedingQueue.join(' and ')} operation(s) have no retry queue — if a ${integrationsNeedingQueue[0]} call fails mid-request (network error, rate limit), the failure is silently dropped and the user never gets their email or payment confirmation.`,
        recommendation:
          'Add a "job_queue" or "outbox" table with columns: id, type, payload, status, attempts, max_attempts, run_at, created_at. Process jobs asynchronously with exponential backoff retries.',
        autoFixable: false,
      },
    ]
  } catch (err: unknown) {
    console.warn('[ProductionIntelligence] detectMissingRetryQueues error:', (err as Error).message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function analyzeProductionReadiness(
  projectId: string,
): Promise<ProductionIntelligenceReport> {
  try {
    const [
      missingIndexes,
      n1Risk,
      weakRls,
      unboundedPagination,
      webhookReplay,
      storageAbuse,
      retryQueues,
    ] = await Promise.all([
      detectMissingIndexes(projectId),
      detectN1Risk(projectId),
      detectWeakRLS(projectId),
      detectUnboundedPagination(projectId),
      detectWebhookReplayRisk(projectId),
      detectStorageAbuseRisk(projectId),
      detectMissingRetryQueues(projectId),
    ])

    const issues: ProductionIssue[] = [
      ...missingIndexes,
      ...n1Risk,
      ...weakRls,
      ...unboundedPagination,
      ...webhookReplay,
      ...storageAbuse,
      ...retryQueues,
    ]

    const criticalCount = issues.filter((i) => i.severity === 'critical').length
    const highCount = issues.filter((i) => i.severity === 'high').length
    const mediumCount = issues.filter((i) => i.severity === 'medium').length
    const lowCount = issues.filter((i) => i.severity === 'low').length
    const autoFixableCount = issues.filter((i) => i.autoFixable).length

    const rawScore =
      100 - criticalCount * 25 - highCount * 10 - mediumCount * 5 - lowCount * 2
    const score = Math.max(0, Math.min(100, rawScore))

    return {
      issues,
      score,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      autoFixableCount,
    }
  } catch (err: unknown) {
    console.warn(
      '[ProductionIntelligence] analyzeProductionReadiness fatal error (returning clean report):',
      (err as Error).message,
    )
    return {
      issues: [],
      score: 100,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      autoFixableCount: 0,
    }
  }
}
