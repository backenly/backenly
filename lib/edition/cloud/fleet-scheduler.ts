/**
 * Cloud FleetScheduler: the managed estate.
 *
 * A thin adapter, not an implementation. The enumeration lives behind
 * `@cloud/fleet-scheduler`, which resolves to the private overlay on a composed
 * Cloud checkout and to lib/edition/oss/fleet-scheduler.ts otherwise. This file
 * exists so `getFleetScheduler()` has one shape to return in either edition.
 */
import { activeTargets, maintenanceTargets } from '@cloud/fleet-scheduler'
import type { Edition } from '../types'
import type { FleetScheduler, FleetTarget, FleetTargetOptions } from '../fleet-types'

export const cloudFleetScheduler: FleetScheduler = {
  edition: 'cloud' as Edition,

  async activeTargets(options?: FleetTargetOptions): Promise<FleetTarget[]> {
    return activeTargets(options)
  },

  async maintenanceTargets(): Promise<FleetTarget[]> {
    return maintenanceTargets()
  },
}
