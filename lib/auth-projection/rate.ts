/**
 * A KEY'S RATE LIMIT, COUNTED IN ITS PROJECT'S REGION
 * ===================================================
 * Every keyed request counts against its key's window: `rateLimit` requests per
 * `rateLimitWindow` seconds. At home the count is api_keys.requestCount and
 * resetAt, read and written on every request (server/lib/auth.ts,
 * lib/middleware/apiKeyAuth.ts). For a project kept in another region that is
 * a read and a write in Mumbai before every response.
 *
 * Once the region's copy is enforced (lib/auth-projection/mode.ts), the region
 * counts instead, in public.auth_rate_windows (scripts/sql/auth-projection.sql).
 * Each project's keys are served only in its region, so this is the one
 * counter a key has, for the Express runtime and the Next-owned routes alike.
 * It keeps home's rules: allowed while the count is under the limit; a new
 * window once the old one has ended, or when the key's window length changes,
 * or when the key is rotated, which is when home resets its counter too.
 *
 * The console reads home's counter, so the region writes its counts there
 * every minute (mirrorRateWindows), with the key's last use. Until then the
 * console shows the count as of the last mirror; nothing is decided by it.
 */

import { prisma } from '@/lib/db/prisma'
import { regionRawClient } from '@/lib/data-plane/regional'
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { authProjectionMode } from '@/lib/auth-projection/mode'

export interface RateDecision {
  allowed: boolean
  remaining: number
  resetAt: Date
  retryAfter?: number
}

/** What a key's window is counted by. */
export interface RateKey {
  id: string
  /** The key's hash; its start marks a rotation, which starts a new window. */
  keyHash: string
  rateLimit: number
  rateLimitWindow: number
}

/** How much of the hash marks the key's rotation. Enough to tell two keys apart, nothing to guess from. */
const KEY_MARK_LENGTH = 12

/** The region this process counts keys in, or null when home counts them. */
export function regionalRateCounting(): CloudRegionId | null {
  if (authProjectionMode() !== 'enforce') return null
  try {
    const region = serviceRegion()
    return region === HOME_REGION ? null : region
  } catch {
    return null
  }
}

interface WindowRow {
  allowed: boolean
  count: number
  resetAt: Date
}

/** Count one request against the key's window in the region, atomically. */
export async function countInRegion(region: CloudRegionId, key: RateKey): Promise<RateDecision> {
  const limit = key.rateLimit ?? 1000
  const windowSeconds = key.rateLimitWindow ?? 3600
  const keyMark = key.keyHash.slice(0, KEY_MARK_LENGTH)
  // One statement: a new window, a counted request, or nothing when the key is
  // at its limit. A refused request changes nothing, and reads the window as it
  // stood (the data-modifying CTE does not see its own effect). The last use is
  // kept to the millisecond, as a JavaScript date carries it, so the mirror can
  // tell exactly which use it wrote.
  const [row] = await regionRawClient(region).$queryRaw<WindowRow[]>`
    WITH counted AS (
      INSERT INTO public.auth_rate_windows AS w ("keyId", "windowSeconds", "keyMark", "resetAt", "count", "lastUsedAt")
      VALUES (${key.id}, ${windowSeconds}, ${keyMark}, now() + make_interval(secs => ${windowSeconds}::double precision), 1,
              date_trunc('milliseconds', now()))
      ON CONFLICT ("keyId") DO UPDATE
         SET "count" = CASE
               WHEN w."resetAt" <= now() OR w."windowSeconds" <> EXCLUDED."windowSeconds" OR w."keyMark" <> EXCLUDED."keyMark"
               THEN 1 ELSE w."count" + 1 END,
             "resetAt" = CASE
               WHEN w."resetAt" <= now() OR w."windowSeconds" <> EXCLUDED."windowSeconds" OR w."keyMark" <> EXCLUDED."keyMark"
               THEN EXCLUDED."resetAt" ELSE w."resetAt" END,
             "windowSeconds" = EXCLUDED."windowSeconds",
             "keyMark" = EXCLUDED."keyMark",
             "lastUsedAt" = EXCLUDED."lastUsedAt"
       WHERE w."resetAt" <= now() OR w."windowSeconds" <> EXCLUDED."windowSeconds"
          OR w."keyMark" <> EXCLUDED."keyMark" OR w."count" < ${limit}
      RETURNING "count", "resetAt"
    )
    SELECT true AS "allowed", "count", "resetAt" FROM counted
    UNION ALL
    SELECT false AS "allowed", "count", "resetAt" FROM public.auth_rate_windows
     WHERE "keyId" = ${key.id} AND NOT EXISTS (SELECT 1 FROM counted)`
  if (!row) throw new Error(`The rate-limit window of key ${key.id} could not be read in ${region}.`)
  if (row.allowed) {
    return { allowed: true, remaining: Math.max(0, limit - row.count), resetAt: row.resetAt }
  }
  return {
    allowed: false,
    remaining: 0,
    resetAt: row.resetAt,
    retryAfter: Math.max(1, Math.ceil((row.resetAt.getTime() - Date.now()) / 1000)),
  }
}

interface MirrorRow {
  keyId: string
  count: number
  resetAt: Date
  lastUsedAt: Date
}

const MIRROR_BATCH = 500

/**
 * Write the region's counts home: each window used since it was last written,
 * as the key's requestCount, resetAt and lastUsed, which the console shows.
 * A window used again while it was being written stays unwritten, and goes in
 * the next run. Returns how many were written.
 */
export async function mirrorRateWindows(region: CloudRegionId, { batch = MIRROR_BATCH }: { batch?: number } = {}): Promise<number> {
  const copy = regionRawClient(region)
  const windows = await copy.$queryRaw<MirrorRow[]>`
    SELECT "keyId", "count", "resetAt", "lastUsedAt" FROM public.auth_rate_windows
     WHERE "mirroredAt" IS NULL OR "mirroredAt" < "lastUsedAt"
     ORDER BY "lastUsedAt"
     LIMIT ${batch}`
  if (windows.length === 0) return 0
  const rows = windows.map((w) => ({
    keyId: w.keyId,
    count: w.count,
    resetAt: w.resetAt.toISOString(),
    lastUsedAt: w.lastUsedAt.toISOString(),
  }))
  // Home keeps these columns as UTC without a zone. None of them is watched by
  // the copy's capture triggers, so this write delivers nothing back.
  await prisma.$executeRaw`
    UPDATE "api_keys" AS k
       SET "requestCount" = v."count",
           "resetAt" = (v."resetAt" AT TIME ZONE 'UTC'),
           "lastUsed" = (v."lastUsedAt" AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
           AS v("keyId" text, "count" integer, "resetAt" timestamptz, "lastUsedAt" timestamptz)
     WHERE k."id" = v."keyId"`
  await copy.$executeRaw`
    UPDATE public.auth_rate_windows AS w
       SET "mirroredAt" = v."lastUsedAt"
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v("keyId" text, "lastUsedAt" timestamptz)
     WHERE w."keyId" = v."keyId" AND w."lastUsedAt" = v."lastUsedAt"`
  return windows.length
}

/** Windows unused for a day are written home already and need not be kept. */
export async function pruneRateWindows(region: CloudRegionId): Promise<number> {
  return regionRawClient(region).$executeRaw`
    DELETE FROM public.auth_rate_windows
     WHERE "lastUsedAt" < now() - interval '1 day' AND "mirroredAt" >= "lastUsedAt"`
}
