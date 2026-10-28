/**
 * BACKENLY CLOUD REGIONS
 * ======================
 * The one list of places a Backenly Cloud project can run. The New project
 * dialog, the project card, project settings and the top bar all read it, so a
 * region is named the same way everywhere and opens everywhere at once.
 *
 * Five regions are decided (founders, 2026-10-15). One is open: Mumbai, where
 * Backenly Cloud runs today. The other four are listed so customers can see
 * where Cloud is going, but they cannot be chosen until their AWS stack exists
 * and has passed staging. A region a customer can pick but that does not exist
 * would put their project somewhere other than where they asked.
 *
 * Opening a region is not a flag flip on its own. It ships together with:
 *   - the region's data stack in backenly-infra (database, API runtime,
 *     storage), qualified on staging first;
 *   - every connection to a project's data opened in the project's region
 *     (lib/data-plane/regional.ts), and requests routed there;
 *   - the region's API address handed out for its projects
 *     (PUBLIC_API_ORIGIN_<REGION>, https://<region>.api.backenly.com in
 *     production);
 *   - the Cloud lifecycle creating the project in the chosen region's database
 *     and recording it in Project.region.
 * Until then every project is created in the home region and Project.region
 * stays null, which reads as the home region everywhere. Once all of that is
 * live and the region has qualified, it opens either here, in a release, or on
 * a running deployment through BACKENLY_OPEN_REGIONS (openedRegions below),
 * which is how several regions open at the same moment.
 *
 * Self-hosted deployments do not use this list. They run wherever their
 * operator runs them, and the console says "Self-hosted" instead.
 */

export type CloudRegionId = 'ap-south-1' | 'us-east-1' | 'us-west-2' | 'eu-central-1' | 'ap-southeast-1'

export interface CloudRegion {
  id: CloudRegionId
  /** The place, as customers know it. */
  city: string
  country: string
  /** ISO 3166 code, shown as a small tag. Flag emoji do not render on Windows. */
  countryCode: string
  area: 'Asia Pacific' | 'North America' | 'Europe'
  /** True once the region's stack is live and projects can be created there. */
  open: boolean
}

export const CLOUD_REGIONS: readonly CloudRegion[] = [
  { id: 'ap-south-1', city: 'Mumbai', country: 'India', countryCode: 'IN', area: 'Asia Pacific', open: true },
  { id: 'us-east-1', city: 'N. Virginia', country: 'United States', countryCode: 'US', area: 'North America', open: false },
  { id: 'us-west-2', city: 'Oregon', country: 'United States', countryCode: 'US', area: 'North America', open: false },
  { id: 'eu-central-1', city: 'Frankfurt', country: 'Germany', countryCode: 'DE', area: 'Europe', open: false },
  { id: 'ap-southeast-1', city: 'Singapore', country: 'Singapore', countryCode: 'SG', area: 'Asia Pacific', open: false },
]

/** Where Backenly Cloud runs today, and where every existing project lives. */
export const HOME_REGION: CloudRegionId = 'ap-south-1'

export function findRegion(id: string | null | undefined): CloudRegion | undefined {
  if (!id) return undefined
  return CLOUD_REGIONS.find((region) => region.id === id)
}

/** "Mumbai (ap-south-1)". Unknown or missing ids read as the home region. */
export function regionLabel(id?: string | null): string {
  const region = findRegion(id) ?? findRegion(HOME_REGION)!
  return `${region.city} (${region.id})`
}

export type RegionCheck =
  | { ok: true; region: CloudRegionId }
  | { ok: false; code: 'UNKNOWN_REGION' | 'REGION_NOT_OPEN'; message: string }

type Env = Readonly<Record<string, string | undefined>>

/**
 * The regions a deployment opens to every customer although this build lists
 * them as not open, so the regions qualified for a release open together, by
 * one change of setting once the last of them has passed its go-live checks,
 * instead of by another build (founders, 2026-10-17: all five regions in one
 * coordinated launch).
 *
 * BACKENLY_OPEN_REGIONS is a comma-separated list of region ids. It only adds:
 * a region this build lists as open stays open, and an id this build does not
 * know is ignored. Setting it is the operator's statement that the region's
 * stack is live and qualified; it does not make a region reachable, and a
 * project in a region this deployment has no database for still fails to be
 * created rather than landing elsewhere.
 */
export function openedRegions(env: Env = process.env): ReadonlySet<CloudRegionId> {
  return knownRegions(env.BACKENLY_OPEN_REGIONS)
}

/** Whether every customer of this deployment may create projects in a region. */
export function isOpenToCustomers(id: string, env: Env = process.env): boolean {
  const region = findRegion(id)
  return region !== undefined && (region.open || openedRegions(env).has(region.id))
}

/** The list as this deployment serves it: `open` says what customers may choose here. */
export function regionsAsServed(env: Env = process.env): CloudRegion[] {
  return CLOUD_REGIONS.map((region) => ({ ...region, open: isOpenToCustomers(region.id, env) }))
}

/**
 * The regions a staging deployment opens for project creation although they
 * are not open to customers yet, so a region can be qualified end to end
 * before it opens (a region opens only after its stack passes staging).
 *
 * BACKENLY_STAGING_OPEN_REGIONS, a comma-separated list of region ids, is
 * honoured ONLY when BACKENLY_ENV is "staging"; anywhere else it is ignored,
 * so a variable copied into production cannot open an unqualified region to
 * customers. Server-side only: the console's picker still shows such a region
 * as not open, and staging creates projects there through the API.
 */
export function stagingOpenRegions(env: Env = process.env): ReadonlySet<CloudRegionId> {
  if ((env.BACKENLY_ENV ?? '').trim().toLowerCase() !== 'staging') return new Set()
  return knownRegions(env.BACKENLY_STAGING_OPEN_REGIONS)
}

/**
 * The regions a deployment opens for project creation to named platform users
 * only, so a production region can be qualified with a probe project before
 * any customer can choose it (a region opens to customers only in the release
 * that sets `open` above, after that qualification).
 *
 * BACKENLY_PREVIEW_REGIONS (region ids) and BACKENLY_PREVIEW_USER_IDS (platform
 * user ids) are honoured together or not at all. A region list without a user
 * list opens nothing, and a caller not named opens nothing, so the setting can
 * never open a region to customers. Server-side only, like the staging list.
 */
export function previewRegionsFor(userId: string | null | undefined, env: Env = process.env): ReadonlySet<CloudRegionId> {
  if (!userId) return new Set()
  if (!commaList(env.BACKENLY_PREVIEW_USER_IDS).includes(userId)) return new Set()
  return knownRegions(env.BACKENLY_PREVIEW_REGIONS)
}

function commaList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/** The ids in a list that name a region this build knows; others are ignored. */
function knownRegions(value: string | undefined): ReadonlySet<CloudRegionId> {
  return new Set(commaList(value).map((id) => findRegion(id)?.id).filter((id): id is CloudRegionId => id !== undefined))
}

/**
 * The region a create request asked for. Omitted means the home region. A
 * region that is not on the list, or not open yet, is refused rather than
 * quietly replaced, so a caller never gets a project in a place it did not ask
 * for. `callerUserId` is the platform user making the request, for the
 * preview list.
 */
export function checkRequestedRegion(
  requested: string | null | undefined,
  env: Env = process.env,
  callerUserId?: string | null,
): RegionCheck {
  if (requested === undefined || requested === null || requested === '') return { ok: true, region: HOME_REGION }
  const region = findRegion(requested)
  if (!region) {
    return { ok: false, code: 'UNKNOWN_REGION', message: `There is no Backenly Cloud region called "${requested}".` }
  }
  if (
    !isOpenToCustomers(region.id, env) &&
    !stagingOpenRegions(env).has(region.id) &&
    !previewRegionsFor(callerUserId, env).has(region.id)
  ) {
    return {
      ok: false,
      code: 'REGION_NOT_OPEN',
      message: `${region.city} (${region.id}) is not open yet. Create the project in an open region.`,
    }
  }
  return { ok: true, region: region.id }
}
