/**
 * REFERRAL PROGRAM  (IA restructure §5.5 / Phase 7)
 * =============================================================
 * Flat-grant model (the §17 decision — revenue-share is a later v2):
 *   • Referee signs up with a code → +200 bonus assistant credits, immediately.
 *   • Referrer, when that referee first upgrades to a paid plan → +500 bonus.
 *
 * Every grant flows through the credit ledger (lib/billing/credit-ledger.ts) so
 * it is a REAL, spendable balance and shows up in Billing → Credit activity.
 * All grants are idempotent — a retried signup or webhook never double-pays.
 */

import { prisma } from '@/lib/db/prisma'
import crypto from 'crypto'
import { grantCredits } from './credit-ledger'

export const REFERRAL_SIGNUP_BONUS = 200 // credits to the new user
export const REFERRAL_PAID_BONUS = 500 // credits to the referrer on first upgrade

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous chars (0/O, 1/I)

function randomCode(len = 7): string {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}

/** Get the user's referral code, minting a stable one on first request. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await prisma.referralCode.findUnique({ where: { userId }, select: { code: true } })
  if (existing) return existing.code

  // Mint with a few collision retries (the space is 32^7 ≈ 34 billion).
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode()
    try {
      const created = await prisma.referralCode.create({ data: { userId, code }, select: { code: true } })
      return created.code
    } catch (err: any) {
      // Unique violation on code → retry; unique violation on userId → someone
      // else minted concurrently, read it back.
      const created = await prisma.referralCode.findUnique({ where: { userId }, select: { code: true } })
      if (created) return created.code
      if (attempt === 5) throw err
    }
  }
  throw new Error('Could not mint referral code')
}

export interface ReferralStats {
  code: string
  url: string
  referrals: number // accounts that signed up with this code
  paidReferrals: number // of those, how many upgraded (referrer got paid)
  creditsEarned: number // total bonus credits this user earned from referring
}

export async function getReferralStats(userId: string): Promise<ReferralStats> {
  const code = await ensureReferralCode(userId)
  const grants = await prisma.referralGrant.findMany({
    where: { referrerId: userId },
    select: { status: true, payCreditsGranted: true },
  })
  const paidReferrals = grants.filter((g) => g.status === 'paid_granted').length
  const creditsEarned = grants.reduce((s, g) => s + g.payCreditsGranted, 0)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
  return {
    code,
    url: `${appUrl}/auth/signup?ref=${code}`,
    referrals: grants.length,
    paidReferrals,
    creditsEarned,
  }
}

/** Normalise a raw ?ref= value to a canonical code, or null if it can't be one. */
export function normaliseRefCode(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  return cleaned.length >= 5 && cleaned.length <= 12 ? cleaned : null
}

/**
 * Apply a referral at signup time. Grants the new user their signup bonus and
 * records the ReferralGrant. Idempotent (refereeId is unique) and defensive —
 * a self-referral, unknown code, or already-referred user is a silent no-op so
 * signup never fails because of referral bookkeeping.
 */
export async function applyReferralOnSignup(
  refereeId: string,
  refereeEmail: string,
  rawCode: string | null | undefined,
): Promise<{ applied: boolean }> {
  try {
    const code = normaliseRefCode(rawCode)
    if (!code) return { applied: false }

    const referral = await prisma.referralCode.findUnique({
      where: { code },
      select: { userId: true },
    })
    if (!referral) return { applied: false }
    if (referral.userId === refereeId) return { applied: false } // no self-referral

    // Already referred? (refereeId unique on ReferralGrant)
    const already = await prisma.referralGrant.findUnique({
      where: { refereeId },
      select: { id: true },
    })
    if (already) return { applied: false }

    // Record attribution + grant. If the grant row loses a race it throws on the
    // unique refereeId — caught below, leaving signup unaffected.
    await prisma.referralGrant.create({
      data: {
        referrerId: referral.userId,
        refereeId,
        refereeEmail,
        code,
        status: 'signup_granted',
        signupCreditsGranted: REFERRAL_SIGNUP_BONUS,
      },
    })

    await prisma.user.update({
      where: { id: refereeId },
      data: { referredById: referral.userId },
    }).catch(() => {})

    await prisma.referralCode.update({
      where: { code },
      data: { uses: { increment: 1 } },
    }).catch(() => {})

    await grantCredits(refereeId, REFERRAL_SIGNUP_BONUS, {
      reason: 'referral_signup',
      description: `Welcome bonus for joining with a referral code`,
      idempotencyKey: `referral_signup:${refereeId}`,
    })

    return { applied: true }
  } catch {
    // Referral bookkeeping must never break signup.
    return { applied: false }
  }
}

/**
 * Reward the referrer when their referee first upgrades to a paid plan. Called
 * from the Paddle webhook on the first successful subscription for a user.
 * Idempotent: a grant only transitions signup_granted → paid_granted once.
 */
export async function applyReferralOnFirstPayment(refereeId: string): Promise<{ rewarded: boolean }> {
  try {
    const grant = await prisma.referralGrant.findUnique({
      where: { refereeId },
      select: { id: true, referrerId: true, status: true },
    })
    if (!grant || grant.status !== 'signup_granted') return { rewarded: false }

    // Flip state first (guards against a double webhook racing the credit grant).
    const updated = await prisma.referralGrant.updateMany({
      where: { id: grant.id, status: 'signup_granted' },
      data: { status: 'paid_granted', payCreditsGranted: REFERRAL_PAID_BONUS },
    })
    if (updated.count === 0) return { rewarded: false } // lost the race — already rewarded

    await grantCredits(grant.referrerId, REFERRAL_PAID_BONUS, {
      reason: 'referral_paid',
      description: `A developer you referred upgraded to a paid plan`,
      idempotencyKey: `referral_paid:${grant.id}`,
    })

    return { rewarded: true }
  } catch {
    return { rewarded: false }
  }
}
