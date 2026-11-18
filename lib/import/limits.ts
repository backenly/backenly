/**
 * The v1 import limits, said in the Review step when a source is over one:
 *
 *   - rows: at most 5 GB in one import, and never more than what is left of
 *     the organization's database storage (Free's is far smaller than 5 GB);
 *   - files: at most what is left of its file storage.
 *
 * Sizes are the source's own (pg_table_size for rows, object sizes for
 * files), so they are what the source holds, not a promise about Backenly's
 * on-disk size. A source can get them wrong, so the rows are also counted as
 * they are written (RowRoom), and an import stops at the room the plan has
 * left whatever the source said. Tables and users are capped per import too.
 * Pure apart from `limitsFor`.
 */

import { ImportInputError, type ImportLimits } from './driver'

export const MAX_IMPORT_ROW_BYTES = 5 * 1024 ** 3
/** Tables one import creates: each is DDL and a rule in one governed change. */
export const MAX_IMPORT_TABLES = 1_000
/** Users one import moves. */
export const MAX_IMPORT_USERS = 1_000_000
/** What a row costs in PostgreSQL beyond its values: the tuple header and Backenly's own columns. */
export const ROW_OVERHEAD_BYTES = 64

const MB = 1024 * 1024

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
  if (n >= MB) return `${Math.round(n / MB)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

/**
 * The limits of the organization the new project will belong to: what is
 * LEFT of its plan's database and file storage, since every project in the
 * organization shares one allowance (lib/usage/pool.ts).
 */
export async function limitsFor(billingAccountId: string): Promise<ImportLimits> {
  const { getAccountEntitlements } = await import('@/lib/entitlements')
  const { planDisplayName } = await import('@/lib/entitlements/plan-names')
  const { accountUsage } = await import('@/lib/usage/pool')
  const ent = await getAccountEntitlements(billingAccountId).catch(() => null)
  const usage = await accountUsage(billingAccountId).catch(() => null)
  const db = ent?.maxPostgresStorageMb ? ent.maxPostgresStorageMb * MB : null
  const files = ent?.maxFileStorageMb ? ent.maxFileStorageMb * MB : null
  return limitsLeft({
    planRowBytes: db,
    planFileBytes: files,
    usedRowBytes: usage ? Number(usage.dbBytes) : 0,
    usedFileBytes: usage ? Number(usage.fileBytes) : 0,
    planName: ent?.planName ? planDisplayName(ent.planName) : 'your plan',
  })
}

/** The plan's allowances less what the organization already uses. Pure, for the tests. */
export function limitsLeft(input: {
  planRowBytes: number | null
  planFileBytes: number | null
  usedRowBytes: number
  usedFileBytes: number
  planName: string
}): ImportLimits {
  const rowsLeft = input.planRowBytes === null ? null : Math.max(0, input.planRowBytes - Math.max(0, input.usedRowBytes))
  const filesLeft = input.planFileBytes === null ? null : Math.max(0, input.planFileBytes - Math.max(0, input.usedFileBytes))
  return {
    maxRowBytes: rowsLeft === null ? MAX_IMPORT_ROW_BYTES : Math.min(MAX_IMPORT_ROW_BYTES, rowsLeft),
    maxFileBytes: filesLeft,
    planName: input.planName,
    planRowBytes: input.planRowBytes,
    planFileBytes: input.planFileBytes,
  }
}

/** Why rows of this size cannot move, or null. */
export function rowRefusal(bytes: number, limits: ImportLimits | undefined): string | null {
  const max = limits?.maxRowBytes ?? MAX_IMPORT_ROW_BYTES
  if (bytes <= max) return null
  if (max < MAX_IMPORT_ROW_BYTES) {
    const plan = limits?.planRowBytes
    if (plan && plan > max) {
      return `This source holds about ${formatBytes(bytes)} of rows, and the organization has ${formatBytes(max)} left of the ${formatBytes(plan)} of database storage on ${limits?.planName ?? 'your plan'}. Free some space or upgrade the organization, then import.`
    }
    return `This source holds about ${formatBytes(bytes)} of rows, and ${limits?.planName ?? 'your plan'} includes ${formatBytes(max)} of database storage. Upgrade the organization, then import.`
  }
  return `This source holds about ${formatBytes(bytes)} of rows; one import moves up to ${formatBytes(MAX_IMPORT_ROW_BYTES)}. Contact us to move a larger database.`
}

/** Why files of this size cannot move, or null. */
export function fileRefusal(bytes: number, limits: ImportLimits | undefined): string | null {
  const max = limits?.maxFileBytes
  if (max === null || max === undefined || bytes <= max) return null
  const plan = limits?.planFileBytes
  if (plan && plan > max) {
    return `The files come to about ${formatBytes(bytes)}, and the organization has ${formatBytes(max)} left of the ${formatBytes(plan)} of file storage on ${limits?.planName ?? 'your plan'}. Leave files out, or upgrade the organization, then import.`
  }
  return `The files come to about ${formatBytes(bytes)}, and ${limits?.planName ?? 'your plan'} includes ${formatBytes(max)} of file storage. Leave files out, or upgrade the organization, then import.`
}

const count = (n: number) => n.toLocaleString('en-US')

/** Why a source with this many tables (or more than the limit, when unknown) cannot move in one import. */
export function tableCountRefusal(tables: number | null): string {
  const what = tables === null ? `more than ${count(MAX_IMPORT_TABLES)}` : count(tables)
  return `This source has ${what} tables; one import moves up to ${count(MAX_IMPORT_TABLES)}. Contact us to move a larger database.`
}

/** Why a source with this many users (or more than the limit, when unknown) cannot move in one import. */
export function userCountRefusal(users: number | null): string {
  const what = users === null ? `more than ${count(MAX_IMPORT_USERS)}` : count(users)
  return `This source has ${what} users; one import moves up to ${count(MAX_IMPORT_USERS)}. Contact us to move more.`
}

/** Why the import stopped at the room it had, in the pre-checks' words. */
export function roomRefusal(written: number, limits: ImportLimits | undefined): string {
  const max = limits?.maxRowBytes ?? MAX_IMPORT_ROW_BYTES
  const stopped = `Backenly stopped the import after ${formatBytes(written)} of rows`
  if (max < MAX_IMPORT_ROW_BYTES) {
    const plan = limits?.planRowBytes
    if (plan && plan > max) {
      return `${stopped}: the organization has ${formatBytes(max)} left of the ${formatBytes(plan)} of database storage on ${limits?.planName ?? 'your plan'}. Free some space or upgrade the organization, then import again.`
    }
    return `${stopped}: ${limits?.planName ?? 'your plan'} includes ${formatBytes(max)} of database storage. Upgrade the organization, then import again.`
  }
  return `${stopped}; one import moves up to ${formatBytes(MAX_IMPORT_ROW_BYTES)}. Contact us to move a larger database.`
}

/**
 * The room an import's rows have (ImportLimits.maxRowBytes: what is left of
 * the plan's database storage, at most 5 GB), counted as rows are written.
 *
 * The pre-checks compare the size a source REPORTS, which can be wrong: a
 * partitioned table, an estimate from a sample, a server that answers 0. This
 * counts what arrives. Each batch is counted before it is written, at its
 * values' bytes plus ROW_OVERHEAD_BYTES a row. That count runs ahead of what
 * PostgreSQL stores (a uuid is 36 characters of text and 16 bytes on disk), so
 * when it says a batch would not fit, the tables written are measured the way
 * the pre-check measured the source (pg_table_size), and only a batch that
 * would not fit beside what they really hold is refused: the import stops,
 * saying the room.
 */
export class RowRoom {
  private counted = 0

  constructor(
    readonly limits: ImportLimits | undefined,
    /** Bytes the import's tables hold now, as pg_table_size measures them. */
    private readonly measure: () => Promise<number>,
  ) {}

  get room(): number {
    return this.limits?.maxRowBytes ?? MAX_IMPORT_ROW_BYTES
  }

  /** Count a batch of about `bytes` before it is written; throws ImportInputError when it would not fit. */
  async take(bytes: number): Promise<void> {
    const n = Math.max(0, bytes)
    if (this.counted + n <= this.room) {
      this.counted += n
      return
    }
    // A measurement that fails is no evidence of room: the count stands.
    const held = await this.measure().then(
      (b) => Math.max(0, Number(b) || 0),
      () => this.counted,
    )
    if (held + n > this.room) throw new ImportInputError(roomRefusal(held, this.limits))
    this.counted = held + n
  }
}
