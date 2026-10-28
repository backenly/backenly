/**
 * A REVOCATION IS REPORTED DONE ONLY ONCE THE REGION HAS IT
 * =========================================================
 * A region authorizes its projects' requests from its copy while the copy is
 * fresh (lib/auth-projection/read.ts), so a key revoked at home keeps working
 * there until the delivery that carries the revocation is applied: up to the
 * staleness bound. The founders decided (2026-10-16) that revoking or rotating
 * a key, narrowing it, and locking, pausing or deleting a project each wait for
 * the region to acknowledge the change before reporting success, and that a
 * region that cannot acknowledge within 5 seconds leaves the caller told the
 * change is still pending while it is retried.
 *
 * confirmPropagation is that wait. Called after the change has committed, it
 * delivers to the project's region at once rather than at the next tick, and
 * then waits until every change recorded for the row up to now is delivered
 * there:
 *
 *   not_applicable   nothing was recorded for the row: it belongs to no project
 *                    outside the home region, or home is not delivering copies.
 *                    Home is where it is authorized, so the change already holds
 *   confirmed        the region has applied it
 *   pending          not within the time allowed. The delivery keeps retrying;
 *                    until it lands, the region's copy goes stale within the
 *                    bound and its requests are authorized at home, so the old
 *                    state is honoured for at most the bound in the meantime
 */

import { prisma } from '@/lib/db/prisma'
import { authMaxStalenessMs, authProjectionMode } from '@/lib/auth-projection/mode'
import { deliverRegion } from '@/lib/auth-projection/deliver'
import { findRegion, type CloudRegionId } from '@/lib/regions'

export type PropagatedEntity = 'project' | 'api_key' | 'branch'

export type Propagation =
  | { status: 'not_applicable' }
  | { status: 'confirmed' | 'pending'; regions: CloudRegionId[] }

/** How long a caller waits for the region: the founders' 5 seconds. */
export const PROPAGATION_TIMEOUT_MS = 5_000
const POLL_MS = 200

interface Recorded {
  region: string
  latest: bigint
  pending: bigint | null
}

/**
 * Wait for the region holding this row to apply every change recorded for it
 * so far. Never throws: a failure to confirm is `pending`, which is the truth.
 */
export async function confirmPropagation(
  change: { entity: PropagatedEntity; entityId: string },
  { timeoutMs = PROPAGATION_TIMEOUT_MS, pollMs = POLL_MS }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Propagation> {
  if (authProjectionMode() === 'off') return { status: 'not_applicable' }
  let recorded: Recorded[]
  try {
    recorded = await prisma.$queryRaw<Recorded[]>`
      SELECT "region", max("id") AS "latest", max("id") FILTER (WHERE "deliveredAt" IS NULL) AS "pending"
        FROM "auth_projection_changes"
       WHERE "entity" = ${change.entity} AND "entityId" = ${change.entityId}
       GROUP BY "region"`
  } catch (err) {
    console.error(`[auth-projection] could not read the propagation of ${change.entity} ${change.entityId}:`, describe(err))
    return { status: 'not_applicable' }
  }
  if (recorded.length === 0) return { status: 'not_applicable' }

  const regions = recorded.map((row) => row.region).filter((id): id is CloudRegionId => !!findRegion(id))
  // Only the changes recorded up to now: a later change has its own wait.
  const upTo = new Map(recorded.map((row) => [row.region, row.latest]))
  let waiting = recorded.filter((row) => row.pending !== null).map((row) => row.region as CloudRegionId)
  const deadline = Date.now() + timeoutMs

  while (waiting.length > 0) {
    // Deliver now rather than at the next tick. One already running elsewhere
    // answers busy, and its delivery is waited for below instead.
    await Promise.all(
      waiting.map((region) => deliverRegion(region, { budgetMs: Math.max(0, deadline - Date.now()) }).catch(() => null)),
    )
    waiting = await stillPending(change, waiting, upTo).catch(() => waiting)
    if (waiting.length === 0) break
    if (Date.now() + pollMs >= deadline) return { status: 'pending', regions }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return { status: 'confirmed', regions }
}

/** The regions where a change recorded up to `upTo` is still not delivered. */
async function stillPending(
  change: { entity: PropagatedEntity; entityId: string },
  regions: CloudRegionId[],
  upTo: Map<string, bigint>,
): Promise<CloudRegionId[]> {
  // A change recorded after this wait began does not hold this one up.
  const bounds = regions.map((region) => ({ region, latest: (upTo.get(region) ?? BigInt(0)).toString() }))
  const rows = await prisma.$queryRaw<{ region: string }[]>`
    SELECT DISTINCT c."region" FROM "auth_projection_changes" c
      JOIN jsonb_to_recordset(${JSON.stringify(bounds)}::jsonb) AS u("region" text, "latest" bigint)
        ON u."region" = c."region"
     WHERE c."entity" = ${change.entity} AND c."entityId" = ${change.entityId}
       AND c."deliveredAt" IS NULL AND c."id" <= u."latest"`
  const pending = new Set(rows.map((row) => row.region))
  return regions.filter((region) => pending.has(region))
}

/** A short sentence for an operator or an agent, saying where the change stands. */
export function propagationSentence(propagation: Propagation): string | null {
  if (propagation.status === 'not_applicable') return null
  const where = propagation.regions.join(', ')
  if (propagation.status === 'confirmed') return `Applied in ${where}.`
  const bound = Math.round(authMaxStalenessMs() / 1000)
  return (
    `Not yet confirmed in ${where}; it is being retried. Until it lands, the old state can be ` +
    `honoured there for at most ${bound} seconds after the change, then requests there are checked at home.`
  )
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300)
}
