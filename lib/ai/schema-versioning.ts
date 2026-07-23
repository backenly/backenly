/**
 * SCHEMA VERSION HISTORY + ROLLBACK (Gap 8)
 * ==========================================
 * Automatically snapshots the backend graph after each successful execution.
 * Provides "undo" and "rollback to version N" commands.
 *
 * "No way to say 'undo the auth I added yesterday.' Every professional BaaS has this."
 * — This implements it.
 *
 * Storage: BackendGraph model (already in Prisma)
 *   - graphData: JSON snapshot of schema state
 *   - sequenceNumber: auto-incremented version number
 *   - parentId: links to previous version (git-like lineage)
 *   - intentId: what caused this version (links to execution context)
 *
 * Usage:
 *   // After each successful execution:
 *   await snapshotSchema(projectId, 'Added orders table + auth', 'exec-123')
 *
 *   // User types "undo" or "rollback":
 *   await rollbackToLastVersion(projectId)
 *
 *   // User types "show schema versions":
 *   const versions = await listSchemaVersions(projectId)
 */

import { prisma } from '@/lib/db/prisma'

export interface SchemaVersion {
  id: string
  sequenceNumber: number
  description: string
  createdAt: Date
  tableCount: number
  isRollback: boolean
}

export interface SchemaRollbackResult {
  success: boolean
  message: string
  restoredVersion?: number
}

/**
 * Snapshot the current backend state as a new schema version.
 * Called automatically after every successful execution.
 */
export async function snapshotSchema(
  projectId: string,
  description: string,
  executionId?: string,
): Promise<string | null> {
  try {
    // Load current schema state
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        activeGraphId: true,
        authManifest: true,
        activeIntegrations: true,
      },
    })

    // Load tables separately with only safe fields
    const tables = await prisma.table.findMany({
      where: { projectId },
      select: { id: true, name: true },
    })

    if (!project) return null

    // Get current latest version to set parent and sequence number
    // (tables loaded above)
    const latestVersion = await prisma.backendGraph.findFirst({
      where: { projectId },
      orderBy: { sequenceNumber: 'desc' },
      select: { id: true, sequenceNumber: true },
    })

    const nextSeq = (latestVersion?.sequenceNumber ?? 0) + 1
    const parentId = latestVersion?.id ?? null

    const graphData = {
      description,
      snapshotAt: new Date().toISOString(),
      tableCount: tables.length,
      tables,
      authManifest: project.authManifest,
      activeIntegrations: project.activeIntegrations,
      isRollback: false,
    }

    const version = await prisma.backendGraph.create({
      data: {
        projectId,
        graphData,
        sequenceNumber: nextSeq,
        parentId,
        intentId: executionId,
      },
    })

    console.log(`[SchemaVersioning] Snapshot v${nextSeq}: "${description}" (id=${version.id})`)
    return version.id
  } catch (err: any) {
    // Non-fatal — versioning must never block execution
    console.warn('[SchemaVersioning] Snapshot failed (non-fatal):', err?.message)
    return null
  }
}

/**
 * List all schema versions for a project, newest first.
 */
export async function listSchemaVersions(projectId: string): Promise<SchemaVersion[]> {
  try {
    const versions = await prisma.backendGraph.findMany({
      where: { projectId },
      orderBy: { sequenceNumber: 'desc' },
      take: 20,
    })

    return versions.map(v => {
      const data = v.graphData as any
      return {
        id: v.id,
        sequenceNumber: v.sequenceNumber,
        description: data?.description ?? 'Unknown change',
        createdAt: v.createdAt,
        tableCount: data?.tableCount ?? 0,
        isRollback: data?.isRollback ?? false,
      }
    })
  } catch (err: any) {
    console.warn('[SchemaVersioning] listSchemaVersions failed:', err?.message)
    return []
  }
}

/**
 * Format schema versions as a readable list for the AI chat.
 */
export function formatSchemaVersions(versions: SchemaVersion[]): string {
  if (versions.length === 0) {
    return 'No schema versions recorded yet. Versions are saved automatically after each build.'
  }

  const lines = versions.slice(0, 10).map(v => {
    const date = v.createdAt.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
    const rollbackMark = v.isRollback ? ' ↩' : ''
    return `v${v.sequenceNumber} (${date}) — ${v.description}${rollbackMark} [${v.tableCount} table${v.tableCount !== 1 ? 's' : ''}]`
  })

  const remaining = versions.length > 10 ? `\n+${versions.length - 10} earlier versions` : ''
  return `Schema versions (newest first):\n${lines.join('\n')}${remaining}\n\nTo rollback: type "rollback to v3" or "undo last change"`
}

/**
 * Rollback to the previous schema version (undo last change).
 * This restores table structure by re-applying the previous snapshot's state.
 *
 * NOTE: Rollback restores schema metadata (tables/columns recorded in Backenly),
 * but does NOT restore deleted rows. Data preservation requires manual backup.
 */
export async function rollbackToLastVersion(projectId: string): Promise<SchemaRollbackResult> {
  try {
    const versions = await listSchemaVersions(projectId)

    // Need at least 2 versions to roll back
    const nonRollbacks = versions.filter(v => !v.isRollback)
    if (nonRollbacks.length < 2) {
      return {
        success: false,
        message: 'Nothing to rollback to — only one schema version exists.',
      }
    }

    const targetVersion = nonRollbacks[1] // second newest (the one before current)
    return rollbackToVersion(projectId, targetVersion.id)
  } catch (err: any) {
    return { success: false, message: `Rollback failed: ${err?.message}` }
  }
}

/**
 * Rollback to a specific schema version by ID.
 */
export async function rollbackToVersion(
  projectId: string,
  versionId: string,
): Promise<SchemaRollbackResult> {
  try {
    const targetVersion = await prisma.backendGraph.findUnique({
      where: { id: versionId },
    })

    if (!targetVersion || targetVersion.projectId !== projectId) {
      return { success: false, message: 'Version not found.' }
    }

    const data = targetVersion.graphData as Record<string, any>

    // Restore the table structure by removing tables that didn't exist in target version
    const targetTableNames = new Set(((data['tables'] as any[]) ?? []).map((t: any) => t.name as string))
    const currentTables = await prisma.table.findMany({
      where: { projectId },
      select: { id: true, name: true },
    })

    const tablesToRemove = currentTables.filter(t => !targetTableNames.has(t.name))
    let removedCount = 0

    for (const table of tablesToRemove) {
      try {
        // Remove the table record from Backenly (doesn't drop actual DB table)
        await prisma.table.delete({ where: { id: table.id } })
        removedCount++
        console.log(`[Rollback] Removed table record: ${table.name}`)
      } catch {
        // Non-fatal if individual removal fails
      }
    }

    // Restore auth manifest
    if (data['authManifest'] !== undefined) {
      await prisma.project.update({
        where: { id: projectId },
        data: { authManifest: data['authManifest'] },
      })
    }

    // Record this rollback as a new version (for history/undo-undo)
    const rollbackGraphData = {
      description: `Rollback to v${targetVersion.sequenceNumber}: "${data['description']}"`,
      snapshotAt: new Date().toISOString(),
      tableCount: targetTableNames.size,
      tables: data['tables'] ?? [],
      authManifest: data['authManifest'] ?? null,
      activeIntegrations: data['activeIntegrations'] ?? null,
      isRollback: true,
      rolledBackToId: versionId,
    }
    await prisma.backendGraph.create({
      data: {
        projectId,
        graphData: rollbackGraphData,
        sequenceNumber: await getNextSequenceNumber(projectId),
        parentId: versionId,
      },
    })

    const desc = (data.description as string | undefined) || `version ${targetVersion.sequenceNumber}`
    const msg = removedCount > 0
      ? `Rolled back to v${targetVersion.sequenceNumber}: "${desc}". Removed ${removedCount} table${removedCount !== 1 ? 's' : ''} added after that point.`
      : `Rolled back to v${targetVersion.sequenceNumber}: "${desc}". Schema restored.`

    return {
      success: true,
      message: msg,
      restoredVersion: targetVersion.sequenceNumber,
    }
  } catch (err: any) {
    return { success: false, message: `Rollback failed: ${err?.message}` }
  }
}

async function getNextSequenceNumber(projectId: string): Promise<number> {
  const latest = await prisma.backendGraph.findFirst({
    where: { projectId },
    orderBy: { sequenceNumber: 'desc' },
    select: { sequenceNumber: true },
  })
  return (latest?.sequenceNumber ?? 0) + 1
}

/**
 * Detect if a user message is asking to rollback / undo.
 */
export function detectRollbackIntent(message: string): {
  isRollback: boolean
  targetVersion?: number  // If "rollback to v3"
  undoLast?: boolean      // If just "undo"
} {
  const lower = message.toLowerCase().trim()

  // Strip trailing punctuation so "Rollback the last change." matches correctly
  const clean = lower.replace(/[.!?]+$/, '')

  // "undo", "undo last", "undo the last change", "rollback the last schema change"
  if (/^undo(\s+(last|that|the last|it|this))?$/.test(clean) ||
      /^(revert|rollback)\s+(last|that|my last|the last)(\s+\w+)*$/.test(clean) ||
      /^(revert|rollback|undo)[^.!?]*(last|previous|that)[^.!?]*(change|update|version|action|step)?$/.test(clean)) {
    return { isRollback: true, undoLast: true }
  }

  // "rollback to v3", "revert to version 3", "go back to v2"
  const versionMatch = lower.match(/(?:rollback|revert|restore|go back)\s+to\s+v(?:ersion\s*)?(\d+)/i)
  if (versionMatch) {
    return { isRollback: true, targetVersion: parseInt(versionMatch[1]) }
  }

  // "show schema versions", "list versions", "schema history"
  // (not a rollback, but triggers version listing)
  return { isRollback: false }
}

/**
 * Detect if user is asking to show schema history.
 */
export function detectVersionHistoryRequest(message: string): boolean {
  return /\b(show|list|view|see|what are)\s+(?:my\s+)?(?:schema\s+)?versions?\b|\bschema\s+histor|\bversion\s+histor|\bchanges?\s+histor/i.test(message)
}
