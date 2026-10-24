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
 * So while a change carries itself out, Backenly's AUTOMATIC repairs leave its
 * table and its new table alone: from the approval until the change is in
 * place (approved, expanding, backfilling, verifying, cutover) and while it is
 * being undone (rolling_back). The finding stays open, and the first pass
 * after the change settles repairs it. A hold needs all three:
 *   - the change carries on by itself (`continuation`: the deployment runs and
 *     schedules changes, and the project's autonomy is not OFF). One that waits
 *     for a person to resume it holds nothing: a repair never waits on a
 *     decision nobody may make, and a security repair least of all;
 *   - the change moved in the last hour: a transition, or a batch of its
 *     backfill. One that stopped moving, an undo that crashed included, holds
 *     nothing;
 *   - the repair is Backenly's own: the auto-fix kernel's for an autonomous
 *     actor (lib/core/auto-fix-engine.ts), asked once the repair is cleared to
 *     run (one that needs a person is still put in front of them) and again
 *     inside the build lock, and the agentic fix loop's
 *     (lib/ai/agentic-fix-loop.ts, applyCandidate). A person's own change,
 *     through any surface, withdraws consent, by design.
 */

import { prisma } from '@/lib/db'
import { normalizeFindingType } from '@/lib/core/types'
import type { LifecycleState } from './lifecycle'
import { readMemory, summarizeDecisions, type DecisionSummary } from './memory'
import { primitiveById } from './primitive'
import './installed'

/** The states in which a change is working on its tables. */
export const HOLDING_STATES: readonly LifecycleState[] = ['approved', 'expanding', 'backfilling', 'verifying', 'cutover', 'rolling_back']

/** How long a change may go without moving before it holds nothing. */
export const HOLD_LAPSES_AFTER_MS = 60 * 60 * 1000

/** The tables a change names in its spec: the table it changes and the one it creates. */
function tablesOf(spec: unknown): string[] {
  const s = (spec ?? {}) as { host?: unknown; satellite?: unknown }
  return [s.host, s.satellite].filter((t): t is string => typeof t === 'string' && t.length > 0)
}

/**
 * The table a finding's repair changes, found the way the repair finds it
 * (lib/core/fix-actions.ts, buildFixAction): `tableName`, then what
 * normalizeFindingType reads (`location`, `table`, a dynamic type's suffix).
 */
export function repairedTable(findingType: string, details: Record<string, unknown>): string | null {
  const named = typeof details.tableName === 'string' && details.tableName ? details.tableName : normalizeFindingType(findingType, details)?.tableName
  return typeof named === 'string' && named.length > 0 ? named : null
}

/** When a change last moved: its latest transition, or the newest batch of its backfill. */
async function lastMoved(projectId: string, d: DecisionSummary): Promise<Date> {
  if (!d.planVersion) return d.updatedAt
  const batch = await prisma.backgroundJob
    .findFirst({
      where: { projectId, type: 'evolution_backfill', payload: { path: ['planVersion'], equals: d.planVersion } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    })
    .catch(() => null)
  return batch && batch.updatedAt > d.updatedAt ? batch.updatedAt : d.updatedAt
}

/** Each table an architecture change is working on now, with the table the change is about. */
export async function tablesHeldByArchitecture(projectId: string, now: Date = new Date()): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  const working = summarizeDecisions(await readMemory(projectId)).filter(d => d.state && HOLDING_STATES.includes(d.state))
  if (working.length === 0) return held
  const { continuation } = await import('./engine')
  if (!(await continuation(projectId)).unattended) return held
  for (const d of working) {
    if (now.getTime() - (await lastMoved(projectId, d)).getTime() > HOLD_LAPSES_AFTER_MS) continue
    const spec = primitiveById(d.primitive)?.normaliseSpec(d.spec) ?? null
    for (const table of tablesOf(spec)) held.set(table, d.subject)
  }
  return held
}

/** Why an automatic repair of `table` waits, or null when nothing holds it. */
export async function architectureHold(projectId: string, table: string | null | undefined, now?: Date): Promise<string | null> {
  if (!table) return null
  // A finding may name the table bare or schema-qualified.
  const bare = table.split('.').pop()!.replace(/"/g, '')
  const subject = (await tablesHeldByArchitecture(projectId, now)).get(bare)
  return subject === undefined ? null : `an architecture change to ${subject} is working on ${bare}; Backenly repairs it once the change is in place`
}
