// lib/ai/agents/migration-agent.ts
/** Migration specialist agent: runs schema drift detection and surfaces missing tables, columns, type mismatches, and missing indexes. */

import { detectSchemaDrift } from '@/lib/ai/schema-reconciler'
import type { AgentInput, AgentResult, AgentFinding, AgentFix } from './types'
import type { DriftType } from '@/lib/ai/schema-reconciler'

function makeId(): string {
  return `finding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

type SeverityLevel = AgentFinding['severity']

const DRIFT_SEVERITY_MAP: Record<DriftType, SeverityLevel> = {
  missing_table: 'critical',
  missing_column: 'high',
  type_mismatch: 'medium',   // maps from 'warning' in drift report
  missing_index: 'medium',
  extra_table: 'low',
  extra_column: 'low',
  missing_rls: 'high',
}

const DRIFT_CATEGORY_MAP: Record<DriftType, string> = {
  missing_table: 'missing_table',
  missing_column: 'missing_column',
  type_mismatch: 'type_mismatch',
  missing_index: 'missing_index',
  extra_table: 'extra_table',
  extra_column: 'extra_column',
  missing_rls: 'missing_rls',
}

export async function runMigrationAgent(input: AgentInput): Promise<AgentResult> {
  const start = Date.now()
  const findings: AgentFinding[] = []
  const autoFixed: string[] = []

  const { projectId } = input

  try {
    const report = await detectSchemaDrift(projectId)

    if (!report || report.drifts.length === 0) {
      return {
        agentType: 'migration',
        durationMs: Date.now() - start,
        findings,
        autoFixed,
        skipped: report?.drifts.length === 0,
      }
    }

    for (const drift of report.drifts) {
      const severity: SeverityLevel = DRIFT_SEVERITY_MAP[drift.type] ?? 'medium'
      const category = DRIFT_CATEGORY_MAP[drift.type] ?? drift.type

      // Approval: index fixes are auto-fixable; structural changes need user OK
      const requiresApproval = drift.type !== 'missing_index'

      const fix: AgentFix | undefined = drift.migration
        ? {
            description: `Apply migration SQL to resolve ${drift.type} on "${drift.tableName}".`,
            sql: drift.migration,
            reversible: drift.type === 'missing_index', // only additive ops are trivially reversible
            requiresApproval,
          }
        : undefined

      const locationParts = [drift.tableName]
      if (drift.columnName) locationParts.push(drift.columnName)

      findings.push({
        id: makeId(),
        agentType: 'migration',
        category,
        severity,
        title: drift.description,
        description: buildDescription(drift.type, drift),
        location: locationParts.join('.'),
        fix,
      })
    }
  } catch {
    // Never throw — drift detection may fail on unprovisioned workspaces
  }

  return {
    agentType: 'migration',
    durationMs: Date.now() - start,
    findings,
    autoFixed,
    skipped: false,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDescription(
  type: DriftType,
  drift: { tableName: string; columnName?: string; expected?: string; actual?: string; description: string },
): string {
  switch (type) {
    case 'missing_table':
      return `Table "${drift.tableName}" is in the stored schema snapshot but does not exist in the live database. This will cause runtime errors.`
    case 'missing_column':
      return `Column "${drift.columnName}" is missing from table "${drift.tableName}" in the live database. Expected type: ${drift.expected ?? 'unknown'}.`
    case 'type_mismatch':
      return `Column "${drift.columnName}" on "${drift.tableName}" has type "${drift.actual}" in the live DB but "${drift.expected}" in the snapshot. This may cause silent data truncation.`
    case 'missing_index':
      return `Index on "${drift.columnName ?? drift.tableName}" is defined in the snapshot but absent from the live schema, degrading query performance.`
    case 'missing_rls':
      return `Row-Level Security policy for "${drift.tableName}" is recorded in the snapshot but not active on the live table.`
    case 'extra_table':
      return `Table "${drift.tableName}" exists in the live database but is not tracked in the schema snapshot. It may be orphaned.`
    case 'extra_column':
      return `Column "${drift.columnName}" exists in "${drift.tableName}" but is not in the snapshot. It may be a manual addition.`
    default:
      return drift.description
  }
}
