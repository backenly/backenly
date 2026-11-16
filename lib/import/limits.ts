/**
 * The v1 import limits, said in the Review step when a source is over one:
 *
 *   - rows: at most 5 GB in one import, and never more than the plan's
 *     database storage (Free's is far smaller than 5 GB);
 *   - files: at most the plan's file storage.
 *
 * Sizes are the source's own (pg_table_size for rows, object sizes for
 * files), so they are what the source holds, not a promise about Backenly's
 * on-disk size. Pure apart from `limitsFor`.
 */

import type { ImportLimits } from './driver'

export const MAX_IMPORT_ROW_BYTES = 5 * 1024 ** 3

const MB = 1024 * 1024

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

/** The limits of the organization the new project will belong to. */
export async function limitsFor(billingAccountId: string): Promise<ImportLimits> {
  const { getAccountEntitlements } = await import('@/lib/entitlements')
  const { planDisplayName } = await import('@/lib/entitlements/plan-names')
  const ent = await getAccountEntitlements(billingAccountId).catch(() => null)
  const db = ent?.maxPostgresStorageMb ? ent.maxPostgresStorageMb * MB : null
  const files = ent?.maxFileStorageMb ? ent.maxFileStorageMb * MB : null
  return {
    maxRowBytes: db === null ? MAX_IMPORT_ROW_BYTES : Math.min(MAX_IMPORT_ROW_BYTES, db),
    maxFileBytes: files,
    planName: ent?.planName ? planDisplayName(ent.planName) : 'your plan',
  }
}

/** Why rows of this size cannot move, or null. */
export function rowRefusal(bytes: number, limits: ImportLimits | undefined): string | null {
  const max = limits?.maxRowBytes ?? MAX_IMPORT_ROW_BYTES
  if (bytes <= max) return null
  if (max < MAX_IMPORT_ROW_BYTES) {
    return `This source holds about ${formatBytes(bytes)} of rows, and ${limits?.planName ?? 'your plan'} includes ${formatBytes(max)} of database storage. Upgrade the organization, then import.`
  }
  return `This source holds about ${formatBytes(bytes)} of rows; one import moves up to ${formatBytes(MAX_IMPORT_ROW_BYTES)}. Contact us to move a larger database.`
}

/** Why files of this size cannot move, or null. */
export function fileRefusal(bytes: number, limits: ImportLimits | undefined): string | null {
  const max = limits?.maxFileBytes
  if (max === null || max === undefined || bytes <= max) return null
  return `The files come to about ${formatBytes(bytes)}, and ${limits?.planName ?? 'your plan'} includes ${formatBytes(max)} of file storage. Leave files out, or upgrade the organization, then import.`
}
