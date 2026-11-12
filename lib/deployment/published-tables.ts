/**
 * THE TABLES A PUBLISH PUTS LIVE
 * ==============================
 * Production QA (2026-11-09), Deploy: "7 tables" before publishing, then
 * "Initial publish with 8 tables". The Deploy page counted the table rows
 * Backenly had registered, the publish counted the backend graph's entities,
 * and Overview counted the project's schema: three answers to one question.
 * A publish serves the schema, and fingerprints it to decide whether anything
 * changed, so that is what both the Deploy page and every publish summary
 * count now, as Overview's Tables card already did: the tables in the
 * project's schema, Backenly's own plumbing left out.
 *
 * The graph keeps entities for tables nobody built yet and for tables since
 * dropped, and an agent's migrations change tables without moving it, which
 * is also why an update's summary used to read "Configuration updated" after
 * a table was added. Updates now compare each table against the last publish.
 */

import crypto from 'crypto'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'

/** The project's own tables in its schema, by name, Backenly's plumbing left out. */
export async function liveTableNames(projectId: string): Promise<string[]> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = ${`workspace_${projectId}`} AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  return rows.map((r) => r.table_name).filter((name) => !isReservedWorkspaceTable(name))
}

/**
 * A short fingerprint of each named table's shape, from the catalog a publish
 * already reads, so the next publish can say which tables changed.
 */
export function tableFingerprints(
  names: readonly string[],
  shapes: ReadonlyArray<{ tableName: string }>,
): Record<string, string> {
  const byName = new Map(shapes.map((t) => [t.tableName, t]))
  return Object.fromEntries(
    names.map((name) => [
      name,
      crypto.createHash('sha256').update(JSON.stringify(byName.get(name) ?? null)).digest('hex').slice(0, 12),
    ]),
  )
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** "orders", "orders and items", "a, b, c and 2 more". */
function named(names: string[]): string {
  if (names.length <= 3) {
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  }
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/** A first publish: "Initial publish with 8 tables". */
export function initialPublishSummary(tableCount: number): string {
  return tableCount > 0 ? `Initial publish with ${counted(tableCount, 'table')}` : 'Initial publish'
}

/**
 * An update, against the tables the last publish recorded: "Added shipments;
 * changed products". A last publish that recorded no tables (one from before
 * they were recorded) cannot be compared with, so the update says how many
 * tables are live instead.
 */
export function updateSummary(previous: unknown, current: Record<string, string>): string {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    return `Backend updated, ${counted(Object.keys(current).length, 'table')} live`
  }
  const prev = previous as Record<string, unknown>
  const added = Object.keys(current).filter((name) => !(name in prev))
  const removed = Object.keys(prev).filter((name) => !(name in current))
  const changed = Object.keys(current).filter((name) => name in prev && prev[name] !== current[name])
  const parts = [
    added.length ? `added ${named(added)}` : null,
    removed.length ? `removed ${named(removed)}` : null,
    changed.length ? `changed ${named(changed)}` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return 'Configuration updated'
  const text = parts.join('; ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
