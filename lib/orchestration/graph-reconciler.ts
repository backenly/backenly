/**
 * GRAPH RECONCILER — makes "Rollback to this version" real instead of a
 * pointer-only placeholder.
 *
 * lib/orchestration/graph-pointer.ts's undoToGraph() only swaps
 * Project.activeGraphId — it never touches the live workspace schema,
 * ApiDefinition rows, or StorageBucket rows. Wiring the existing
 * VersionHistory UI up to that alone would ship a rollback button that lies
 * about what it does.
 *
 * This module is deliberately ADDITIVE ONLY: it creates whatever a target
 * version's graph says should exist but is currently missing (tables,
 * columns, APIs, storage buckets, base email/JWT auth). It never drops or
 * deletes a resource added after the target version — deleting resources
 * safely needs its own per-resource confirmation gate and is a follow-up.
 *
 * Scope cut, on purpose: OAuth providers (google/github/...) are not
 * restored — BackendStateGraph.auth.providers only stores an `enabled` flag,
 * never the client id/secret ADD_PROVIDER requires, so attempting it would
 * either fail loudly (harmless) or, worse, invite guessing credentials. Jobs
 * (AiFunction) are not restored either — JobState.handler is a free-text
 * description, not the generated function code, so reconstructing it would
 * fabricate a function body instead of restoring one. Both are called out in
 * the result so the UI can be honest about what did and didn't come back.
 */

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { resolveWorkspaceTables, resolveTableStructure } from '@/lib/services/workspace-schema-resolver'
import type { BackendStateGraph, FieldState } from './backend-state-graph'

export interface ReconcileItemResult {
  kind: 'table' | 'column' | 'api' | 'bucket' | 'auth'
  target: string
  outcome: 'created' | 'failed' | 'skipped'
  message?: string
}

export interface ReconcileResult {
  restored: ReconcileItemResult[]
  /** Resources the target version references that this pass deliberately does not restore. */
  notRestored: Array<{ kind: 'oauth_provider' | 'function'; target: string; reason: string }>
}

function columnTypeForField(field: FieldState): string {
  const type = (field.type || 'string').toLowerCase()
  if (type === 'number') return 'INTEGER'
  if (type === 'boolean') return 'BOOLEAN'
  if (type === 'date') return 'TIMESTAMP'
  return 'TEXT'
}

/**
 * Bring the live workspace (schema, APIs, storage, base auth) up to at least
 * what `targetGraph` describes. Never removes anything. Every item is
 * attempted independently — one failure does not abort the rest.
 */
export async function reconcileWorkspaceToGraph(
  projectId: string,
  targetGraph: BackendStateGraph,
): Promise<ReconcileResult> {
  const restored: ReconcileItemResult[] = []
  const notRestored: ReconcileResult['notRestored'] = []

  const liveTables = await resolveWorkspaceTables(projectId).catch(() => null)
  const liveTableNames = new Set((liveTables?.tables ?? []).filter(t => t.exists).map(t => t.name))

  // ── Tables + columns ───────────────────────────────────────────────────
  for (const [tableName, entity] of Object.entries(targetGraph.entities ?? {})) {
    const fields = Object.values(entity.fields ?? {})

    if (!liveTableNames.has(tableName)) {
      const result = await executeAction(
        {
          action: 'CREATE_TABLE',
          params: {
            tableName,
            columns: fields.map(f => ({ name: f.name, type: columnTypeForField(f) })),
          },
        },
        projectId,
      ).catch(err => ({ success: false, message: err?.message ?? 'CREATE_TABLE failed' }))

      restored.push({
        kind: 'table',
        target: tableName,
        outcome: result.success ? 'created' : 'failed',
        message: result.message,
      })
      continue
    }

    // Table exists live — restore any missing columns.
    const liveColumns = await resolveTableStructure(projectId, tableName).catch(() => null)
    const liveColumnNames = new Set((liveColumns ?? []).map(c => c.name))

    for (const field of fields) {
      if (liveColumnNames.has(field.name)) continue

      const result = await executeAction(
        {
          action: 'ADD_COLUMN',
          params: { tableName, columnName: field.name, columnType: columnTypeForField(field) },
        },
        projectId,
      ).catch(err => ({ success: false, message: err?.message ?? 'ADD_COLUMN failed' }))

      restored.push({
        kind: 'column',
        target: `${tableName}.${field.name}`,
        outcome: result.success ? 'created' : 'failed',
        message: result.message,
      })
    }
  }

  // ── APIs ────────────────────────────────────────────────────────────────
  for (const api of Object.values(targetGraph.apis ?? {})) {
    const tableName = api.path.replace(/^\//, '').split('/')[0]
    if (!tableName) continue

    const table = await prisma.table.findFirst({
      where: { projectId, name: tableName },
      select: { apiDefinition: { select: { id: true } } },
    }).catch(() => null)

    if (table?.apiDefinition) continue

    const result = await executeAction(
      { action: 'GENERATE_API', params: { tableName } },
      projectId,
    ).catch(err => ({ success: false, message: err?.message ?? 'GENERATE_API failed' }))

    restored.push({
      kind: 'api',
      target: api.path,
      outcome: result.success ? 'created' : 'failed',
      message: result.message,
    })
  }

  // ── Storage buckets ─────────────────────────────────────────────────────
  for (const bucket of Object.values(targetGraph.storage?.buckets ?? {})) {
    const existing = await prisma.storageBucket.findFirst({
      where: { projectId, name: bucket.name },
      select: { id: true },
    }).catch(() => null)

    if (existing) continue

    const result = await executeAction(
      { action: 'CREATE_BUCKET', params: { bucketName: bucket.name, isPublic: bucket.isPublic } },
      projectId,
    ).catch(err => ({ success: false, message: err?.message ?? 'CREATE_BUCKET failed' }))

    restored.push({
      kind: 'bucket',
      target: bucket.name,
      outcome: result.success ? 'created' : 'failed',
      message: result.message,
    })
  }

  // ── Base email/JWT auth (no secrets required — safe to restore) ─────────
  if (targetGraph.auth?.providers?.email?.enabled) {
    const result = await executeAction({ action: 'ENABLE_AUTH', params: {} }, projectId)
      .catch(err => ({ success: false, message: err?.message ?? 'ENABLE_AUTH failed' }))
    restored.push({
      kind: 'auth',
      target: 'email',
      outcome: result.success ? 'created' : 'failed',
      message: result.message,
    })
  }

  // ── Explicitly not restored ─────────────────────────────────────────────
  for (const [name, provider] of Object.entries(targetGraph.auth?.providers ?? {})) {
    if (name === 'email' || !provider?.enabled) continue
    notRestored.push({
      kind: 'oauth_provider',
      target: name,
      reason: 'OAuth client credentials are not stored in the version history — reconnect this provider manually if needed.',
    })
  }
  for (const job of Object.values(targetGraph.jobs ?? {})) {
    notRestored.push({
      kind: 'function',
      target: job.name,
      reason: 'Function code is not stored in the version history — recreate it from the AI chat if needed.',
    })
  }

  return { restored, notRestored }
}
