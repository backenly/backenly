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
 * stays null, which reads as the home region everywhere.
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

/**
 * The region a create request asked for. Omitted means the home region. A
 * region that is not on the list, or not open yet, is refused rather than
 * quietly replaced, so a caller never gets a project in a place it did not ask
 * for.
 */
export function checkRequestedRegion(requested: string | null | undefined): RegionCheck {
  if (requested === undefined || requested === null || requested === '') return { ok: true, region: HOME_REGION }
  const region = findRegion(requested)
  if (!region) {
    return { ok: false, code: 'UNKNOWN_REGION', message: `There is no Backenly Cloud region called "${requested}".` }
  }
  if (!region.open) {
    return {
      ok: false,
      code: 'REGION_NOT_OPEN',
      message: `${region.city} (${region.id}) is not open yet. Create the project in an open region.`,
    }
  }
  return { ok: true, region: region.id }
}
