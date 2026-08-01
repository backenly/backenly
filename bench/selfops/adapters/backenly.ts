/**
 * SELFOPS-BENCH — the Backenly lane
 * =================================
 *
 * Drives the real production loop. No stub, no shim, no benchmark-only fix
 * path: `runReconcilerLive` is the exact function the cron calls in production
 * (lib/autonomy/reconciler.ts), reaching the same deterministic repair kernel
 * through `runAutoFix`. If this lane heals a case, production heals that case.
 *
 * ── Two entry points, and why this one ──────────────────────────────────────
 *
 * Production calls `runReconciler`, which wraps `runReconcilerLive` in three
 * gates: a feature flag, the plan's cadence cooldown, and the per-project dial.
 * The bench calls `runReconcilerLive` directly and drives cycles itself.
 *
 * That is a deliberate, declared choice, not a convenience. Cadence is a
 * deployment policy (currently every minute on every plan), and folding it into
 * the measurement would make the headline number a function of how fast CI's
 * clock runs. So the unit of time here is a CYCLE, not a second, and wall-clock
 * MTTR is derived downstream as `cycles x cadence`. The dial and the circuit
 * breaker are NOT bypassed — they live inside `runReconcilerLive` and still
 * bound everything this lane is allowed to do.
 *
 * ── The provisioning detail that decides the score ──────────────────────────
 *
 * `getProjectAutonomyLevel` clamps the owner's dial to their plan ceiling, and
 * falls back to CONSERVATIVE whenever it cannot resolve a subscription.
 * CONSERVATIVE permits Tier-0 repairs only — indexes and API surfaces — so a
 * benchmark project provisioned without a subscription row would silently never
 * repair an RLS fault, and the suite would publish a number that understates
 * the platform for a reason that has nothing to do with the platform.
 *
 * So the lane provisions a real SANDBOX (Free) subscription and asserts the
 * resolved level afterwards. The bench reports the level it actually ran at.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { runReconcilerLive } from '@/lib/autonomy/reconciler'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { jwtClaimFunctionSql } from '@/lib/postgrest/rls-translation'
import type { CaseContext, LaneAdapter, TickResult } from '../types'
import { ownerExec, ownerQuery, ensureDataPlaneRoles, grantTableAccess } from '../oracle'

const prisma = new PrismaClient()

/**
 * The plan the lane runs on. Free is the honest default to publish: it is the
 * tier a reader can verify for themselves at no cost, and every plan seeds the
 * same autonomy entitlements anyway (prisma/seed-billing.ts).
 */
const BENCH_PLAN = 'SANDBOX'

async function ensurePlan(): Promise<string> {
  const existing = await prisma.plan.findUnique({ where: { name: BENCH_PLAN } })
  if (existing) return existing.id

  // A bare CI database has no billing seed. Create the plan with the same
  // autonomy entitlements seed-billing.ts gives Free, so the lane cannot
  // accidentally benchmark a more generous tier than a real free user gets.
  const created = await prisma.plan.create({
    data: {
      name: BENCH_PLAN,
      priceCents: 0,
      autonomyScanIntervalMin: 1,
      autonomyMaxLevel: 'AGGRESSIVE',
      autonomyMaxActionsPerWindow: null,
      isSandboxPlan: true,
    },
  })
  return created.id
}

export interface BackenlyLaneInfo {
  /** The dial the loop actually resolved to. Published with the results. */
  resolvedLevel: string
  plan: string
}

export const laneInfo: BackenlyLaneInfo = { resolvedLevel: 'unresolved', plan: BENCH_PLAN }

export const backenlyLane: LaneAdapter = {
  name: 'backenly-autopilot',
  healer: 'resident MAPE-K loop (lib/autonomy/reconciler.ts) — no agent, no session, no human',

  async provision(): Promise<CaseContext> {
    await ensureDataPlaneRoles()

    const userId = randomUUID()
    const projectId = randomUUID()
    const schema = `workspace_${projectId}`
    const planId = await ensurePlan()

    await prisma.user.create({
      data: {
        id: userId,
        email: `selfops-bench+${userId.slice(0, 8)}@backenly.test`,
        name: 'selfops-bench',
        password: 'not-a-real-hash',
      },
    })
    await prisma.subscription.create({
      data: { userId, planId, status: 'FREE' },
    })
    await prisma.project.create({
      data: { id: projectId, name: `selfops-bench-${projectId.slice(0, 8)}`, userId },
    })
    await ownerExec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

    // The per-schema claim reader every translated RLS policy calls. Imported
    // from lib/postgrest/rls-translation rather than copied, so the bench cannot
    // drift from the definition the platform actually installs — a benchmark
    // running against a hand-rolled approximation of the data plane would be
    // measuring the approximation.
    await ownerExec(jwtClaimFunctionSql(schema))

    // Record what the loop will actually run at. A lane that silently ran at
    // CONSERVATIVE would report Tier-1 faults as unhealable platform failures.
    laneInfo.resolvedLevel = await getProjectAutonomyLevel(projectId)

    return {
      projectId,
      userId,
      schema,
      sql: (statement: string) => ownerExec(statement),
      query: <T = Record<string, unknown>>(statement: string, params: unknown[] = []) =>
        ownerQuery<T>(statement, params),
      createTable: async (name: string, columnsSql: string) => {
        await ownerExec(`CREATE TABLE "${schema}"."${name}" (${columnsSql})`)
        // Register in the control plane. Without this row the table is an
        // `orphan_table` to the platform — a real finding, but not the one the
        // case is testing, and one that competes for the repair budget.
        await prisma.table.create({
          data: { name, schema, projectId },
        })
        await grantTableAccess(schema, name)
      },
    }
  },

  /**
   * One full cycle of the production loop.
   *
   * Token accounting is a delta across the cycle rather than a claim: the loop
   * is supposed to be model-free, and "supposed to be" is exactly the kind of
   * assertion a benchmark exists to replace with a measurement.
   */
  async tick(ctx: CaseContext): Promise<TickResult> {
    const tokensBefore = await sumTokens(ctx.projectId)

    const result = await runReconcilerLive(ctx.projectId)

    const tokensAfter = await sumTokens(ctx.projectId)
    const openFindings = await prisma.healthFinding
      .count({
        where: { projectId: ctx.projectId, status: { in: ['open', 'pending_approval'] } },
      })
      .catch(() => 0)

    if (!result) {
      return {
        openFindings,
        attempted: 0,
        applied: 0,
        escalated: 0,
        blocked: true,
        note: 'runReconcilerLive returned null — the cycle threw and was swallowed',
        tokensSpent: tokensAfter - tokensBefore,
      }
    }

    // One bench cycle is one PRODUCTION tick, and production ticks are a minute
    // apart. See advanceClock — without it the measurement is a property of how
    // fast the runner executes, not of the platform.
    await advanceClock(ctx.projectId, CYCLE_INTERVAL_MS)

    return {
      openFindings,
      attempted: result.attempted,
      applied: result.applied,
      escalated: result.escalated,
      blocked: result.frozen || result.deferred > 0,
      note: result.frozen
        ? 'change freeze — project mid-incident, autonomous changes suspended this cycle'
        : result.deferred > 0
          ? `${result.deferred} repair(s) deferred by the mutation cooldown`
          : undefined,
      tokensSpent: tokensAfter - tokensBefore,
    }
  },

  async teardown(ctx: CaseContext): Promise<void> {
    await ownerExec(`DROP SCHEMA IF EXISTS "${ctx.schema}" CASCADE`).catch(() => {})
    // Project rows cascade from the user; findings and audit rows cascade from
    // the project. Deleting the user is enough, but be explicit so a partial
    // provision (user created, project not) still cleans up.
    await prisma.project.deleteMany({ where: { id: ctx.projectId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: ctx.userId } }).catch(() => {})
  },
}

/**
 * Production cadence: every plan, including Free, reconciles every minute.
 * One bench cycle represents one of those ticks.
 */
const CYCLE_INTERVAL_MS = 60 * 1000

/**
 * Advance this project's virtual clock by one production tick.
 *
 * ── Why this is required for the measurement to mean anything ───────────────
 *
 * The platform paces itself against wall-clock timestamps it has written:
 *
 *   BackgroundJob.completedAt   2-minute post-mutation cooldown (build-lock.ts)
 *   BackgroundJob.startedAt     10 mutations/hour budget
 *   AutonomousAction.createdAt  15-minute post-fix cooldown (orchestration-governor.ts)
 *   AuditLog.timestamp          the circuit breaker's rolling window
 *
 * In production those gates are almost never binding: ticks arrive 60s apart, so
 * a 2-minute cooldown costs one skipped tick. The bench runs its cycles
 * back-to-back in milliseconds, so the FIRST repair sets a cooldown that blocks
 * every remaining cycle — and the platform gets scored as unable to fix a fault
 * it would have fixed two minutes later. That was measured, not hypothesised:
 * on the first run `fk-column-unindexed` applied one repair on cycle 1 and then
 * spent eleven cycles deferred, inside a two-second wall-clock window.
 *
 * So the harness moves the clock instead of sleeping. Twelve cycles at a real
 * 60s cadence would take twelve minutes per case and nobody would run the suite.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *
 * It does not pass `skipCooldown` to runAutoFix, and it does not disable,
 * shorten or bypass any governance check. Every gate runs exactly as written and
 * still gets to refuse. The only thing that changes is what time the platform
 * believes it is — which is the one variable the runner would otherwise be
 * silently controlling.
 *
 * Backdating is scoped to the single throwaway project under test.
 */
async function advanceClock(projectId: string, byMs: number): Promise<void> {
  const shift = `${byMs} milliseconds`
  await Promise.all([
    prisma.$executeRawUnsafe(
      `UPDATE background_jobs
         SET "completedAt" = "completedAt" - INTERVAL '${shift}',
             "startedAt"   = "startedAt"   - INTERVAL '${shift}',
             "createdAt"   = "createdAt"   - INTERVAL '${shift}',
             "runAt"       = "runAt"       - INTERVAL '${shift}'
       WHERE "projectId" = $1`,
      projectId,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE autonomous_actions
         SET "createdAt" = "createdAt" - INTERVAL '${shift}'
       WHERE "projectId" = $1`,
      projectId,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE audit_logs
         SET "timestamp" = "timestamp" - INTERVAL '${shift}'
       WHERE "projectId" = $1`,
      projectId,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE execution_logs
         SET "createdAt" = "createdAt" - INTERVAL '${shift}'
       WHERE "projectId" = $1`,
      projectId,
    ),
  ]).catch((err: any) => {
    // Loud: a silent failure here reintroduces the exact artifact this exists to
    // remove, and the suite would publish an understated number.
    console.warn(`[selfops-bench] advanceClock failed for ${projectId}: ${err?.message}`)
  })
}

async function sumTokens(projectId: string): Promise<number> {
  const agg = await prisma.aiUsage
    .aggregate({ where: { projectId }, _sum: { totalTokens: true } })
    .catch(() => null)
  return agg?._sum.totalTokens ?? 0
}

export async function disconnectLane(): Promise<void> {
  await prisma.$disconnect().catch(() => {})
}
