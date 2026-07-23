/**
 * Quota Kernel — the single, Plan-driven enforcement surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file there were THREE disconnected billing engines that did not
 * agree on tier names or numbers:
 *   1. `Plan` table (SANDBOX/BUILDER/SCALE) — what we display & charge for
 *   2. `lib/services/quota-enforcement.ts` — free/pro/enterprise, Paddle-based,
 *      hardcoded 10k/1M/∞ (only wired to the serverless fn executor)
 *   3. `lib/services/storageQuota.ts` — free/starter/pro/enterprise, hardcoded
 *      1/10/100 GB, keyed off `user.tier`
 * The numbers on the pricing page were enforced by NONE of them. This kernel
 * makes the displayed `Plan` the one and only source of truth. Every metered
 * limit routes through here. The other two engines now delegate to this.
 *
 * SEMANTICS (product decisions, locked):
 *   • Soft enforcement: warn at 80%, hard block at 100%.
 *   • API requests: Free = lifetime TOTAL (never resets, `apiQuotaIsLifetime`);
 *     paid = per calendar month; `null` cap = unlimited.
 *   • MAU: distinct end-users who authenticated this calendar month. At the
 *     cap, NEW end-user signups are blocked; existing users keep working.
 *
 * FAIL-OPEN: a bug in billing must never take down a customer's API. Every
 * function swallows infra errors and allows the request; it only ever blocks
 * on a real, measured limit breach.
 */

import { prisma } from '@/lib/db/prisma'
import { getUserSubscription } from '@/lib/billing'
import { createPlatformNotification } from '@/lib/notifications/platform'

// ─── Result type ─────────────────────────────────────────────────────────────

export interface QuotaDecision {
  /** false = the caller must block this action. */
  allowed: boolean
  /** machine code when blocked */
  code?: 'PLAN_LIMIT_EXCEEDED'
  /** human message when blocked */
  message?: string
  /** plan the user is on (for upgrade prompts) */
  plan?: string
  used?: number
  max?: number | null
}

const ALLOW: QuotaDecision = { allowed: true }
const WARN_RATIO = 0.8

// ─── Month key ───────────────────────────────────────────────────────────────

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

// ─── 80% warning (fire-and-forget, deduped per process) ──────────────────────

const warnedKeys = new Set<string>()

function fireThresholdWarning(
  userId: string,
  resource: string,
  used: number,
  max: number,
  period: string,
): void {
  if (max <= 0) return
  const ratio = used / max
  if (ratio < WARN_RATIO || ratio >= 1) return
  const dedupeKey = `${userId}:${resource}:${period}`
  if (warnedKeys.has(dedupeKey)) return
  warnedKeys.add(dedupeKey)
  const pct = Math.round(ratio * 100)
  createPlatformNotification({
    userId,
    type: 'credits_low',
    title: `You're at ${pct}% of your ${resource} limit`,
    body: `You've used ${used.toLocaleString()} of ${max.toLocaleString()} ${resource} (${period}). Upgrade to avoid interruption when you hit 100%.`,
    metadata: { resource, used, max, pct, period },
  }).catch(() => {})
}

function blocked(plan: string, message: string, used?: number, max?: number | null): QuotaDecision {
  return { allowed: false, code: 'PLAN_LIMIT_EXCEEDED', message, plan, used, max }
}

// ─── API requests (lifetime for Free, monthly for paid) ──────────────────────

/**
 * Enforce + track ONE API request against the project owner's plan.
 * Called from the v1 API middleware — the single choke point for every
 * `/api/v1/[projectId]/**` request.
 *
 * - `null` cap            → unlimited: track for display, always allow.
 * - `apiQuotaIsLifetime`  → count against a never-resetting LIFETIME row.
 * - otherwise             → count against the current YYYY-MM.
 *
 * The counter is incremented atomically (row-level upsert) and the post-
 * increment value is compared to the cap, so the request that trips the
 * limit is the one that's refused. Concurrency overshoot is at most a few
 * requests — acceptable for API volume, unlike AI build actions.
 */
export async function enforceAndTrackApiRequest(userId: string): Promise<QuotaDecision> {
  try {
    const sub = await getUserSubscription(userId)
    if (!sub) return ALLOW // no sub on a hot path → fail open

    const max = sub.plan.maxApiRequestsPerMonth // BigInt | null
    const isLifetime = sub.plan.apiQuotaIsLifetime
    const periodKey = isLifetime ? 'LIFETIME' : thisMonth()

    const record = await prisma.userAiUsage.upsert({
      where: { userId_date: { userId, date: periodKey } },
      update: { apiRequestCount: { increment: 1 } },
      create: { userId, date: periodKey, apiRequestCount: BigInt(1) },
      select: { apiRequestCount: true },
    })

    if (max === null) return ALLOW // unlimited — tracked for display only

    const used = Number(record.apiRequestCount)
    const limit = Number(max)

    fireThresholdWarning(
      userId,
      isLifetime ? 'total API requests' : 'monthly API requests',
      used,
      limit,
      periodKey,
    )

    if (used > limit) {
      return blocked(
        sub.plan.name,
        isLifetime
          ? `You've used all ${limit.toLocaleString()} API requests included with the Free plan. Upgrade to Pro ($25/mo) for unlimited API requests.`
          : `You've hit your ${limit.toLocaleString()} API requests for this month on the ${sub.plan.name} plan. Resets on the 1st, or upgrade for more.`,
        used,
        limit,
      )
    }
    return ALLOW
  } catch {
    return ALLOW // never break the API because billing had a hiccup
  }
}

// ─── MAU (monthly active end-users) ──────────────────────────────────────────

async function planForProject(projectId: string): Promise<{ ownerId: string; maxMau: number | null; planName: string } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project?.userId) return null
  const sub = await getUserSubscription(project.userId)
  if (!sub) return null
  return { ownerId: project.userId, maxMau: sub.plan.maxMonthlyActiveUsers ?? null, planName: sub.plan.name }
}

/**
 * Record an end-user as active for the current month.
 * Called on every successful end-user authentication (sign-in / refresh /
 * OAuth). Idempotent per (project, end-user, month). NEVER blocks — existing
 * users must always be able to use a live app.
 */
export async function trackEndUserActive(projectId: string, endUserId: string): Promise<void> {
  if (!projectId || !endUserId) return
  const month = thisMonth()
  try {
    await prisma.projectActiveUser.upsert({
      where: { projectId_endUserId_month: { projectId, endUserId, month } },
      update: { lastSeenAt: new Date() },
      create: { projectId, endUserId, month },
    })
    // Fire owner warning at 80% of MAU (non-blocking).
    const info = await planForProject(projectId)
    if (info && info.maxMau !== null) {
      const count = await prisma.projectActiveUser.count({ where: { projectId, month } })
      fireThresholdWarning(info.ownerId, 'monthly active users', count, info.maxMau, month)
    }
  } catch {
    /* tracking must never break auth */
  }
}

/**
 * Decide whether a NEW end-user may sign up for this project.
 * Blocks (only the new signup) once distinct MAU for the month has reached
 * the plan cap. Existing users are unaffected.
 */
export async function canAcceptNewEndUser(projectId: string): Promise<QuotaDecision> {
  try {
    const info = await planForProject(projectId)
    if (!info || info.maxMau === null) return ALLOW
    const month = thisMonth()
    const count = await prisma.projectActiveUser.count({ where: { projectId, month } })
    if (count >= info.maxMau) {
      return blocked(
        info.planName,
        `This app has reached its limit of ${info.maxMau.toLocaleString()} monthly active users on the ${info.planName} plan. The owner needs to upgrade to allow new sign-ups.`,
        count,
        info.maxMau,
      )
    }
    return ALLOW
  } catch {
    return ALLOW
  }
}

// ─── Realtime concurrent connections ─────────────────────────────────────────

/**
 * Enforce the plan's concurrent realtime-connection cap.
 * `currentConnections` is the live count the caller already holds (the
 * realtime runtime keeps an in-process registry — all SSE flows through the
 * single `backenly-runtime` process). Blocks the NEW connection at the cap;
 * existing streams are untouched.
 */
export async function enforceRealtimeConnection(
  projectId: string,
  currentConnections: number,
): Promise<QuotaDecision> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return ALLOW
    const sub = await getUserSubscription(project.userId)
    if (!sub) return ALLOW
    const max = sub.plan.maxRealtimeConnections
    if (max === null || max === undefined) return ALLOW
    fireThresholdWarning(project.userId, 'realtime connections', currentConnections, max, thisMonth())
    if (currentConnections >= max) {
      return blocked(
        sub.plan.name,
        `This app has reached its limit of ${max.toLocaleString()} concurrent realtime connections on the ${sub.plan.name} plan.`,
        currentConnections,
        max,
      )
    }
    return ALLOW
  } catch {
    return ALLOW
  }
}

export async function getRealtimeConnectionLimit(projectId: string): Promise<{
  ownerId: string
  planName: string
  max: number | null
} | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return null
    const sub = await getUserSubscription(project.userId)
    if (!sub) return null
    return {
      ownerId: project.userId,
      planName: sub.plan.name,
      max: sub.plan.maxRealtimeConnections ?? null,
    }
  } catch {
    return null
  }
}

// ─── PostgreSQL storage (measured) ───────────────────────────────────────────

/**
 * Soft-enforce the project's PostgreSQL storage cap using the most recent
 * measured value (`ProjectUsage.dbStorageUsedMb`, updated by the storage
 * measurement cron). Used by the mutation kernel before structural / bulk
 * writes — we don't pay a size query on every single row insert.
 */
export async function enforceDbStorage(projectId: string): Promise<QuotaDecision> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return ALLOW
    const sub = await getUserSubscription(project.userId)
    if (!sub) return ALLOW
    const maxMb = sub.plan.maxPostgresStorageMb
    if (maxMb === null || maxMb === undefined) return ALLOW

    const month = thisMonth()
    const usage = await prisma.projectUsage.findUnique({
      where: { projectId_month: { projectId, month } },
      select: { dbStorageUsedMb: true },
    })
    const usedMb = Math.round(usage?.dbStorageUsedMb ?? 0)
    fireThresholdWarning(project.userId, 'PostgreSQL storage (MB)', usedMb, maxMb, month)
    if (usedMb >= maxMb) {
      return blocked(
        sub.plan.name,
        `This project has reached its ${maxMb.toLocaleString()} MB PostgreSQL storage limit on the ${sub.plan.name} plan. Upgrade or remove data to continue.`,
        usedMb,
        maxMb,
      )
    }
    return ALLOW
  } catch {
    return ALLOW
  }
}

// ─── Plan-driven file-storage limit (consumed by storageQuota.ts) ────────────

/**
 * The authoritative file-storage byte cap for a project, derived from the
 * owner's Plan. Replaces the hardcoded TIER_QUOTAS table that advertised
 * 50/200 GB but enforced 10/100 GB. Returns null for "unlimited".
 */
export async function getFileStorageLimitBytes(projectId: string): Promise<bigint | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    if (!project?.userId) return null
    const sub = await getUserSubscription(project.userId)
    if (!sub) return null
    const mb = sub.plan.maxFileStorageMb
    if (mb === null || mb === undefined) return null // unlimited
    return BigInt(mb) * BigInt(1024 * 1024)
  } catch {
    return null
  }
}
