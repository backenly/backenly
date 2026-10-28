/**
 * A REGION'S COPY OF WHAT AUTHORIZES ITS REQUESTS: HOW FRESH IT IS
 * ================================================================
 * The home region delivers each region a copy of its projects' authorization
 * rows with a watermark: every change committed at home before it is in the
 * copy (lib/auth-projection/deliver.ts). A reader trusts the copy only while the
 * watermark is younger than the staleness bound (lib/auth-projection/mode.ts);
 * past it, or with no watermark at all, the copy is not fresh and the reader
 * asks home.
 *
 * Age is measured by the region's database clock against the home database's
 * clock, which AWS keeps in step. A watermark more than a second in this
 * clock's future means the two disagree, and such a copy is not trusted either.
 */

import { regionRawClient } from '@/lib/data-plane/regional'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { authMaxStalenessMs } from '@/lib/auth-projection/mode'

/** How far a watermark may be in the future before the clocks are taken to disagree. */
const CLOCK_TOLERANCE_MS = 1_000

export interface CopyFreshness {
  /** Every change committed at home before this is in the copy; null when it has none. */
  watermarkAt: Date | null
  /** The watermark's age by the region's database clock; null when it has none. */
  ageMs: number | null
  fresh: boolean
}

/** Whether a watermark this old may be trusted: younger than the bound, and not in this clock's future. */
export function isFreshAge(ageMs: number | null, maxStalenessMs: number): boolean {
  return ageMs !== null && ageMs > -CLOCK_TOLERANCE_MS && ageMs < maxStalenessMs
}

export async function copyFreshness(region: CloudRegionId, maxStalenessMs: number = authMaxStalenessMs()): Promise<CopyFreshness> {
  if (region === HOME_REGION) throw new Error('The home region authorizes from the platform database; it keeps no copy.')
  const [state] = await regionRawClient(region).$queryRaw<{ watermarkAt: Date | null; ageMs: number | null }[]>`
    SELECT "watermarkAt",
           (EXTRACT(EPOCH FROM (clock_timestamp() - "watermarkAt")) * 1000)::float8 AS "ageMs"
      FROM public.auth_projection_state
     WHERE "region" = ${region}`
  if (!state || state.watermarkAt === null || state.ageMs === null) return { watermarkAt: null, ageMs: null, fresh: false }
  const ageMs = Number(state.ageMs)
  return { watermarkAt: state.watermarkAt, ageMs, fresh: isFreshAge(ageMs, maxStalenessMs) }
}
