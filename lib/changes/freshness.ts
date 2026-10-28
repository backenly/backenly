/**
 * Every view of a project's schema, made current once the schema has changed:
 * after a governed change, a recovery, or work the reconciler found settled.
 *
 *   the REST API         PostgREST answers /api/v2 from a schema cache it
 *                        rebuilds only when asked. The region's DDL trigger
 *                        asks for most statements, but not for a table dropped
 *                        or moved into a change's vault, so a removed table
 *                        stayed in the cache. Asked here, on the project's own
 *                        region's database, where its PostgREST listens.
 *   the baseline         the schema reconciler compares the live schema with
 *                        the latest snapshot and re-adds what it reads as
 *                        missing. Measured against a snapshot from before the
 *                        change, it would put back what the change removed.
 *   this process's       caches of table shapes. Other processes' validators
 *   caches               notice a changed table on use (workspace-validator).
 *   row-event capture    the trigger that feeds webhooks and row-event
 *                        functions, kept by its own sync and left out of the
 *                        history (lib/changes/catalog.ts PLATFORM_OBJECTS): a
 *                        table a change or restore brought in gets it here.
 *
 * Each step is best-effort: a view that could not be refreshed is logged, and
 * never fails the change or the restore that already happened.
 */

import { workspaceRawClient } from '@/lib/data-plane/regional'
import { footprintTables } from './diff'
import type { TableChange } from './types'

/** Every table a footprint names, as it was and as it was left. */
export function tablesTouched(footprint: TableChange[]): string[] {
  const { before, after } = footprintTables(footprint)
  return [...new Set([...before, ...after])]
}

function logFailure(projectId: string, what: string, err: unknown): void {
  console.error(`[ChangeFreshness] project=${projectId}: could not refresh ${what}:`, err instanceof Error ? err.message : err)
}

/** Ask the project's REST API to rebuild its schema cache, in the project's region. */
export async function reloadServedSchema(projectId: string): Promise<void> {
  try {
    const db = await workspaceRawClient(projectId)
    // Executed, not queried: pg_notify returns void, which a query cannot read
    // back, so asking for its result failed every time and the cache was never
    // told.
    await db.$executeRawUnsafe(`SELECT pg_notify('pgrst', 'reload schema')`)
  } catch (err) {
    logFailure(projectId, 'the REST API schema cache', err)
  }
}

export async function refreshSchemaViews(projectId: string, tables: Iterable<string>): Promise<void> {
  const names = [...new Set(tables)]

  await reloadServedSchema(projectId)

  try {
    const { invalidateSchemaCache } = await import('@/lib/ai/execution-cache')
    invalidateSchemaCache(projectId)
    const validator = await import('@/lib/services/workspace-validator')
    const stats = await import('@/lib/services/workspace-table-stats')
    for (const t of names) {
      validator.invalidateSchemaCache(projectId, t)
      stats.invalidateTableStats(projectId, t)
    }
  } catch (err) {
    logFailure(projectId, "this process's table caches", err)
  }

  try {
    const { captureSchemaSnapshot } = await import('@/lib/services/workspace-schema-snapshot')
    await captureSchemaSnapshot(projectId, 'post_migration')
  } catch (err) {
    logFailure(projectId, 'the schema baseline', err)
  }

  if (names.length > 0) {
    try {
      const { syncWebhookCaptureIfStale } = await import('@/lib/webhooks/capture')
      await syncWebhookCaptureIfStale(projectId)
    } catch (err) {
      logFailure(projectId, 'row-event capture', err)
    }
  }
}
