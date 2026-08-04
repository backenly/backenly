/**
 * AUTONOMY LEVEL — the owner-controlled risk dial
 * ===============================================
 *
 * Real autonomous platforms never say "AI does whatever". They give the owner
 * a graded dial (Tesla Autopilot levels, AWS DevOps Guru opt-in tiers) and the
 * dial only ever controls how much of the *already-safe* band auto-applies.
 *
 * The hard contract this module enforces:
 *   • The dial can only ever permit Tier-0 / Tier-1 actions.
 *   • Tier-2 (auth/external/destructive) and Tier-3 (irreversible) ALWAYS
 *     require human approval — no level can auto-approve them. This is not a
 *     setting; it is a floor.
 *   • OFF means the loop observes and reports but mutates nothing.
 *
 * Read-only. Never mutates project data.
 */

import { prisma } from '@/lib/db/prisma'
import type { AutonomyTier } from './desired-state'

export type AutonomyLevel = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

const VALID: ReadonlySet<string> = new Set(['OFF', 'CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'])

/**
 * The default applied to any project that has never set a level explicitly.
 *
 * AGGRESSIVE (Autopilot) — self-healing IS the product (founder decision
 * 2026-07-18): a backend that asks permission for every reversible fix isn't
 * autonomous. The loop auto-applies the safe band (Tier 0/1 — additive,
 * snapshotted, reversible) out of the box; the owner can dial DOWN any time.
 * The safety floor is untouched: Tier-2+ (auth / external credentials /
 * destructive / irreversible) always requires approval at every level, and
 * reads are still clamped to the plan cap (getProjectAutonomyLevel).
 */
export const DEFAULT_LEVEL: AutonomyLevel = 'AGGRESSIVE'

/**
 * Ceiling used when we genuinely cannot resolve the plan cap (DB blip, missing
 * subscription row).
 *
 * This was CONSERVATIVE, to avoid "accidentally enabling Tier-1 mutations on a
 * Free project". That protects against a plan that does not exist: SANDBOX,
 * BUILDER and SCALE all seed `autonomyMaxLevel: 'AGGRESSIVE'`, because
 * self-healing is the product rather than the upsell. There is no tier whose
 * ceiling this fallback was keeping anyone under.
 *
 * What it did instead was withdraw Tier 1 whenever a Subscription row could not
 * be read — and Tier 1 is where `missing_rls` and `unprotected_user_data` live.
 * So the failure mode of a transient database hiccup was: the loop keeps
 * running, keeps reporting itself healthy, keeps adding indexes, and quietly
 * stops closing row-level-security holes. Silent, and in the dangerous
 * direction, which is the opposite of what a "safe" fallback is for.
 *
 * Raising it does not widen the blast radius. Tier 2 and above — auth, external
 * credentials, destructive, irreversible — are hard-denied in isTierAutoAllowed
 * at EVERY level, including AGGRESSIVE; that floor is not a dial and this does
 * not touch it. The only band this unlocks is Tier 1: additive, snapshotted
 * before it runs, re-probed after, and rolled into human review if it breaks a
 * guarantee that was previously holding.
 *
 * If a future plan genuinely needs a lower ceiling, the seed sets it and the
 * clamp enforces it normally. The fallback should describe the product, not the
 * most cautious number available.
 */
export const SAFE_FALLBACK_LEVEL: AutonomyLevel = 'AGGRESSIVE'

/** Ordering for clamping a requested level down to a plan's ceiling. */
const LEVEL_RANK: Record<AutonomyLevel, number> = {
  OFF: 0,
  CONSERVATIVE: 1,
  BALANCED: 2,
  AGGRESSIVE: 3,
}

/**
 * Clamp the owner's requested dial to the plan's ceiling. The dial can always
 * go LOWER (OFF is the floor and always allowed — opting out is never gated),
 * but never above what the plan permits.
 *
 * The ceiling is whatever `Plan.autonomyMaxLevel` says — read live, never
 * hardcoded here. Every plan including Free currently seeds AGGRESSIVE
 * (prisma/seed-billing.ts): self-healing is the product, so it is not the
 * thing we withhold. Free↔Pro is separated by scan budget and actions per
 * window, NOT by the dial and NOT by cadence — every plan reconciles every
 * minute.
 *
 * Exported because both the write paths (PATCH /autonomy + brain
 * set_autonomy_level) MUST clamp before persisting — otherwise the UI / chat
 * cheerfully echo a level the loop will silently downgrade on read.
 */
export function clampToPlan(requested: AutonomyLevel, cap: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[requested] <= LEVEL_RANK[cap] ? requested : cap
}

/**
 * Highest tier the dial may auto-apply at this level. -1 means "auto nothing".
 * Note the ceiling is 1 even at AGGRESSIVE — Tier-2+ is never auto, ever.
 */
export function maxAutoTier(level: AutonomyLevel): AutonomyTier | -1 {
  switch (level) {
    case 'OFF':          return -1
    case 'CONSERVATIVE': return 0
    case 'BALANCED':     return 1
    case 'AGGRESSIVE':   return 1
  }
}

/**
 * Per-window action-ceiling multiplier applied on top of the circuit breaker's
 * base limit. AGGRESSIVE lets the loop do more per window; it never removes the
 * breaker — it only scales the ceiling. CONSERVATIVE deliberately tightens it.
 */
export function breakerMultiplier(level: AutonomyLevel): number {
  switch (level) {
    case 'OFF':          return 0
    case 'CONSERVATIVE': return 0.5
    case 'BALANCED':     return 1
    case 'AGGRESSIVE':   return 2
  }
}

/** Whether a gap of the given tier may be auto-applied at this level. */
export function isTierAutoAllowed(level: AutonomyLevel, tier: AutonomyTier): boolean {
  // Defence in depth: even if a caller passes a wrong level, Tier-2+ is hard-denied.
  if (tier >= 2) return false
  const ceiling = maxAutoTier(level)
  return ceiling !== -1 && tier <= ceiling
}

/**
 * Resolve a project's autonomy level. Falls back to the safe default on any
 * read failure or unknown value — never throws, never returns an unsafe level.
 */
export async function getProjectAutonomyLevel(projectId: string): Promise<AutonomyLevel> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { autonomyLevel: true, userId: true },
    })
    const raw = (p as { autonomyLevel?: string } | null)?.autonomyLevel
    const requested = raw && VALID.has(raw) ? (raw as AutonomyLevel) : DEFAULT_LEVEL

    // Clamp to the owner's plan ceiling so a Free project can't run AGGRESSIVE.
    const ownerId = (p as { userId?: string } | null)?.userId
    if (!ownerId) return requested
    const sub = await prisma.subscription.findFirst({
      where: { userId: ownerId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
      include: { plan: { select: { autonomyMaxLevel: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const capRaw = sub?.plan?.autonomyMaxLevel
    // If the cap can't be resolved, clamp to SAFE_FALLBACK_LEVEL — never let a
    // DB blip widen a Free project's effective level past CONSERVATIVE.
    const cap = capRaw && VALID.has(capRaw) ? (capRaw as AutonomyLevel) : SAFE_FALLBACK_LEVEL
    return clampToPlan(requested, cap)
  } catch {
    return SAFE_FALLBACK_LEVEL
  }
}

/** Validate + normalise a user-supplied level for the settings API. */
export function coerceAutonomyLevel(input: unknown): AutonomyLevel | null {
  if (typeof input !== 'string') return null
  const up = input.trim().toUpperCase()
  return VALID.has(up) ? (up as AutonomyLevel) : null
}

/**
 * Map a plan's internal name (SANDBOX / BUILDER / SCALE) to the user-facing
 * label shown everywhere in the product (Free / Pro / Enterprise). Kept in
 * sync with app/app/billing/billing-panel.tsx. Unknown names pass through so a
 * future plan doesn't render as a blank.
 */
export function planDisplayName(internalName: string | null | undefined): string {
  switch (internalName) {
    case 'SANDBOX': return 'Free'
    case 'BUILDER': return 'Pro'
    case 'SCALE':   return 'Enterprise'
    default:        return internalName || 'Free'
  }
}

/**
 * Resolve the owner's current plan internal name (SANDBOX / BUILDER / SCALE),
 * or null on any read failure. The autonomy cap alone cannot distinguish
 * Pro from Enterprise (both cap at AGGRESSIVE), so the UI needs the real plan
 * name to label the plan pill correctly and to point the upgrade CTA at the
 * right tier.
 */
export async function getProjectPlanName(projectId: string): Promise<string | null> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    const ownerId = p?.userId
    if (!ownerId) return null
    const sub = await prisma.subscription.findFirst({
      where: { userId: ownerId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
      include: { plan: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return sub?.plan?.name ?? null
  } catch {
    return null
  }
}

/**
 * Read the autonomy ceiling allowed by the project owner's current plan.
 * Comes from `Plan.autonomyMaxLevel`; every seeded plan including Free is
 * AGGRESSIVE today, so in practice the full dial is available on every plan,
 * at an every-minute cadence.
 *
 * The CONSERVATIVE fallback below is defence in depth for an unresolvable
 * plan, not a description of Free.
 *
 * Falls back to DEFAULT_LEVEL on any read failure so a transient DB blip
 * cannot accidentally widen what the user is allowed to enable.
 */
export async function getProjectAutonomyCap(projectId: string): Promise<AutonomyLevel> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    const ownerId = p?.userId
    if (!ownerId) return SAFE_FALLBACK_LEVEL
    const sub = await prisma.subscription.findFirst({
      where: { userId: ownerId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
      include: { plan: { select: { autonomyMaxLevel: true } } },
      orderBy: { createdAt: 'desc' },
    })
    const raw = sub?.plan?.autonomyMaxLevel
    return raw && VALID.has(raw) ? (raw as AutonomyLevel) : SAFE_FALLBACK_LEVEL
  } catch {
    return SAFE_FALLBACK_LEVEL
  }
}
