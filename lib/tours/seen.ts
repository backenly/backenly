/**
 * Which one-time tours a user has already seen (the `user_tours_seen` table).
 *
 * A tour is shown at most once per user: finishing it and skipping it both
 * write the row. Reads FAIL CLOSED: if the table is not there yet (a release
 * ahead of its migration) the answer is "unavailable" and the tour does not
 * run, rather than "not seen", which would show it on every visit.
 */

import { prisma } from '@/lib/db/prisma'

/** Every tour the console knows. A client cannot mark anything else. */
export const TOUR_IDS = ['console'] as const
export type TourId = (typeof TOUR_IDS)[number]

export function isTourId(value: unknown): value is TourId {
  return typeof value === 'string' && (TOUR_IDS as readonly string[]).includes(value)
}

export interface ToursSeen {
  /** False when the table is missing: callers must not show any tour. */
  available: boolean
  seen: TourId[]
}

function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null
  return e?.code === 'P2021' || e?.meta?.code === '42P01'
}

export async function readToursSeen(userId: string): Promise<ToursSeen> {
  try {
    const rows = await prisma.userTourSeen.findMany({ where: { userId }, select: { tourId: true } })
    return { available: true, seen: rows.map((r) => r.tourId).filter(isTourId) }
  } catch (err) {
    if (isMissingTable(err)) return { available: false, seen: [] }
    throw err
  }
}

/** Idempotent: a second tab finishing the same tour changes nothing. */
export async function markTourSeen(userId: string, tourId: TourId): Promise<boolean> {
  try {
    await prisma.userTourSeen.createMany({ data: [{ userId, tourId }], skipDuplicates: true })
    return true
  } catch (err) {
    if (isMissingTable(err)) return false
    throw err
  }
}
