/**
 * What a change record may quote, for a project kept outside the home region.
 *
 * The change ledger lives on the platform database, in the home region. For a
 * project kept in another region, the platform's records of its work keep the
 * names, kinds, counts and ids of what was done, never the text the work
 * carried (lib/data-plane/residency.ts, founders 2026-10-16):
 *
 *   kept      what the change did to each object (the footprint), the
 *             catalog before and after it (structure: the same class of record
 *             as the workspace schema snapshots), counts and checksums, the
 *             outcome of each check, who and when
 *   withheld  the SQL that ran (a migration's statements can carry values),
 *             each step's free-text summary, the request as written, and any
 *             error message (PostgreSQL fills those with the offending values)
 *
 * The data a change kept is never on a platform row at all: it is in the
 * change's vault, a schema in the project's own database, in its region.
 */

import { NOT_QUOTED, quotedError, quotesKeptHere } from '@/lib/data-plane/residency'
import type { ChangeStep } from './types'
import type { ChangeVerification } from './verify'

export { NOT_QUOTED, quotesKeptHere }

/** An error or reason as the record may keep it. */
export function keptText(text: string, quote: boolean): string {
  return quotedError(text, quote)
}

/** Steps as the record may keep them: what ran and whether it took effect. */
export function keptSteps(steps: ChangeStep[] | null | undefined, quote: boolean): ChangeStep[] | null {
  if (!steps) return null
  if (quote) return steps
  return steps.map((s) => ({ statement: NOT_QUOTED, ...(s.tool ? { tool: s.tool } : {}), ok: s.ok }))
}

/**
 * Checks as the record may keep them. A check Backenly could not run says why
 * in the database's own words, so for a project kept in another region that
 * detail is withheld; every other detail names objects, never values.
 */
export function keptVerification(v: ChangeVerification, quote: boolean): ChangeVerification {
  if (quote) return v
  return { ...v, checks: v.checks.map((c) => (c.outcome === 'inconclusive' ? { ...c, detail: NOT_QUOTED } : c)) }
}
