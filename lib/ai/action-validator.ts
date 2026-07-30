/**
 * ACTION VALIDATOR
 * ================
 * Never claim "Build complete" unless something actually changed.
 *
 * Problem it solves:
 *   The AI says "Done" but the DB is identical to before.
 *   This destroys user trust instantly — nothing kills perceived
 *   intelligence faster than a false success claim.
 *
 * How it works:
 *   1. Take a snapshot of real DB state before the build
 *   2. After the build, compare snapshots
 *   3. If nothing changed → the build was a no-op
 *   4. Override the "success" response with honest guidance
 *
 * Integration point:
 *   Called by the agent-loop stage, wrapping runBuild().
 *   Snapshot before → run → validate after.
 *
 * This is "Missing Piece #3" from the orchestration audit.
 */

import { prisma } from '@/lib/db/prisma'
import { countExposedResources } from '@/lib/api/exposed-resources'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  tableCount: number
  tableNames: string[]
  apiCount: number
  authEnabled: boolean
  authProviders: string[]
  bucketCount: number
  bucketNames: string[]
  integrationCount: number
  integrationNames: string[]
  functionCount: number
  takenAt: string
}

export interface ValidationResult {
  /** True if at least one meaningful resource changed */
  didResourceChange: boolean
  /** True if the executor claimed success */
  executorClaimedSuccess: boolean
  /** The final verdict: was the build actually productive? */
  isGenuineSuccess: boolean
  /** What changed between snapshots */
  changes: {
    tablesAdded: string[]
    tablesRemoved: string[]
    apisAdded: number
    authChanged: boolean
    bucketsAdded: string[]
    integrationsAdded: string[]
  }
  /** Human-readable summary of what changed */
  changeSummary: string
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Captures current project state from real DB.
 * Call this BEFORE running the build.
 */
export async function captureSnapshot(projectId: string): Promise<ProjectSnapshot> {
  const [tables, apis, project, buckets, integrations, functions] = await Promise.allSettled([
    prisma.table.findMany({ where: { projectId }, select: { name: true } }),
    countExposedResources(projectId),
    prisma.project.findUnique({
      where: { id: projectId },
      select: { jwtSecret: true, authManifest: true },
    }),
    prisma.storageBucket.findMany({ where: { projectId }, select: { name: true } }),
    prisma.projectIntegrationKey.findMany({ where: { projectId }, select: { integrationId: true } }),
    prisma.aiFunction.count({ where: { projectId } }),
  ])

  const tableRows = tables.status === 'fulfilled' ? tables.value : []
  const apiCount = apis.status === 'fulfilled' ? apis.value : 0
  const proj = project.status === 'fulfilled' ? project.value : null
  const bucketRows = buckets.status === 'fulfilled' ? buckets.value : []
  const integrationRows = integrations.status === 'fulfilled' ? integrations.value : []
  const fnCount = functions.status === 'fulfilled' ? functions.value : 0

  let authProviders: string[] = []
  try {
    const manifest = proj?.authManifest as Record<string, any> | null
    if (manifest?.providers) {
      authProviders = Object.entries(manifest.providers)
        .filter(([, v]: [string, any]) => v?.enabled)
        .map(([k]) => k)
    }
  } catch {}

  return {
    tableCount: tableRows.length,
    tableNames: tableRows.map(r => r.name),
    apiCount,
    authEnabled: !!(proj?.jwtSecret),
    authProviders,
    bucketCount: bucketRows.length,
    bucketNames: bucketRows.map(r => r.name),
    integrationCount: integrationRows.length,
    integrationNames: integrationRows.map(r => r.integrationId),
    functionCount: fnCount,
    takenAt: new Date().toISOString(),
  }
}

// ── Validator ─────────────────────────────────────────────────────────────────

/**
 * Compares before and after snapshots to determine if the build was genuine.
 *
 * @param before      Snapshot captured before the build
 * @param after       Snapshot captured after the build
 * @param executorClaimedSuccess Whether the executor returned success=true
 */
export async function validateBuild(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  executorClaimedSuccess: boolean,
): Promise<ValidationResult> {
  const tablesAdded = after.tableNames.filter(n => !before.tableNames.includes(n))
  const tablesRemoved = before.tableNames.filter(n => !after.tableNames.includes(n))
  const apisAdded = after.apiCount - before.apiCount
  const authChanged = after.authEnabled !== before.authEnabled ||
    JSON.stringify(after.authProviders.sort()) !== JSON.stringify(before.authProviders.sort())
  const bucketsAdded = after.bucketNames.filter(n => !before.bucketNames.includes(n))
  const integrationsAdded = after.integrationNames.filter(n => !before.integrationNames.includes(n))
  const functionsAdded = after.functionCount - before.functionCount

  const didResourceChange =
    tablesAdded.length > 0 ||
    tablesRemoved.length > 0 ||
    apisAdded > 0 ||
    authChanged ||
    bucketsAdded.length > 0 ||
    integrationsAdded.length > 0 ||
    functionsAdded > 0

  // Build change summary
  const parts: string[] = []
  if (tablesAdded.length > 0) parts.push(`${tablesAdded.join(', ')} ${tablesAdded.length === 1 ? 'table' : 'tables'} created`)
  if (tablesRemoved.length > 0) parts.push(`${tablesRemoved.join(', ')} removed`)
  if (apisAdded > 0) parts.push(`${apisAdded} API endpoint${apisAdded !== 1 ? 's' : ''} generated`)
  if (authChanged) parts.push(`authentication updated`)
  if (bucketsAdded.length > 0) parts.push(`${bucketsAdded.join(', ')} storage configured`)
  if (integrationsAdded.length > 0) parts.push(`${integrationsAdded.join(', ')} integrated`)
  if (functionsAdded > 0) parts.push(`${functionsAdded} function${functionsAdded !== 1 ? 's' : ''} created`)

  const changeSummary = parts.length > 0
    ? parts.join(', ') + '.'
    : 'No backend changes detected.'

  return {
    didResourceChange,
    executorClaimedSuccess,
    isGenuineSuccess: executorClaimedSuccess && didResourceChange,
    changes: {
      tablesAdded,
      tablesRemoved,
      apisAdded: Math.max(0, apisAdded),
      authChanged,
      bucketsAdded,
      integrationsAdded,
    },
    changeSummary,
  }
}

// ── Response overrides ────────────────────────────────────────────────────────

/**
 * Returns an honest override message when the executor claimed success
 * but nothing actually changed in the DB.
 *
 * This prevents false "Build complete" messages.
 */
export function buildNoOpResponse(message: string): string {
  // If the message is already helpful guidance, pass it through
  if (message.length > 30 && !/^done[.!]?$/i.test(message.trim())) {
    return message
  }

  return "I didn't make any changes — your backend is already in the requested state, or I need more detail to act.\n\nTry being specific: 'add a comments table' or 'enable email auth', or type /status to see your current backend."
}

/**
 * Enhances a success message with concrete proof of what changed.
 * Replaces vague "Done." with evidence-based language.
 */
export function enhanceWithProof(
  message: string,
  validation: ValidationResult,
): string {
  if (!validation.didResourceChange) return buildNoOpResponse(message)

  // If the existing message already describes what changed specifically, keep it
  const hasConcrete = /\b(table|api|auth|bucket|function|integration)\b/i.test(message)
  if (hasConcrete && message.length > 20) return message

  // Replace vague success with the actual change summary
  return validation.changeSummary
}
