/**
 * Single-tenant FleetScheduler: the fleet is one project.
 *
 * There is nothing to enumerate, so it does not enumerate. It resolves THE
 * project and asks the shared activity gate about that one row.
 *
 * ---- WHY NOT JUST LET THE QUERY RETURN ONE ROW ---------------------------
 *
 * Because it would not. `activeProjectsWhere()` selects every eligible project
 * in the database, and a self-hosted database is not guaranteed to hold only
 * the deployment own project -- a restore, a copied dump, or a Cloud database
 * pointed at by mistake all put extra rows there. The resolver already refuses
 * to operate against that state for exactly this reason. A sweep that scanned
 * instead would heal, measure and log against projects this deployment does
 * not own, silently, on a schedule.
 *
 * ---- THE GATE STILL APPLIES ----------------------------------------------
 *
 * A self-hosted project is not exempt from "is this backend alive". Running
 * the reconciler against an empty project with no tables costs a cycle and can
 * find nothing, in either edition. So the gate is applied to THE project
 * rather than skipped, and the only thing that changed is the set it runs
 * over.
 */
import { prisma } from '@/lib/db'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'
import type { Edition } from '../types'
import type { FleetScheduler, FleetTarget, FleetTargetOptions } from '../fleet-types'
import { theProjectId } from './the-project'

/** THE project id, or null when there is not exactly one to be had. */
async function theProjectOrNull(): Promise<string | null> {
  try {
    return await theProjectId()
  } catch {
    // Not bootstrapped, or ambiguous. A scheduled pass has nothing to do; the
    // request paths still surface the error, where refusing is the safe answer.
    return null
  }
}

export const singleTenantFleetScheduler: FleetScheduler = {
  edition: 'single-tenant' as Edition,

  async activeTargets(options?: FleetTargetOptions): Promise<FleetTarget[]> {
    const id = await theProjectOrNull()
    if (!id) return []

    // The gate, applied to one id. `findFirst` with both clauses rather than a
    // fetch-then-filter, so the eligibility rule stays a single source of truth
    // in SQL instead of being half reimplemented in TypeScript here.
    const target = await prisma.project.findFirst({
      where: { AND: [{ id }, activeProjectsWhere(options?.windowDays)] },
      select: { id: true, userId: true },
    })
    return target ? [target] : []
  },

  async maintenanceTargets(): Promise<FleetTarget[]> {
    const id = await theProjectOrNull()
    if (!id) return []

    // No activity gate: measurement and cleanup apply to a quiet project too.
    // The expiry clause is kept because an expired project is not merely quiet,
    // it is over.
    const target = await prisma.project.findFirst({
      where: { id, expiresAt: null },
      select: { id: true, userId: true },
    })
    return target ? [target] : []
  },
}
