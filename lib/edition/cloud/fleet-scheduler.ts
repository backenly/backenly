/**
 * Cloud FleetScheduler: the managed estate.
 *
 * A thin adapter, not an implementation. The enumeration lives behind
 * `@cloud/fleet-scheduler`, which resolves to the private overlay on a composed
 * Cloud checkout and to lib/edition/oss/fleet-scheduler.ts otherwise. This file
 * exists so `getFleetScheduler()` has one shape to return in either edition.
 */
import { activeTargets, maintenanceTargets } from '@cloud/fleet-scheduler'
import { skipUnreachable } from '@/lib/autonomy/region-skip'
import type { Edition } from '../types'
import type { FleetScheduler, FleetTarget, FleetTargetOptions } from '../fleet-types'

/**
 * Both lists leave out projects whose region this process cannot reach, and
 * record that they did (lib/autonomy/region-skip.ts): every pass that takes its
 * targets from here would otherwise read those projects as empty or healthy.
 */
export const cloudFleetScheduler: FleetScheduler = {
  edition: 'cloud' as Edition,

  async activeTargets(options?: FleetTargetOptions): Promise<FleetTarget[]> {
    return skipUnreachable(await activeTargets(options), 'fleet-active')
  },

  async maintenanceTargets(): Promise<FleetTarget[]> {
    return skipUnreachable(await maintenanceTargets(), 'fleet-maintenance')
  },
}
