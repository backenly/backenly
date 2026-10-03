/**
 * WHO READS THIS COLUMN — and which of them Backenly can actually move
 * ====================================================================
 *
 * The reader inventory for `switch_readers`. It answers two questions and keeps
 * them apart, because conflating them is the failure this module exists to
 * prevent: *who reads the source column*, and *which of those Backenly
 * controls*.
 *
 * ── The uncomfortable fact about this platform ──────────────────────────────
 *
 * The data plane is PostgREST. A table is reachable because it exists in the
 * catalog and the role holds a grant on it, and **the client chooses the columns
 * in its own request**. There is no stored mapping between "this API" and "this
 * column" for Backenly to flip.
 *
 * So the obvious implementation — switch the generated REST routes — has nothing
 * to switch. `ApiDefinition` looks like it would be that surface and is not: it
 * has had no create path since the PostgREST cutover on 2026-07-21, and
 * `scripts/assert-no-apidefinition-writes.ts` fails the build on new readers of
 * it precisely so nobody rebuilds on top of a tombstone. See
 * `lib/api/exposed-resources.ts`, which records the nine call sites that already
 * got a permanent zero out of that table.
 *
 * What Backenly does control is code Backenly wrote: `AiFunction.generatedCode`.
 * That is the whole controllable set, and it is deliberately small.
 *
 * ── Why the uncontrollable list is the important half ───────────────────────
 *
 * Every REST client, every connection string handed out by direct database
 * access, and every hand-written query reads whatever it likes and tells nobody.
 * They cannot be enumerated, so they are not merely "not switched" — they are
 * *not observable*, and this module says so as a standing fact rather than
 * reporting an empty list.
 *
 * That is the reason `contract` is Tier 3 and human-approved. Dropping the
 * legacy column requires knowing nobody reads it, and on this platform that is
 * not a thing software can establish. A switch here is never "complete", and
 * `coverage` never claims otherwise.
 */

import { prisma } from '@/lib/db'

/** A consumer Backenly can rewrite. */
export interface ControllableReader {
  kind: 'ai_function'
  id: string
  name: string
  /** Where in the code the column is named, for the record. */
  occurrences: number
}

/** A class of consumer Backenly cannot see, let alone move. */
export interface UnobservableReaderClass {
  kind: 'postgrest_client' | 'direct_database_access' | 'hand_written_sql'
  why: string
}

export interface ReaderInventory {
  projectId: string
  table: string
  sourceColumn: string
  controllable: ControllableReader[]
  /**
   * Always non-empty. These are classes, not instances: the point is that the
   * count is unknown, not that it is zero.
   */
  unobservable: UnobservableReaderClass[]
  /**
   * Never 'complete'. Switching every controllable reader still leaves the
   * unobservable classes reading the old column.
   */
  coverage: 'partial' | 'none_controllable'
}

/**
 * The classes of reader this platform structurally cannot enumerate.
 *
 * A constant, not a query. Returning `[]` when a query finds nothing would be
 * the exact confusion between "none" and "cannot see any" that the rest of this
 * codebase spends so much effort refusing to make.
 */
export const UNOBSERVABLE_READERS: readonly UnobservableReaderClass[] = [
  {
    kind: 'postgrest_client',
    why:
      'PostgREST clients select columns in their own requests. Backenly serves the catalog and ' +
      'the grant, and never sees or stores which columns a caller asks for.',
  },
  {
    kind: 'direct_database_access',
    why:
      'Read-only and read-write connection strings are handed out to project owners. Anything ' +
      'holding one queries the table directly, with no Backenly event at all.',
  },
  {
    kind: 'hand_written_sql',
    why:
      'DDL and queries arrive from psql and other clients. The catalog is the source of truth ' +
      'precisely because Backenly is not the only writer to it.',
  },
]

/** Whole-word matches only, so `status` does not match `status_code`. */
export function columnReferenceCount(code: string, column: string): number {
  const re = new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  return (code.match(re) ?? []).length
}

/**
 * Enumerate what can be seen, and state plainly what cannot.
 *
 * Only `status: 'active'` functions are returned as controllable: rewriting an
 * inactive one changes code nothing runs, which would inflate the switch's
 * apparent coverage with work that demonstrates nothing.
 */
export async function inventoryReaders(
  projectId: string,
  table: string,
  sourceColumn: string,
): Promise<ReaderInventory> {
  const functions = await prisma.aiFunction
    .findMany({
      where: { projectId, status: 'active' },
      select: { id: true, name: true, generatedCode: true },
    })
    .catch(() => [] as Array<{ id: string; name: string; generatedCode: string }>)

  const controllable: ControllableReader[] = []
  for (const fn of functions) {
    const occurrences = columnReferenceCount(fn.generatedCode ?? '', sourceColumn)
    if (occurrences > 0) controllable.push({ kind: 'ai_function', id: fn.id, name: fn.name, occurrences })
  }

  return {
    projectId,
    table,
    sourceColumn,
    controllable,
    unobservable: [...UNOBSERVABLE_READERS],
    coverage: controllable.length > 0 ? 'partial' : 'none_controllable',
  }
}

/**
 * One sentence an approval queue can show, that does not overstate the switch.
 *
 * Deliberately leads with what will still be reading the old column.
 */
export function describeCoverage(inv: ReaderInventory): string {
  const n = inv.controllable.length
  return (
    `${n} Backenly-authored reader(s) can be switched. ` +
    `${inv.unobservable.length} class(es) of consumer cannot be enumerated and will keep reading ` +
    `${inv.table}.${inv.sourceColumn}, so the legacy column must not be dropped on the strength of this switch.`
  )
}
