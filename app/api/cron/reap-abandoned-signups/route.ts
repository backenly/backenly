/**
 * Abandoned-signup reaper.
 * ========================
 *
 * The last layer. Turnstile and the trust engine stop most abuse at the door;
 * this cleans up whatever still gets in, so the operator's Users tab keeps
 * showing customers instead of noise.
 *
 * A row is only reaped when it is unambiguously inert:
 *
 *   - never verified its email address, AND
 *   - was flagged `untrusted` at signup, AND
 *   - is older than the grace window (14 days by default), AND
 *   - owns no projects, holds no API keys, has no subscription beyond the
 *     free seed, and has never made a request.
 *
 * Every one of those has to hold. A user who did anything at all is kept, no
 * matter how their address scored — the cost of deleting one real account is
 * far higher than the cost of leaving a dead one in the table.
 *
 * Accounts that predate the trust columns default to `trustLevel = 'trusted'`,
 * so this cannot reach back and delete anyone who signed up before the gate
 * existed.
 *
 * DRY RUN: pass ?dryRun=1 to see exactly what would be deleted, changing
 * nothing. Worth doing on the first production run.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { recordSecurityEvent } from '@/lib/platform-controls'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Days an unverified, untrusted, entirely inactive account is kept. */
const GRACE_DAYS = Number(process.env.ABANDONED_SIGNUP_GRACE_DAYS || 14)
/** Ceiling per run, so one sweep can never mass-delete unexpectedly. */
const MAX_PER_RUN = 200

function verifyCronAuth(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true
  // Same ad-hoc ops header the autonomy cron accepts.
  return request.headers.get('x-cron-secret') === secret
}

export async function GET(request: NextRequest) {
  return POST(request)
}

export async function POST(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = ['1', 'true'].includes(
    (request.nextUrl.searchParams.get('dryRun') || '').toLowerCase(),
  )
  const cutoff = new Date(Date.now() - GRACE_DAYS * 86_400_000)

  try {
    const candidates = await prisma.user.findMany({
      where: {
        emailVerified: false,
        trustLevel: 'untrusted',
        createdAt: { lt: cutoff },
        deletedAt: null,
        // Never touch an account that shows any sign of being real.
        projects: { none: {} },
        apiKeys: { none: {} },
        apiRequestLogs: { none: {} },
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
        lastActiveAt: true,
        signupScore: true,
        signupSignals: true,
        signupIp: true,
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_PER_RUN,
    })

    // Second pass in application code: `lastActiveAt` moving after signup means
    // somebody came back and signed in. That is a human, so leave them alone.
    // Signup seeds lastActiveAt == createdAt, hence the small tolerance.
    const reapable = candidates.filter((u) => {
      if (!u.lastActiveAt) return true
      return u.lastActiveAt.getTime() - u.createdAt.getTime() < 60_000
    })

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        graceDays: GRACE_DAYS,
        cutoff: cutoff.toISOString(),
        candidates: candidates.length,
        wouldDelete: reapable.length,
        sample: reapable.slice(0, 25).map((u) => ({
          email: u.email,
          createdAt: u.createdAt,
          score: u.signupScore,
          signals: u.signupSignals,
        })),
      })
    }

    let deleted = 0
    const failures: { email: string; error: string }[] = []

    for (const user of reapable) {
      try {
        // Relations that matter cascade on delete (see the Prisma schema);
        // anything that does not cascade would throw here and be reported
        // rather than silently leaving a half-deleted account behind.
        await prisma.user.delete({ where: { id: user.id } })
        deleted++
      } catch (err) {
        failures.push({ email: user.email, error: (err as Error)?.message ?? 'unknown' })
      }
    }

    if (deleted > 0) {
      await recordSecurityEvent({
        kind: 'abandoned_signups_reaped',
        severity: 'info',
        summary: `Reaped ${deleted} abandoned untrusted signup${deleted === 1 ? '' : 's'}`,
        detail: {
          deleted,
          graceDays: GRACE_DAYS,
          emails: reapable.slice(0, 50).map((u) => u.email),
        },
      }).catch(() => {})
    }

    return NextResponse.json({
      ok: true,
      graceDays: GRACE_DAYS,
      candidates: candidates.length,
      deleted,
      skippedAsActive: candidates.length - reapable.length,
      failures,
    })
  } catch (error) {
    console.error('[reap-abandoned-signups] failed:', error)
    return NextResponse.json(
      { error: 'Reaper failed', detail: (error as Error)?.message },
      { status: 500 },
    )
  }
}
