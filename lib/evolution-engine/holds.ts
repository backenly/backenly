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
 *   - the project's changes moved in the last three hours: a transition of any
 *     change at work, any of their jobs, or a ladder holding the project's lock
 *     now. A project's changes run one at a time, so one waiting its turn
 *     behind another is not stuck; three hours outlasts a scheduler pass and
 *     most incidents (every change waits one out). Changes that stopped moving,
 *     an undo that crashed included, hold nothing;
 *   - the repair is Backenly's own: the auto-fix kernel's for an autonomous
 *     actor (lib/core/auto-fix-engine.ts), asked once the repair is cleared to
 *     run (one that needs a person is still put in front of them) and again
 *     inside the build lock, and the agentic fix loop's
 *     (lib/ai/agentic-fix-loop.ts, applyCandidate). A person's own change,
 *     through any surface, withdraws consent, by design.
 *
 * A repair that names no table may act on every table (EVERY_TABLE_ACTIONS):
 * it waits while any table is held, as does every candidate of the fix loop
 * that names none.
 */

import { prisma } from '@/lib/db'
import { normalizeFindingType } from '@/lib/core/types'
import { maintenanceLockHeld } from '@/lib/autonomy/maintenance/single-flight'
import type { LifecycleState } from './lifecycle'
import { readMemory, summarizeDecisions, type DecisionSummary } from './memory'
import { primitiveById } from './primitive'
import './installed'

/** The states in which a change is working on its tables. */
export const HOLDING_STATES: readonly LifecycleState[] = ['approved', 'expanding', 'backfilling', 'verifying', 'cutover', 'rolling_back']

/** How long a project's changes may all go without moving before they hold nothing. */
export const HOLD_LAPSES_AFTER_MS = 3 * 60 * 60 * 1000

/** Executor actions that, given no table, look for tables to act on (lib/ai/minimal-executor.ts). */
export const EVERY_TABLE_ACTIONS: ReadonlySet<string> = new Set(['FIX_REALTIME', 'ENABLE_REALTIME', 'REGISTER_TABLE', 'FIX_TABLE', 'FIX_AUTH'])

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

/** When the project's changes at work last moved; `now` while a ladder holds the project's lock. */
async function lastMoved(projectId: string, working: DecisionSummary[], now: Date): Promise<Date> {
  if (await maintenanceLockHeld(projectId)) return now
  let latest = working.reduce((t, d) => (d.updatedAt > t ? d.updatedAt : t), new Date(0))
  const job = await prisma.backgroundJob
    .findFirst({ where: { projectId, type: { startsWith: 'evolution_' } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
    .catch(() => null)
  if (job && job.updatedAt > latest) latest = job.updatedAt
  return latest
}

/** Each table an architecture change is working on now, with the table the change is about. */
export async function tablesHeldByArchitecture(projectId: string, now: Date = new Date()): Promise<Map<string, string>> {
  const held = new Map<string, string>()
  const working = summarizeDecisions(await readMemory(projectId)).filter(d => d.state && HOLDING_STATES.includes(d.state))
  if (working.length === 0) return held
  const { continuation } = await import('./engine')
  if (!(await continuation(projectId)).unattended) return held
  if (now.getTime() - (await lastMoved(projectId, working, now)).getTime() > HOLD_LAPSES_AFTER_MS) return held
  for (const d of working) {
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

/**
 * Why an automatic repair waits, or null: one naming a table while that table
 * is held; one naming none while any table is, when its action may act on
 * every table or the caller says every table-less repair waits.
 */
export async function repairHold(
  projectId: string,
  repair: { table: string | null; action: string | null; tablelessWaits?: boolean },
  now?: Date,
): Promise<string | null> {
  if (repair.table) return architectureHold(projectId, repair.table, now)
  if (!repair.tablelessWaits && !(repair.action && EVERY_TABLE_ACTIONS.has(repair.action))) return null
  const [subject] = (await tablesHeldByArchitecture(projectId, now)).values()
  return subject === undefined
    ? null
    : `an architecture change to ${subject} is working on this project's tables, and this repair names none; Backenly repairs it once the change is in place`
}
