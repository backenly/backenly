/**
 * The self-hosted account slot.
 *
 * PUBLIC, and load-bearing. This is the Phase 3 first-operator admission: a
 * fresh single-tenant install must be able to create exactly one operator, and
 * must not be able to create two. None of it is commercial, and moving it to
 * the Cloud overlay would leave a self-host install with no way to create its
 * first account except editing the database by hand.
 *
 * Extracted unchanged from lib/platform/controls.ts. The advisory-lock
 * mechanics below are the fix for a real race, not decoration, so they are
 * moved verbatim rather than rewritten.
 */
import { prisma } from '@/lib/db/prisma'
import { currentEdition } from '@/lib/edition'
import type { Guard } from './state'

/**
 * Signup guard result.
 *
 * `untrusted`, `score` and `signals` are carried so the caller can persist HOW
 * an account arrived. They are values about one signup, not the rules that
 * produced them: the scoring itself is Cloud admission intelligence and stays
 * behind PlatformSignals. In single-tenant they are simply absent.
 */
export interface SignupGuard extends Guard {
  untrusted?: boolean
  score?: number | null
  signals?: string[]
}

/**
 * Advisory lock key for "who gets to be the first account".
 *
 * Arbitrary but fixed. Two int4s because pg_advisory_xact_lock has an
 * (int4, int4) overload, which keeps the key inside the safe integer range —
 * the same approach lib/billing uses for its per-user monthly locks.
 */
const FIRST_ACCOUNT_LOCK: [number, number] = [0x6261636b, 0x656e6c79] // 'back','enly'

export const SELF_HOSTED_CLOSED: SignupGuard = {
  ok: false,
  reason:
    'This is a self-hosted Backenly deployment and registration is closed. ' +
    'The operator can open it with BACKENLY_ALLOW_PUBLIC_SIGNUP=true.',
  status: 403,
}

export function selfHostedRegistrationClosed(): boolean {
  return currentEdition() === 'single-tenant' && process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP !== 'true'
}

/**
 * Claim the single self-hosted account slot, atomically, and create the user.
 *
 * The check in `assertSignupAllowed` is a fast pre-flight and CANNOT be the
 * enforcement: it runs about fifty lines before the insert, so two concurrent
 * first signups both read zero, both proceed, and a single-operator install
 * quietly ends up with two operators. A count followed by an insert is not a
 * decision, it is a race.
 *
 * So the count is repeated INSIDE the transaction that inserts, behind a
 * transaction-scoped advisory lock. The lock is released when the transaction
 * ends either way, so a failed signup cannot wedge registration shut.
 *
 * Cloud takes no lock: there is no slot to contend for, and serialising every
 * signup in the product behind one lock would be a self-inflicted bottleneck.
 */
export async function createUserClaimingSignupSlot<T>(
  create: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!selfHostedRegistrationClosed()) {
    return create(prisma as any)
  }

  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_LOCK[0]}::int4, ${FIRST_ACCOUNT_LOCK[1]}::int4)`
    const existing = await tx.user.count()
    // Throwing rather than returning a union keeps the happy path's type clean
    // and, more importantly, ABORTS the transaction: a refusal must not leave a
    // half-written signup behind.
    if (existing > 0) throw new SignupSlotTakenError()
    return create(tx)
  })
}

/** The self-hosted account slot was claimed by a concurrent request. */
export class SignupSlotTakenError extends Error {
  readonly guard = SELF_HOSTED_CLOSED
  constructor() {
    super(SELF_HOSTED_CLOSED.reason)
    this.name = 'SignupSlotTakenError'
  }
}
