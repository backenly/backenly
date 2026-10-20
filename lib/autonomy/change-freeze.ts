/**
 * THE CHANGE FREEZE DURING AN INCIDENT
 * ====================================
 *
 * While a project is mid-incident (its telemetry reads anomalous), nothing
 * autonomous changes it: mutating a backend that is already failing is how
 * automation makes outages worse. The repair loop has always held its repairs
 * back on such a pass (lib/autonomy/reconciler.ts). Every other path that
 * repairs on its own asks the same question here, so the freeze holds
 * whichever of them would act, and each held pass is recorded the same way:
 * an AUTONOMY_CHANGE_FREEZE row, which the autonomy events feed shows when
 * asked (`include=held`).
 */

import { prisma } from '@/lib/db/prisma'
import { loopPrincipals, principalsToMetadata } from '@/lib/principal'
import { computeHealthSignal } from './telemetry'

/** The Backenly loop that would have acted, for the record. */
export type FreezeLoop = 'reconciler' | 'maintenance'

/**
 * The repair loop's own held pass. It is one of the loop's ticks (lib/autonomy/
 * loop-tick.ts): the pass ran, and repaired nothing.
 */
export const LOOP_HELD = 'AUTONOMY_CHANGE_FREEZE'
/**
 * Another path held back (`via`). Not a tick: read as one, the fix loop's or the
 * function heal's hold would tell the loop's cadence gate the loop had just
 * run, and the console that it had just checked.
 */
export const REPAIR_HELD = 'AUTONOMY_REPAIR_HELD'

/**
 * True when the project is mid-incident, so `wouldHaveApplied` repairs must
 * wait, and the held pass is recorded: as the loop's own (LOOP_HELD), or, with
 * `via`, as the path that asked (REPAIR_HELD). False when they may go ahead. A
 * health signal that cannot be read does not freeze anything, as the loop has
 * always treated it.
 */
export async function heldForIncident(
  projectId: string,
  /** `via` names the path that asked when it is not the loop itself (the agentic fix loop). */
  opts: { loop: FreezeLoop; via?: string; wouldHaveApplied: number },
): Promise<boolean> {
  const health = await computeHealthSignal(projectId).catch(() => null)
  if (health?.state !== 'anomalous') return false
  await prisma.auditLog.create({
    data: {
      projectId,
      action: opts.via ? REPAIR_HELD : LOOP_HELD,
      type: 'autonomy',
      metadata: principalsToMetadata(await loopPrincipals(prisma, projectId, opts.loop)) as any,
      details: JSON.stringify({
        reason: 'project is mid-incident — autonomous changes frozen this tick',
        health: health.reasons,
        wouldHaveApplied: opts.wouldHaveApplied,
        loop: opts.loop,
        ...(opts.via ? { via: opts.via } : {}),
      }),
      timestamp: new Date(),
    },
  }).catch(() => {})
  console.warn(
    `[ChangeFreeze] FROZEN project=${projectId} loop=${opts.loop}${opts.via ? ` via=${opts.via}` : ''} — anomaly active, ` +
      `${opts.wouldHaveApplied} repair(s) deferred. ${health.reasons.join(' ')}`,
  )
  return true
}
