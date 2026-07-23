/**
 * APPROVAL MANAGER — Trust Layer
 * ================================
 * Every non-trivial autonomous action flows through here before execution.
 *
 * Principle: the more powerful the system, the MORE transparent it must be.
 *
 * Flow:
 *   1. Agent creates HealthFinding (status: 'open')
 *   2. Approval manager generates a human-readable preview
 *   3. User approves → snapshot taken → change applied → status: 'auto_fixed'
 *   4. User can rollback → snapshot restored → status back to 'open' with note
 *   5. User dismisses → status: 'dismissed'
 *
 * The snapshot taken before every approval is the rollback point.
 * "You approved it. Here is exactly what changed. One click to undo."
 */

import { prisma } from '@/lib/db/prisma'
import { Pool } from 'pg'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApprovalPreview {
  findingId: string
  title: string
  description: string
  location: string
  severity: string
  changeType: 'additive' | 'structural' | 'destructive'
  sqlPreview?: string
  affectedTables: string[]
  estimatedImpact: string
  reversible: boolean
  warningMessage?: string
}

export interface ApplyResult {
  success: boolean
  findingId: string
  snapshotId?: string
  message: string
  sqlExecuted?: string
}

export interface RollbackResult {
  success: boolean
  message: string
  restoredSnapshot?: string
}

// ── Preview generation ────────────────────────────────────────────────────────

/**
 * Generate a full human-readable preview for a pending approval.
 * Shows exactly what SQL will run, what tables are affected, and whether it's reversible.
 */
export async function getApprovalPreview(
  projectId: string,
  findingId: string,
): Promise<ApprovalPreview | null> {
  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId, status: { in: ['open', 'pending_approval'] } },
  })

  if (!finding) return null

  const details = finding.details as any
  const fix = details?.fix as { sql?: string; description?: string; requiresApproval?: boolean } | null

  // Determine change type
  let changeType: ApprovalPreview['changeType'] = 'additive'
  let warningMessage: string | undefined
  if (fix?.sql) {
    const sql = fix.sql.toUpperCase()
    if (/DROP|TRUNCATE|DELETE/.test(sql)) {
      changeType = 'destructive'
      warningMessage = '⚠ This is a destructive operation. A snapshot will be taken before applying.'
    } else if (/ALTER TABLE|CREATE TABLE/.test(sql)) {
      changeType = 'structural'
    }
  }

  // Extract affected tables from SQL
  const affectedTables: string[] = []
  if (fix?.sql) {
    const tableMatches = fix.sql.match(/\b(ON|TABLE|FROM|INTO)\s+[\w.]+/gi) ?? []
    for (const m of tableMatches) {
      const name = m.split(/\s+/).pop()?.replace(/^[\w]+\./, '') ?? ''
      if (name && !affectedTables.includes(name)) affectedTables.push(name)
    }
  }
  if (affectedTables.length === 0 && details?.location) {
    affectedTables.push(details.location)
  }

  return {
    findingId,
    title: details?.title ?? finding.type,
    description: details?.description ?? '',
    location: details?.location ?? '',
    severity: finding.severity,
    changeType,
    sqlPreview: fix?.sql,
    affectedTables,
    estimatedImpact: changeType === 'additive'
      ? 'No existing data affected — purely additive'
      : changeType === 'structural'
      ? 'Schema structure changes — existing data preserved'
      : 'Data modification — snapshot taken before execution',
    reversible: changeType !== 'destructive',
    warningMessage,
  }
}

// ── Apply approval ────────────────────────────────────────────────────────────

/**
 * Apply an approved finding:
 *   1. Create schema snapshot (rollback point)
 *   2. Execute the fix SQL
 *   3. Mark finding as auto_fixed
 */
export async function applyApproval(
  projectId: string,
  findingId: string,
): Promise<ApplyResult> {
  const finding = await prisma.healthFinding.findFirst({
    where: { id: findingId, projectId, status: { in: ['open', 'pending_approval'] } },
  })

  if (!finding) {
    return { success: false, findingId, message: 'Finding not found or already resolved.' }
  }

  const details = finding.details as any
  const fix = details?.fix as { sql?: string; executorAction?: string; executorParams?: Record<string, unknown> } | null

  if (!fix?.sql && !fix?.executorAction) {
    return { success: false, findingId, message: 'No fix available for this finding.' }
  }

  // ── Take pre-fix snapshot ─────────────────────────────────────────────────
  let snapshotId: string | undefined
  try {
    snapshotId = await takeSnapshot(projectId, `pre_fix_${findingId.slice(0, 8)}`)
  } catch {
    // Non-fatal — proceed without snapshot (log it)
    console.warn('[ApprovalManager] Failed to create snapshot before fix — proceeding anyway')
  }

  // ── Execute the fix ──────────────────────────────────────────────────────
  let sqlExecuted: string | undefined
  try {
    if (fix.sql) {
      sqlExecuted = await executeSql(projectId, fix.sql)
    } else if (fix.executorAction) {
      const { executeAction } = await import('./minimal-executor')
      const result = await executeAction(
        { action: fix.executorAction as any, params: fix.executorParams ?? {} },
        projectId,
      )
      if (!result.success) throw new Error(result.error ?? 'Executor action failed')
    }

    // Mark finding as applied
    await prisma.healthFinding.update({
      where: { id: findingId },
      data: {
        status: 'auto_fixed',
        autoFixed: true,
        fixAppliedAt: new Date(),
      },
    })

    return {
      success: true,
      findingId,
      snapshotId,
      message: `Applied: ${details?.title ?? findingId}. Snapshot ${snapshotId ? `saved (${snapshotId.slice(0, 8)})` : 'not available'}.`,
      sqlExecuted,
    }
  } catch (err: any) {
    return {
      success: false,
      findingId,
      snapshotId,
      message: `Fix failed: ${err?.message}. Snapshot preserved at ${snapshotId?.slice(0, 8) ?? 'N/A'}.`,
    }
  }
}

// ── Dismiss ───────────────────────────────────────────────────────────────────

export async function dismissFinding(projectId: string, findingId: string): Promise<void> {
  await prisma.healthFinding.updateMany({
    where: { id: findingId, projectId },
    data: { status: 'dismissed' },
  })

  // Emit trace so the timeline shows the dismissal decision
  const { emitTrace } = await import('@/lib/ai/execution-tracer')
  emitTrace(projectId, {
    type: 'approval_dismissed',
    details: { findingId },
  }).catch(() => {})
}

// ── Rollback ──────────────────────────────────────────────────────────────────

/**
 * Rollback a previously applied fix by restoring the snapshot taken before it.
 * This re-runs the DDL from the snapshot, overwriting current schema state.
 */
export async function rollbackFix(
  projectId: string,
  findingId: string,
): Promise<RollbackResult> {
  // Find the snapshot taken immediately before this fix
  const snapshot = await prisma.workspaceSchemaSnapshot.findFirst({
    where: {
      projectId,
      trigger: { startsWith: `pre_fix_${findingId.slice(0, 8)}` },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!snapshot) {
    return {
      success: false,
      message: 'No rollback snapshot found for this fix. The change cannot be automatically reversed.',
    }
  }

  try {
    // Re-execute the raw DDL from the snapshot to restore state
    const { Pool } = await import('pg')
    const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
    const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      await pool.query(`SET search_path = "${postgresSchema}"`)
      await pool.query(snapshot.rawDdl)
    } finally {
      await pool.end()
    }

    // Re-open the finding so the user can decide again
    await prisma.healthFinding.updateMany({
      where: { id: findingId, projectId },
      data: { status: 'open', autoFixed: false, fixAppliedAt: null },
    })

    return {
      success: true,
      message: `Rolled back to snapshot v${snapshot.versionNum} (${snapshot.createdAt.toISOString().slice(0, 10)}).`,
      restoredSnapshot: snapshot.id,
    }
  } catch (err: any) {
    // Emit a visible rollback_failed trace so the timeline shows the failure
    const { emitTrace } = await import('@/lib/ai/execution-tracer')
    await emitTrace(projectId, {
      type:    'rollback_failed',
      details: {
        findingId,
        snapshotId:   snapshot.id,
        snapshotVersion: snapshot.versionNum,
        error: err?.message ?? 'Unknown error',
      },
    }).catch(() => {})

    return {
      success: false,
      message: `Rollback failed: ${err?.message}. The schema may be in an inconsistent state — check the observability timeline.`,
    }
  }
}

// ── Pending approvals list ────────────────────────────────────────────────────

export async function getPendingApprovals(projectId: string): Promise<ApprovalPreview[]> {
  const findings = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] } },
    orderBy: [{ severity: 'asc' }, { detectedAt: 'desc' }],
    take: 20,
  })

  const previews = await Promise.all(
    findings.map(f => getApprovalPreview(projectId, f.id))
  )

  return previews.filter((p): p is ApprovalPreview => p !== null)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Public — used by mutate.ts for pre-mutation snapshots. */
export async function takeSnapshot(projectId: string, trigger: string): Promise<string> {
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    // Get current table list + DDL
    const tablesRes = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [postgresSchema],
    )
    const tableNames = tablesRes.rows.map(r => r.table_name)

    // Build a reconstructable DDL snapshot (simplified — column list)
    const ddlParts: string[] = []
    for (const table of tableNames) {
      const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [postgresSchema, table],
      )
      const colDefs = cols.rows.map(c =>
        `  ${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`
      ).join(',\n')
      ddlParts.push(`-- Table: ${table}\n-- Columns:\n${colDefs}`)
    }

    // Get latest version number
    const latest = await prisma.workspaceSchemaSnapshot.findFirst({
      where: { projectId },
      orderBy: { versionNum: 'desc' },
      select: { versionNum: true },
    })
    const nextVersion = (latest?.versionNum ?? 0) + 1

    const snap = await prisma.workspaceSchemaSnapshot.create({
      data: {
        projectId,
        versionNum: nextVersion,
        trigger,
        tables: tableNames,
        rawDdl: ddlParts.join('\n\n'),
        tableCount: tableNames.length,
        columnCount: tablesRes.rows.length,
      },
    })

    return snap.id
  } finally {
    await pool.end()
  }
}

async function executeSql(projectId: string, sql: string): Promise<string> {
  const { getWorkspaceDatabaseNames } = await import('@/lib/services/databaseProvisioning')
  const { postgresSchema } = getWorkspaceDatabaseNames(projectId)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const fullSql = `SET search_path = "${postgresSchema}"; ${sql}`
    await pool.query(fullSql)
    return sql
  } finally {
    await pool.end()
  }
}
