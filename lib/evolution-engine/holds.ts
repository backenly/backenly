/**
 * WHAT SELF-HEALING LEAVES ALONE WHILE AN ARCHITECTURE CHANGE IS WORKING
 * =====================================================================
 * An approved change binds consent to its table exactly as it was rehearsed
 * (lib/structural-evolution/facts.ts, basisFingerprint) and checks that before
 * every rung and every backfill batch: a table someone else changed is a
 * different table, and the change stops rather than adapt.
 *
 * That someone can be Backenly. On staging, a new project's first self-healing
 * pass added its own-rows policies to `orders` twenty seconds after the owner
 * approved extracting its refunds, and the backfill stopped with "orders
 * changed shape since the plan was approved": the owner's approval undone by
 * Backenly's own repair, and nothing for them to have done differently.
 *
 * So while a change works on a table, from the approval until it is in place
 * (approved, expanding, backfilling, verifying, cutover) and while it is being
 * undone (rolling_back), Backenly's AUTOMATIC repairs leave that table and the
 * change's new table alone. The finding stays open and the first pass after
 * the change settles repairs it. Nothing else is held:
 *   - a person's own changes, through any surface: a table its owner changes
 *     withdraws consent, by design;
 *   - a change that waits for a person (asking for approval, stopped, failed)
 *     or is already in place: a repair never waits on a decision nobody may
 *     make, and a security repair least of all;
 *   - a deployment that runs no architecture change, where nothing moves.
 *
 * Read by the auto-fix kernel for every autonomous repair
 * (lib/core/auto-fix-engine.ts, runAutoFix).
 */

import { FLAGS, evolutionAllowedFor } from '@/lib/config/flags'
import type { LifecycleState } from './lifecycle'
import { readMemory, summarizeDecisions } from './memory'
import { primitiveById } from './primitive'
import './installed'

/** The states in which a change is working on its tables. */
export const HOLDING_STATES: readonly LifecycleState[] = ['approved', 'expanding', 'backfilling', 'verifying', 'cutover', 'rolling_back']

/** The tables a change names in its spec: the table it changes and the one it creates. */
function tablesOf(spec: unknown): string[] {
  const s = (spec ?? {}) as { host?: unknown; satellite?: unknown }
  return [s.host, s.satellite].filter((t): t is string => typeof t === 'string' && t.length > 0)
}

/** Each table an architecture change is working on now, with the table the change is about. */
export async function tablesHeldByArchitecture(projectId: string): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  if (!FLAGS.ENABLE_EVOLUTION_MUTATIONS || !evolutionAllowedFor(projectId)) return held
  const working = summarizeDecisions(await readMemory(projectId)).filter(d => d.state && HOLDING_STATES.includes(d.state))
  for (const d of working) {
    const spec = primitiveById(d.primitive)?.normaliseSpec(d.spec) ?? null
    for (const table of tablesOf(spec)) held.set(table, d.subject)
  }
  return held
}

/** Why an automatic repair of `table` waits, or null when nothing holds it. */
export async function architectureHold(projectId: string, table: string | null | undefined): Promise<string | null> {
  if (!table) return null
  // A finding may name the table bare or schema-qualified.
  const bare = table.split('.').pop()!.replace(/"/g, '')
  const subject = (await tablesHeldByArchitecture(projectId)).get(bare)
  return subject === undefined ? null : `an architecture change to ${subject} is working on ${bare}; Backenly repairs it once the change is in place`
}
