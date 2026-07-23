/**
 * CREDIT RESERVATION SYSTEM
 * ==========================
 * Implements a two-phase commit for AI build action credits:
 *
 *   1. reserveCredit(userId, jobId)        — reserve 1 slot at job start
 *   2. commitReservation(userId, jobId)    — convert reservation to committed usage on success
 *   3. refundReservation(userId, jobId)    — release reservation back on failure/cancel
 *
 * Why: Long-running AI jobs (e.g. multi-step builds) should not be charged if
 * they fail, but they MUST hold a slot so concurrent jobs don't collectively
 * overshoot the monthly limit.
 *
 * Reservation expiry: reservations auto-expire after RESERVATION_TTL_MINUTES.
 * The nightly cron calls sweepExpiredReservations() to reclaim stale slots.
 *
 * Concurrency: reserve and commit/refund both acquire the same advisory lock
 * used by enforceAndTrackAiBuildAction so all credit operations for a given
 * (userId, month) are fully serialised.
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'

export const RESERVATION_TTL_MINUTES = 30

function getThisMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

function advisoryLockKeys(userId: string, month: string): [number, number] {
  const hash = crypto.createHash('sha256').update(`${userId}:${month}`).digest()
  return [hash.readInt32BE(0), hash.readInt32BE(4)]
}

export interface ReservationResult {
  success: boolean
  reservationId?: string
  reason?: string
}

/**
 * Reserve one AI build action credit for a job.
 * Checks that (committed + reserved) < max before reserving.
 * Returns the reservationId to pass to commit/refund.
 */
export async function reserveCredit(
  userId: string,
  jobId: string,
  maxActions: number | null
): Promise<ReservationResult> {
  const month = getThisMonth()

  // Unlimited plans — create a no-op reservation that always commits
  if (maxActions === null) {
    const reservation = await prisma.creditReservation.create({
      data: {
        userId,
        date: month,
        amount: 1,
        jobId,
        status: 'reserved',
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000),
      },
    })
    return { success: true, reservationId: reservation.id }
  }

  const [k1, k2] = advisoryLockKeys(userId, month)

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    const usage = await tx.userAiUsage.findUnique({
      where: { userId_date: { userId, date: month } },
      select: { intentCount: true, reservedCount: true },
    })

    const committed = usage?.intentCount ?? 0
    const reserved = usage?.reservedCount ?? 0

    if (committed + reserved >= maxActions) {
      return { allowed: false as const }
    }

    // Increment reservedCount
    await tx.userAiUsage.upsert({
      where: { userId_date: { userId, date: month } },
      update: { reservedCount: { increment: 1 } },
      create: { userId, date: month, intentCount: 0, reservedCount: 1 },
    })

    const reservation = await tx.creditReservation.create({
      data: {
        userId,
        date: month,
        amount: 1,
        jobId,
        status: 'reserved',
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000),
      },
    })

    return { allowed: true as const, reservationId: reservation.id }
  })

  if (!result.allowed) {
    return { success: false, reason: 'Monthly AI build action limit reached' }
  }

  return { success: true, reservationId: result.reservationId }
}

/**
 * Commit a reservation — converts the reserved slot into committed usage.
 * Call this when the job completes successfully.
 */
export async function commitReservation(userId: string, jobId: string): Promise<void> {
  const month = getThisMonth()
  const [k1, k2] = advisoryLockKeys(userId, month)

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    const reservation = await tx.creditReservation.findUnique({
      where: { jobId },
      select: { id: true, status: true, amount: true, date: true, userId: true },
    })

    if (!reservation || reservation.status !== 'reserved') return
    if (reservation.userId !== userId) return

    await tx.creditReservation.update({
      where: { id: reservation.id },
      data: { status: 'committed', committedAt: new Date() },
    })

    // Atomically convert reserved → committed
    await tx.userAiUsage.updateMany({
      where: { userId: reservation.userId, date: reservation.date },
      data: {
        intentCount: { increment: reservation.amount },
        reservedCount: { decrement: reservation.amount },
      },
    })
  })
}

/**
 * Refund a reservation — releases the held slot back to available.
 * Call this when the job fails, times out, or is cancelled.
 */
export async function refundReservation(userId: string, jobId: string): Promise<void> {
  const month = getThisMonth()
  const [k1, k2] = advisoryLockKeys(userId, month)

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, k1, k2)

    const reservation = await tx.creditReservation.findUnique({
      where: { jobId },
      select: { id: true, status: true, amount: true, date: true, userId: true },
    })

    if (!reservation || reservation.status !== 'reserved') return
    if (reservation.userId !== userId) return

    await tx.creditReservation.update({
      where: { id: reservation.id },
      data: { status: 'refunded', refundedAt: new Date() },
    })

    // Release the reserved slot
    await tx.userAiUsage.updateMany({
      where: { userId: reservation.userId, date: reservation.date },
      data: { reservedCount: { decrement: reservation.amount } },
    })
  })
}

/**
 * Sweep expired reservations — refund any still-reserved records whose
 * expiresAt has passed.  Called by the nightly billing cron.
 * Returns the number of reservations refunded.
 */
export async function sweepExpiredReservations(): Promise<number> {
  const now = new Date()

  const expired = await prisma.creditReservation.findMany({
    where: { status: 'reserved', expiresAt: { lt: now } },
    select: { id: true, jobId: true, userId: true },
  })

  for (const r of expired) {
    await refundReservation(r.userId, r.jobId).catch(() => {})
  }

  return expired.length
}
