/**
 * FIX HISTORY (Pillar 5.3)
 * ========================
 * Every HealthFinding that is auto-fixed or user-approved writes a structured
 * CorrectionEvent to the database. The CorrectionEvent model already exists —
 * this service provides the bridge from workspace-observer to that table.
 *
 * Two responsibilities:
 *   1. writeFixHistory — record what was fixed, when, and how
 *   2. checkEscalation — if the same issue type was previously fixed and has
 *      re-appeared, return true so the observer can escalate severity instead
 *      of repeating the same auto-fix loop
 *
 * Also updates graphData.knownIssues via upsertKnownIssue so the AI's context
 * has a record of what problems this project has historically had.
 */

import { prisma } from '@/lib/db/prisma'
import { upsertKnownIssue } from './graph-schema'
import type { FindingType, FindingSeverity, FindingStatus } from '@/lib/core/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FixHistoryEntry {
  findingType: FindingType
  findingSeverity: FindingSeverity
  status: FindingStatus
  details: Record<string, unknown>
  /** Human-readable summary of what was done */
  resolution: string
  /** Was the fix applied automatically (true) or by user action (false)? */
  automatic: boolean
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a fix (auto or user-approved) in CorrectionEvent.
 * Also updates graphData.knownIssues so the AI can see the history.
 * Non-fatal.
 */
export async function writeFixHistory(
  projectId: string,
  entry: FixHistoryEntry,
): Promise<void> {
  try {
    await Promise.all([
      _writeCorrectionEvent(projectId, entry),
      _updateKnownIssues(projectId, entry),
    ])
  } catch (err) {
    console.warn('[FixHistory] writeFixHistory failed (non-fatal):', err)
  }
}

/**
 * Check if THIS SPECIFIC finding was previously fixed for this project and has
 * now re-appeared — in which case the caller escalates it to manual review
 * instead of looping the same auto-fix.
 *
 * Matching is target-aware: for findings that carry a concrete target
 * (tableName / columnName — e.g. missing_fk, missing_rls), a prior fix only
 * counts as a regression when it was the SAME target. Matching on finding TYPE
 * alone was a bug: once any one missing_fk was fixed, every future missing_fk
 * on a totally different table was wrongly flagged "previously fixed but
 * re-appeared" and frozen into the human approval queue (autoFixable=false),
 * where — combined with the approved-fix cooldown dead-end — it could never be
 * resolved. When a finding has no target, we fall back to type-only matching.
 *
 * Returns true if the caller should treat this finding as escalated.
 */
export async function checkEscalation(
  projectId: string,
  findingType: FindingType,
  details?: Record<string, unknown> | null,
): Promise<boolean> {
  try {
    const tableName = details?.tableName as string | undefined
    const columnName = details?.columnName as string | undefined

    const targetFilters: object[] = []
    if (tableName) {
      targetFilters.push({ correctionDetail: { path: ['details', 'tableName'], equals: tableName } })
    }
    if (columnName) {
      targetFilters.push({ correctionDetail: { path: ['details', 'columnName'], equals: columnName } })
    }

    const previousFix = await prisma.correctionEvent.findFirst({
      where: {
        projectId,
        correctionType: { in: ['AI_SELF_CORRECT', 'POST_EXEC_FIX'] },
        correctionDetail: {
          path: ['findingType'],
          equals: findingType,
        },
        // Only treat as a regression when the same concrete target re-appears.
        ...(targetFilters.length > 0 ? { AND: targetFilters } : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    return previousFix !== null
  } catch {
    return false
  }
}

/**
 * Build a human-readable resolution string for a HealthFinding.
 * Called by the observer so the CorrectionEvent has a readable summary.
 */
export function buildResolutionText(
  findingType: FindingType,
  details: Record<string, unknown>,
  automatic: boolean,
): string {
  const who = automatic ? 'Auto-fixed' : 'User resolved'
  const table = details.tableName ? ` on table "${details.tableName}"` : ''

  switch (findingType) {
    case 'missing_rls':
      return `${who}: Applied own_rows RLS policy${table}`
    case 'missing_fk':
      return `${who}: Added FK constraint for column "${details.columnName}"${table}`
    case 'missing_fk_index':
      return `${who}: Created index on FK column "${details.columnName}"${table}`
    case 'api_drift':
      return `${who}: Regenerated API definition${table} — removed stale columns: ${(details.staleColumns as string[] | undefined)?.join(', ') ?? 'unknown'}`
    case 'broken_webhook':
      return `${who}: Webhook trigger fixed for trigger ID "${details.triggerId}"`
    case 'auth_spike':
      return `${who}: Auth spike resolved (${details.errorCount} errors in ${details.windowMinutes}min window)`
    case 'deploy_failure':
      return `${who}: Deployment failure resolved (deployment ${details.deploymentId})`
    case 'orphan_table':
      return `${who}: Orphan table "${details.tableName}" registered in platform`
    case 'auth_jwt_missing':
      return `${who}: JWT secret generated and stored`
    case 'auth_users_table_missing':
      return `${who}: Users table created in workspace schema`
    case 'oauth_redirect_uri_missing':
      return `${who}: Redirect URI configured for OAuth provider "${details.provider}"`
    case 'rls_expression_invalid':
      return `${who}: RLS expression corrected${table} (policy "${details.policyName}")`
    case 'unprotected_user_data':
      return `${who}: Permission policy applied to protect user data${table}`
    case 'missing_api_definition':
      return `${who}: API definition generated${table}`
    case 'shadow_mutation':
      return `${who}: Shadow columns registered in platform${table}: ${(details.shadowColumns as string[] | undefined)?.join(', ') ?? 'unknown'}`
    case 'missing_api_crud':
      return `${who}: Missing CRUD operations added${table}: ${(details.missingOperations as string[] | undefined)?.join(', ') ?? 'unknown'}`
    case 'dead_api_endpoint':
      return `${who}: Dead API endpoint removed (table "${details.tableName}" no longer exists)`
    case 'missing_rate_limit':
      return `${who}: Rate limit applied to public endpoint "${details.basePath}"`
    case 'realtime_gap':
      return `${who}: Realtime subscription endpoint created${table}`
    default:
      return `${who}: ${findingType} finding resolved`
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function _writeCorrectionEvent(
  projectId: string,
  entry: FixHistoryEntry,
): Promise<void> {
  const correctionType = entry.automatic ? 'AI_SELF_CORRECT' : 'POST_EXEC_FIX'

  await prisma.correctionEvent.create({
    data: {
      projectId,
      originalActionType: entry.findingType,
      correctionType,
      correctionDetail: {
        findingType: entry.findingType,
        severity: entry.findingSeverity,
        status: entry.status,
        details: entry.details,
        resolution: entry.resolution,
        automatic: entry.automatic,
      } as any,
      domain: _inferDomain(entry.findingType),
    },
  })
}

async function _updateKnownIssues(
  projectId: string,
  entry: FixHistoryEntry,
): Promise<void> {
  await upsertKnownIssue(projectId, {
    type: entry.findingType,
    tableName: entry.details.tableName as string | undefined,
    status: entry.status === 'auto_fixed' ? 'auto_fixed' : 'open',
    resolution: entry.resolution,
  })
}

function _inferDomain(findingType: FindingType): string {
  if (['missing_rls', 'unprotected_user_data', 'auth_jwt_missing', 'auth_users_table_missing',
       'auth_spike', 'oauth_redirect_uri_missing', 'rls_expression_invalid'].includes(findingType)) {
    return 'security'
  }
  if (['broken_webhook', 'missing_api_definition', 'api_drift', 'missing_api_crud',
       'dead_api_endpoint', 'missing_rate_limit', 'realtime_gap'].includes(findingType)) {
    return 'api'
  }
  if (['missing_fk', 'missing_fk_index', 'shadow_mutation', 'orphan_table'].includes(findingType)) {
    return 'schema'
  }
  if (['deploy_failure'].includes(findingType)) return 'deploy'
  return 'general'
}
