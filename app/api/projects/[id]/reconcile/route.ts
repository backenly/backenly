/**
 * Schema Reconciliation API
 *
 * GET  /api/projects/[id]/reconcile  — detect schema drift, return report
 * POST /api/projects/[id]/reconcile  — detect + optionally apply migrations
 *
 * This is the Continuous Reconciliation surface:
 *   Frontend schema change → backend detects drift → proposes migrations
 *
 * The GET endpoint is safe (read-only). The POST endpoint applies migrations
 * only when { apply: true } is sent — otherwise it's a dry run that returns
 * the migration SQL without executing it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectValidation } from '@/lib/middleware/projectValidation'
import { detectSchemaDrift, applyReconciliationMigrations } from '@/lib/ai/schema-reconciler'

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const report = await detectSchemaDrift(validated.projectId)

    return NextResponse.json({
      projectId: validated.projectId,
      ranAt: report.ranAt,
      snapshotVersion: report.snapshotVersion,
      hasCritical: report.hasCritical,
      hasWarnings: report.hasWarnings,
      driftCount: report.drifts.length,
      drifts: report.drifts,
      migrations: report.migrations,
      summary: report.summary,
    })
  })
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params
  return withProjectValidation<any>(request, async (validated) => {
    const body = await request.json().catch(() => ({}))
    const { apply = false, dryRun = false } = body as { apply?: boolean; dryRun?: boolean }

    // Step 1: detect drift
    const report = await detectSchemaDrift(validated.projectId)

    if (report.migrations.length === 0) {
      return NextResponse.json({
        projectId: validated.projectId,
        status: 'in_sync',
        message: 'Schema is in sync — no migrations needed.',
        report,
      })
    }

    // Step 2: apply if requested
    if (apply || dryRun) {
      const result = await applyReconciliationMigrations(
        validated.projectId,
        report.migrations,
        { dryRun },
      )

      // A table recreated from the snapshot has its columns and none of its
      // rules: it is protected as a new table is (autoApplyRlsIfNeeded), the
      // owner's rows or closed to all but service-role keys.
      const notices: string[] = []
      if (!dryRun) {
        const { autoApplyRlsIfNeeded, rlsNotSetNotice } = await import('@/lib/services/workspace-rls')
        const { existingTables } = await import('@/lib/mcp/apply-migration')
        const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
        const missing = report.drifts.filter((d) => d.type === 'missing_table').map((d) => d.tableName)
        const recreated = await existingTables(validated.projectId, workspaceSchemaName(validated.projectId), missing)
        for (const table of recreated) {
          try {
            const notice = (await autoApplyRlsIfNeeded(validated.projectId, table, [], {}, { closeWhenUndecidable: true })).notice
            if (notice) notices.push(notice)
          } catch (err) {
            notices.push(rlsNotSetNotice(table, err instanceof Error ? err.message : String(err)))
          }
        }
      }

      return NextResponse.json({
        projectId: validated.projectId,
        status: dryRun ? 'dry_run' : (result.failed > 0 ? 'partial' : 'applied'),
        applied: result.applied,
        failed: result.failed,
        errors: result.errors,
        ...(notices.length ? { notices } : {}),
        migrations: report.migrations,
        report,
      })
    }

    // Default: return report without applying
    return NextResponse.json({
      projectId: validated.projectId,
      status: 'drift_detected',
      driftCount: report.drifts.length,
      hasCritical: report.hasCritical,
      migrations: report.migrations,
      report,
      hint: 'Send { apply: true } to execute migrations, or { dryRun: true } to validate syntax only.',
    })
  })
}
