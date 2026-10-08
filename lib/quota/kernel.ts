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
 * The kernel reads ENTITLEMENTS, never Plan or Subscription rows directly.
 * In Cloud those entitlements are still resolved from the displayed Plan, so
 * nothing about the enforced numbers changes; in single-tenant they come from
 * the edition itself, which is why a self-host install needs no billing seed.
 *
 * SEMANTICS (product decisions, locked):
 *   • Quotas belong to the billing account (lib/usage/account.ts: the project's
 *     organization on Cloud, its owner elsewhere) and are
 *     POOLED across all of its projects: 8 GB of database is 8 GB for the
 *     account, not 8 GB per project (lib/usage/pool.ts).
 *   • At the quota the gate blocks, unless the account's spend limit allows
 *     overage (lib/usage/overage.ts effectiveCap). Alerts at 50/80/100% are
 *     sent once each by lib/usage/alerts.ts.
 *   • API requests are not a quota on any plan: never capped, never billed,
 *     so nothing here gates them. lib/traffic/request-recorder.ts counts them
 *     per calendar month, for the Usage page only.
 *   • MAU: distinct end-users who authenticated this calendar month. At the
 *     cap, NEW end-user signups are blocked; existing users keep working.
 *
 * FAIL-OPEN: a bug in billing must never take down a customer's API. Every
 * function swallows infra errors and allows the request; it only ever blocks
 * on a real, measured limit breach.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { accountOfUser, getAccountEntitlements } from '@/lib/entitlements'
import { isReservedTestEmail } from '@/lib/services/end-user-auth-table'
import { accountOf, accountProjectsWhere } from '@/lib/usage/account'
import { recordUsage } from '@/lib/usage/ledger'
import { recordQuotaWarning } from '@/lib/usage/alerts'
import { effectiveCap } from '@/lib/usage/overage'
import type { UserEntitlements } from '@/lib/entitlements'

const MB = 1024 * 1024

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

// ─── 80% warning on the quota the usage sweep does not cover ─────────────────
//
// Realtime connections are never billed, so the usage-alert sweep
// (lib/usage/alerts.ts) does not evaluate them; their gate warns here.
// The warning is recorded durably and sent once per account and period; this
// set only spares the database a repeated no-op insert on a hot path.

const warnedKeys = new Set<string>()

function fireThresholdWarning(
  billingAccountId: string,
  axis: 'realtime_connections',
  used: number,
  max: number,
  period: string,
): void {
  if (max <= 0 || used / max < WARN_RATIO) return
  const dedupeKey = `${billingAccountId}:${axis}:${period}`
  if (warnedKeys.has(dedupeKey)) return
  if (warnedKeys.size > 50_000) warnedKeys.clear()
  warnedKeys.add(dedupeKey)
  recordQuotaWarning(billingAccountId, axis, used, max, period).catch(() => {})
}

function blocked(plan: string, message: string, used?: number, max?: number | null): QuotaDecision {
  return { allowed: false, code: 'PLAN_LIMIT_EXCEEDED', message, plan, used, max }
}

// ─── MAU (monthly active end-users) ──────────────────────────────────────────

/** The project's billing account (lib/usage/account.ts) and that account's plan. */
async function accountEntitlements(projectId: string): Promise<{ accountId: string; ent: UserEntitlements } | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true, userId: true },
  })
  const accountId = project ? accountOf(project) : null
  if (!accountId) return null
  const ent = await getAccountEntitlements(accountId)
  if (!ent) return null
  return { accountId, ent }
}

/** Distinct end users this month across every project that bills to the account. */
async function accountMau(accountId: string, month: string): Promise<number> {
  return prisma.projectActiveUser.count({ where: { month, project: accountProjectsWhere(accountId) } })
}

/**
 * Record an end-user as active for the current month.
 * Called on every successful end-user authentication (sign-in / refresh /
 * OAuth). Idempotent per (project, end-user, month). NEVER blocks — existing
 * users must always be able to use a live app.
 *
 * `email` is required so the synthetic-account rule lives here and not at each
 * call site. The contract probe signs a fresh `…@backenly.internal` user in
 * every minute; two of the five callers skipped it and three did not, so each
 * probe pass counted as a new monthly active user against the customer's plan
 * cap. Verifier accounts are never people.
 */
export async function trackEndUserActive(
  projectId: string,
  endUserId: string,
  email: string | null | undefined,
): Promise<void> {
  if (!projectId || !endUserId) return
  if (isReservedTestEmail(email)) return
  const month = thisMonth()
  try {
    // (xmax = 0) is true only for a row this statement INSERTED, so the usage
    // ledger hears about each (project, end user, month) exactly once, however
    // many requests race to be the first of the month. The ledger's copy is the
    // billing record: it is not deleted with the project, unlike this row.
    const rows = await prisma.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "project_active_users" ("id", "projectId", "endUserId", "month", "lastSeenAt", "createdAt")
      VALUES (${randomUUID()}, ${projectId}, ${endUserId}, ${month}, now(), now())
      ON CONFLICT ("projectId", "endUserId", "month") DO UPDATE SET "lastSeenAt" = now()
      RETURNING (xmax = 0) AS inserted`
    if (rows[0]?.inserted) {
      recordUsage({ projectId, axis: 'mau', quantity: 1, source: 'auth' })
    }
  } catch {
    /* tracking must never break auth */
  }
}

// One tracking write per end user per UTC day per process, however many
// requests they make. Bounded: cleared wholesale past the ceiling, which only
// costs a few repeated (idempotent) upserts.
const activityNoted = new Map<string, string>()
const ACTIVITY_NOTED_CEILING = 100_000

/**
 * An end user made an authenticated data request: count them as active this
 * month. MAU used to hear only about sign-ins and refreshes, so a returning user
 * holding a still-valid seven-day token was invisible until it expired.
 * Throttled to one write per user per day; never blocks, never throws.
 */
export function noteEndUserActivity(
  projectId: string,
  endUserId: string,
  email: string | null | undefined,
): void {
  if (!projectId || !endUserId) return
  const day = new Date().toISOString().slice(0, 10)
  const key = `${projectId}:${endUserId}`
  if (activityNoted.get(key) === day) return
  if (activityNoted.size >= ACTIVITY_NOTED_CEILING) activityNoted.clear()
  activityNoted.set(key, day)
  trackEndUserActive(projectId, endUserId, email).catch(() => {})
}

/**
 * Decide whether a NEW end-user may sign up for this project.
 * Blocks (only the new signup) once distinct MAU for the month, across all of
 * the account's projects, has reached the cap: the plan's included MAU, raised
 * only by the account's spend limit. Existing users are unaffected.
 */
export async function canAcceptNewEndUser(projectId: string): Promise<QuotaDecision> {
  try {
    const info = await accountEntitlements(projectId)
    const included = info?.ent.maxMonthlyActiveUsers ?? null
    if (!info || included === null) return ALLOW
    const count = await accountMau(info.accountId, thisMonth())
    if (count < included) return ALLOW
    const cap = await effectiveCap(info.accountId, 'mau', included, info.ent)
    if (count >= cap) {
      return blocked(
        info.ent.planName,
        `The account this app bills to has reached the ${cap.toLocaleString()} monthly active users its ${info.ent.planName} plan allows across all of its projects. New sign-ups resume on the 1st, or when its limit is raised.`,
        count,
        cap,
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
 * `currentConnections` is the live count the caller already holds for this
 * project (the realtime runtime keeps an in-process registry — all SSE flows
 * through the single `backenly-runtime` process). When the caller can also
 * count other projects, `countProjects` makes the cap pooled across the
 * account's projects like every other quota. Blocks the NEW connection at the
 * cap; existing streams are untouched. Never raised by a spend limit: realtime
 * connections are a hard cap and never billed.
 */
export async function enforceRealtimeConnection(
  projectId: string,
  currentConnections: number,
  countProjects?: (projectIds: string[]) => number,
): Promise<QuotaDecision> {
  try {
    const info = await accountEntitlements(projectId)
    if (!info) return ALLOW
    const { accountId, ent } = info
    const max = ent.maxRealtimeConnections
    if (max === null || max === undefined) return ALLOW
    let existing = currentConnections
    if (countProjects) {
      // The billing account's projects, read from the account. This is not an
      // access decision (the connection was already authorized for this
      // project); it is which live streams share the account's quota.
      const projects = await prisma.project.findMany({ where: accountProjectsWhere(accountId), select: { id: true } })
      const others = projects.map((p) => p.id).filter((id) => id !== projectId)
      existing += countProjects(others)
    }
    fireThresholdWarning(accountId, 'realtime_connections', existing, max, thisMonth())
    if (existing >= max) {
      return blocked(
        ent.planName,
        `The account this app bills to has reached the ${max.toLocaleString()} concurrent realtime connections its ${ent.planName} plan allows across all of its projects.`,
        existing,
        max,
      )
    }
    return ALLOW
  } catch {
    return ALLOW
  }
}

export async function getRealtimeConnectionLimit(projectId: string): Promise<{
  accountId: string
  planName: string
  max: number | null
} | null> {
  try {
    const info = await accountEntitlements(projectId)
    if (!info) return null
    return {
      accountId: info.accountId,
      planName: info.ent.planName,
      max: info.ent.maxRealtimeConnections ?? null,
    }
  } catch {
    return null
  }
}

// ─── PostgreSQL storage (measured) ───────────────────────────────────────────

/**
 * Soft-enforce the account's PostgreSQL storage cap using the most recent
 * measured size of each of its projects (`ProjectUsage.dbStorageUsedMb`,
 * updated by the storage measurement cron), summed across the account. Used by
 * the mutation kernel before structural / bulk writes — we don't pay a size
 * query on every single row insert.
 */
export async function enforceDbStorage(projectId: string): Promise<QuotaDecision> {
  try {
    const info = await accountEntitlements(projectId)
    const maxMb = info?.ent.maxPostgresStorageMb ?? null
    if (!info || maxMb === null) return ALLOW

    const usedBytes = await accountDbBytes(info.accountId)
    const included = maxMb * MB
    if (usedBytes < included) return ALLOW
    const cap = await effectiveCap(info.accountId, 'db_bytes', included, info.ent)
    if (usedBytes >= cap) {
      const usedMb = Math.round(usedBytes / MB)
      const capMb = Math.floor(cap / MB)
      return blocked(
        info.ent.planName,
        `Your account has reached ${capMb.toLocaleString()} MB of PostgreSQL storage, shared by all of your projects, on the ${info.ent.planName} plan. Remove data, raise your spend limit or upgrade to continue.`,
        usedMb,
        capMb,
      )
    }
    return ALLOW
  } catch {
    return ALLOW
  }
}

/** Each of the account's projects' latest measured database size, summed, in bytes. */
async function accountDbBytes(accountId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ mb: number | null }>>`
    SELECT COALESCE(SUM(latest."dbStorageUsedMb"), 0)::float8 AS mb
    FROM (
      SELECT DISTINCT ON (u."projectId") u."dbStorageUsedMb"
      FROM "project_usage" u
      JOIN "projects" p ON p."id" = u."projectId"
      WHERE COALESCE(p."organizationId", p."userId") = ${accountId}
      ORDER BY u."projectId", u."month" DESC
    ) latest`
  return Math.round((rows[0]?.mb ?? 0) * MB)
}

// ─── Plan-driven file-storage limit (consumed by storageQuota.ts) ────────────

/**
 * The file-storage bytes the account's plan includes, for the whole account
 * (every project billed to it shares it). Replaces the hardcoded TIER_QUOTAS
 * table that advertised 50/200 GB but enforced 10/100 GB. Returns null for
 * "unlimited". lib/services/storageQuota.ts compares it with the account's
 * pooled usage and raises it only within the account's spend limit.
 */
export async function getFileStorageLimitBytes(projectId: string): Promise<bigint | null> {
  try {
    const info = await accountEntitlements(projectId)
    if (!info) return null
    const mb = info.ent.maxFileStorageMb
    if (mb === null || mb === undefined) return null // unlimited
    return BigInt(mb) * BigInt(1024 * 1024)
  } catch {
    return null
  }
}

// ─── API key rate ceiling (fair use, never billed) ───────────────────────────

/**
 * Refuse an API key rate its account's plan does not allow, or return null.
 *
 * API requests are never billed; the plan's `apiRateLimitPerMin` is a fair-use
 * ceiling on how fast any one key may be configured to go. A key's own limit
 * is `rateLimit` requests per `rateLimitWindow` seconds, so the comparison is
 * on the per-minute rate that works out to. The plan is the project's account's
 * for a project key and the caller's own account's for an account-level key. A lookup failure
 * refuses nothing: this bounds configuration, it never breaks it.
 */
export async function apiKeyRateCeilingViolation(
  projectId: string | null,
  callerUserId: string,
  rateLimit: number,
  rateLimitWindowSec: number,
): Promise<string | null> {
  try {
    // A project key answers to the project's account; an account-level key
    // to the caller's own.
    let accountId: string | null = null
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true, userId: true } })
      accountId = project ? accountOf(project) : null
    }
    const ent = await getAccountEntitlements(accountId ?? (await accountOfUser(callerUserId)))
    const perMin = ent?.apiRateLimitPerMin ?? null
    if (perMin === null || rateLimitWindowSec <= 0) return null
    const requested = (rateLimit * 60) / rateLimitWindowSec
    if (requested <= perMin) return null
    const allowed = Math.floor((perMin * rateLimitWindowSec) / 60)
    return (
      `The ${ent!.planName} plan allows up to ${perMin.toLocaleString()} requests per minute per API key. ` +
      `For a ${rateLimitWindowSec}-second window that is at most ${allowed.toLocaleString()} requests.`
    )
  } catch {
    return null
  }
}
