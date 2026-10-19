/**
 * How a definition reads on the record of a change to a project kept outside
 * the home region: a keyed digest, never the text (lib/changes/residency.ts).
 *
 * Pure and dependency-free, so the footprint's describer (lib/changes/diff.ts)
 * and the console can tell one apart without reaching for the database.
 */

export const KEPT_IN_REGION = 'kept-in-region:'

/** True for a definition this record holds only as its digest. */
export function isKeptInRegion(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(KEPT_IN_REGION)
}
