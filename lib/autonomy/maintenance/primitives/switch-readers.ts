/**
 * SWITCH READERS — move the readers Backenly wrote, and only those
 * ================================================================
 *
 * The rung after reconciliation demonstrated that source and target agree.
 * It repoints Backenly-authored function code from the source column to the
 * target column, records exactly what it changed, and can put it all back.
 *
 * ── It refuses far more than it rewrites ────────────────────────────────────
 *
 * This edits generated JavaScript by replacing an identifier. That is string
 * surgery on code, and the honest way to do it is to refuse every case where the
 * replacement is not obviously safe rather than to be clever:
 *
 *   - the column name must appear as a whole word, never as a fragment
 *   - the target name must not already appear in the code, or a revert could
 *     not tell which occurrences it introduced
 *   - the count of replacements must equal the count of occurrences that the
 *     inventory saw, or the code changed underneath us
 *
 * A refusal here costs a halted ladder. A wrong rewrite costs a customer's
 * function silently reading a column that does not hold what it expects.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not touch `ApiDefinition` (a tombstone — see ./../readers.ts), does
 * not create views, does not alter grants, and does not drop anything. Every
 * consumer outside `AiFunction.generatedCode` keeps reading the source column,
 * which is a fact the inventory states and this module never contradicts.
 */

import { prisma } from '@/lib/db'
import { columnReferenceCount, inventoryReaders, type ReaderInventory } from '../readers'

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export interface SwitchReadersSpec {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
}

export interface SwitchedReader {
  kind: 'ai_function'
  id: string
  name: string
  replacements: number
  /** The code as it was, so the revert restores bytes rather than re-rewriting. */
  previousCode: string
}

export interface SwitchReadersResult {
  switched: SwitchedReader[]
  /** Readers seen but not switched, each with the reason. */
  skipped: Array<{ id: string; name: string; reason: string }>
  inventory: ReaderInventory
  refusal: string | null
}

function rewrite(code: string, from: string, to: string): { code: string; replacements: number } {
  const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  let replacements = 0
  const out = code.replace(re, () => {
    replacements++
    return to
  })
  return { code: out, replacements }
}

/**
 * Repoint every controllable reader, or refuse.
 *
 * All-or-nothing across the controllable set: a half-switched set is a project
 * where some functions read the new column and some read the old one, which is
 * strictly worse than not having started. Anything that cannot be switched
 * safely makes the whole step refuse.
 */
export async function switchReaders(spec: SwitchReadersSpec): Promise<SwitchReadersResult> {
  const { projectId, table, sourceColumn, targetColumn } = spec
  const inventory = await inventoryReaders(projectId, table, sourceColumn)
  const empty = (refusal: string | null): SwitchReadersResult => ({
    switched: [], skipped: [], inventory, refusal,
  })

  if (![table, sourceColumn, targetColumn].every(x => IDENT.test(x))) {
    return empty('table or column name is not a valid identifier')
  }
  if (sourceColumn === targetColumn) return empty('source and target are the same column')

  /** Everything is decided before anything is written, so a refusal writes nothing. */
  const planned: Array<SwitchedReader & { nextCode: string }> = []
  const skipped: Array<{ id: string; name: string; reason: string }> = []

  for (const reader of inventory.controllable) {
    const fn = await prisma.aiFunction
      .findUnique({ where: { id: reader.id }, select: { id: true, name: true, generatedCode: true } })
      .catch(() => null)
    if (!fn) {
      skipped.push({ id: reader.id, name: reader.name, reason: 'function disappeared between inventory and switch' })
      continue
    }
    const code = fn.generatedCode ?? ''

    // The code moved since the inventory read it. Rewriting it now would be
    // rewriting something nobody looked at.
    if (columnReferenceCount(code, sourceColumn) !== reader.occurrences) {
      skipped.push({ id: fn.id, name: fn.name, reason: 'the function changed since it was inventoried' })
      continue
    }
    // A revert restores recorded bytes, so this is not strictly required — but an
    // existing mention of the target means the function already reads both
    // columns, and that is a situation a person should look at.
    if (columnReferenceCount(code, targetColumn) > 0) {
      skipped.push({ id: fn.id, name: fn.name, reason: `already references ${targetColumn}` })
      continue
    }

    const { code: next, replacements } = rewrite(code, sourceColumn, targetColumn)
    if (replacements !== reader.occurrences) {
      skipped.push({ id: fn.id, name: fn.name, reason: 'replacement count did not match the inventory' })
      continue
    }
    planned.push({ kind: 'ai_function', id: fn.id, name: fn.name, replacements, previousCode: code, nextCode: next })
  }

  if (skipped.length > 0) {
    return {
      switched: [],
      skipped,
      inventory,
      refusal:
        `${skipped.length} controllable reader(s) could not be switched safely ` +
        `(${skipped.map(s => `${s.name}: ${s.reason}`).join('; ')}); ` +
        'switching the rest would leave the project reading two columns at once',
    }
  }

  for (const p of planned) {
    await prisma.aiFunction.update({ where: { id: p.id }, data: { generatedCode: p.nextCode } })
  }

  return {
    switched: planned.map(({ nextCode: _next, ...r }) => r),
    skipped: [],
    inventory,
    refusal: null,
  }
}

/**
 * Put every switched reader back, byte for byte.
 *
 * Restores the recorded previous code rather than rewriting target → source.
 * A reverse rewrite would also rename occurrences that were always the target
 * column, and would silently "succeed" against code that had changed since.
 */
export async function revertReaders(
  switched: SwitchedReader[],
): Promise<{ reverted: number; failures: string[] }> {
  const failures: string[] = []
  let reverted = 0
  for (const r of switched) {
    try {
      await prisma.aiFunction.update({ where: { id: r.id }, data: { generatedCode: r.previousCode } })
      reverted++
    } catch (err) {
      failures.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { reverted, failures }
}
