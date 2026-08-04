/**
 * Billing Seed Script — Backenly 3-Plan Architecture (v4)
 *
 * Plans (internal code → display name):
 *   SANDBOX → Free        $0/mo    — 200 AI credits/mo, autonomy every minute
 *   BUILDER → Pro         $25/mo   — 3,000 AI credits/mo, unlimited autonomy windows
 *   SCALE   → Enterprise  Custom   — sales-led, custom limits, SSO + SLA
 *
 * v4 (2026-07-17): the old Starter ($19) / Pro ($99) split collapsed into a
 * single $25 Pro tier priced head-to-head with the standard BaaS Pro tier.
 * SCALE was repurposed as the sales-led Enterprise template (no self-serve
 * checkout — see app/api/billing/create-checkout). Internal plan codes were
 * deliberately kept stable so subscriptions, Paddle env keys, and every
 * plan-name switch in the codebase keep working; ONLY prices, quotas, and
 * display names moved.
 *
 * AI is metered as token-backed credits (1 credit = 1,000 tokens — published,
 * stable ratio). The always-on autonomy loop (monitor + self-repair) never
 * deducts user credits because it runs no model. Every plan gets the same
 * every-minute cadence; Free is bounded by windows/month and fixes/window.
 *
 * No pay-as-you-go or usage-based billing. Paid plans are flat monthly rates.
 * Projects are not capped on paid plans — MAU is the real constraint.
 *
 * Run: npx tsx prisma/seed-billing.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const PLANS = [
  // ─── FREE — $0/mo, 1 live project, permanently deployed ──────────────────
  {
    name: 'SANDBOX',
    priceCents: 0,
    annualPriceCents: null,

    maxProjects: 1,                            // 1 project
    maxMonthlyActiveUsers: 50_000,             // up to 50,000 distinct end-users/month
    maxAiBuildActionsPerMonth: 20,             // legacy display only — superseded by monthlyAiCredits
    monthlyAiCredits: 200,                     // 200 token-backed AI credits/month (1 credit = 1k tokens)

    // ── Autonomy: same cadence as Pro, deliberately (founder decision 2026-07-26)
    //
    // The reconciler is deterministic — probes detect drift, each finding maps
    // to a typed action that compiles to SQL. Measured in production: 145 ticks,
    // 48 live runs and 3 real repairs in 24h against ZERO rows in ai_usage. It
    // spends no tokens, so charging for how OFTEN it runs was rationing
    // something that costs nothing to give.
    //
    // Neither Supabase nor InsForge has an autonomy loop at all, so "your
    // backend heals itself every minute, free forever" is the sharpest thing we
    // can say — and gating it behind $25 blunted our own best argument.
    //
    // Healing is NOT a conversion lever. A backend that stops repairing itself
    // after N fixes is a broken backend, and metering that would sell exactly
    // the failure mode the product exists to remove. Every plan — Free included
    // — scans every minute and repairs without limit. Free↔Pro converts on
    // capacity (projects, MAU, storage, AI credits), never on whether the loop
    // is allowed to keep working.
    //
    // The real cost of this change is audit volume, not compute: every tick
    // writes an AUTONOMY_TICK row, so a project goes from ~1.4k to ~43k rows a
    // month. Fine at current scale (audit_logs was 1 MB total when this landed);
    // needs a retention policy before free signups reach the thousands.
    autonomyScanIntervalMin: 1,                // every minute — same as Pro
    autonomyMonthlyScanBudget: null,           // unlimited healing windows — never degrades to detect-only
    autonomyMaxLevel: 'AGGRESSIVE',            // full dial — Autopilot available
    autonomyMaxActionsPerWindow: null,         // unlimited fixes per window — same as every other plan
    maxApiRequestsPerMonth: BigInt(100_000),   // 100k API requests TOTAL (lifetime — see apiQuotaIsLifetime)
    apiQuotaIsLifetime: true,                  // Free's API cap is a lifetime total, never resets
    maxPostgresStorageMb: 512,                 // 512 MB PostgreSQL
    maxFileStorageMb: 1_024,                   // 1 GB file storage
    maxRealtimeConnections: 25,
    maxAiFunctionInvocationsPerMonth: 10_000,  // 10k invocations/mo — runtime execution is near-zero cost; generation is credit-metered
    maxTriggersPerProject: 0,                  // no event triggers
    maxTeamSeats: 1,
    maxDeploymentHistory: 0,

    logRetentionDays: 7,
    supportResponseHours: null,                // community only
    allowedAuthProviders: ['email', 'google', 'github'],

    allowCustomDomain: false,
    allowAdvancedMonitoring: false,
    allowRbac: false,
    allowSso: false,
    allowDeploymentRollback: false,
    allowWebhooks: false,
    prioritySupport: false,

    allowDeployment: true,                     // ✅ permanently live — no expiry
    isSandboxPlan: false,                      // project never expires
    sandboxExpiryDays: null,
    isPayAsYouGo: false,

    maxRowsPerProject: null,
    apiRateLimitPerMin: 60,
    maxAiIntentsPerDay: null,
  },

  // ─── PRO (BUILDER) — $25/mo flat rate, the single self-serve paid tier ─────
  // Priced against the standard BaaS Pro tier ($25). Where they
  // meter overages per GB/MAU, this stays flat — and includes the two things
  // they don't have: unlimited every-minute autonomous self-healing (runs no model)
  // and token-backed AI credits with a published, stable ratio.
  {
    name: 'BUILDER',
    priceCents: 2500,                         // $25/mo flat
    annualPriceCents: 2000,                   // $20/mo when billed annually ($240/yr)

    maxProjects: null,                        // no hard cap — MAU is the real constraint
    maxMonthlyActiveUsers: 200_000,           // up to 200,000 distinct end-users/month (2× the standard BaaS Pro tier)
    maxAiBuildActionsPerMonth: 300,           // legacy display only — superseded by monthlyAiCredits
    monthlyAiCredits: 3_000,                  // 3,000 token-backed AI credits/month

    // Autonomy: deterministic (spends no tokens), ALL four dial modes (OFF → AGGRESSIVE),
    // effectively continuous — the loop may run every minute.
    autonomyScanIntervalMin: 1,               // every minute (effectively always-on)
    autonomyMonthlyScanBudget: null,          // unlimited (fair-use within cadence)
    autonomyMaxLevel: 'AGGRESSIVE',           // full dial
    autonomyMaxActionsPerWindow: null,        // unlimited — healing is never metered on any plan
    maxApiRequestsPerMonth: null,             // unlimited API requests (fair use)
    apiQuotaIsLifetime: false,
    maxPostgresStorageMb: 10_240,             // 10 GB PostgreSQL
    maxFileStorageMb: 102_400,                // 100 GB file storage
    maxRealtimeConnections: 1_000,
    maxAiFunctionInvocationsPerMonth: 2_000_000, // 2M function invocations/month
    maxTriggersPerProject: null,              // unlimited triggers
    maxTeamSeats: 5,
    maxDeploymentHistory: null,               // full history

    logRetentionDays: 30,
    supportResponseHours: null,               // email support (no SLA hours)
    allowedAuthProviders: ['email', 'google', 'github'],

    allowCustomDomain: true,
    allowAdvancedMonitoring: true,
    allowRbac: true,                          // org roles ship with team seats
    allowSso: false,                          // SSO/OIDC is Enterprise
    allowDeploymentRollback: true,
    allowWebhooks: true,
    prioritySupport: false,

    allowDeployment: true,
    isSandboxPlan: false,
    sandboxExpiryDays: null,
    isPayAsYouGo: false,                      // flat monthly rate — no usage charges

    maxRowsPerProject: null,
    apiRateLimitPerMin: 1_000,
    maxAiIntentsPerDay: null,
  },

  // ─── ENTERPRISE (SCALE) — sales-led, custom pricing ────────────────────────
  // This row is the TEMPLATE for enterprise deals: sales assigns it, then
  // adjusts limits per contract. priceCents 0 = "custom" (never rendered as a
  // price anywhere — every surface shows "Custom" + contact sales). There is
  // deliberately NO self-serve checkout for this plan.
  {
    name: 'SCALE',
    priceCents: 0,                            // custom — set per contract, never displayed
    annualPriceCents: null,

    maxProjects: null,
    maxMonthlyActiveUsers: null,              // custom MAU
    maxAiBuildActionsPerMonth: null,          // legacy display only
    monthlyAiCredits: null,                   // custom credit pool (unlimited by default)

    // Autonomy: custom cadence per contract; 1-min floor, everything funded.
    autonomyScanIntervalMin: 1,
    autonomyMonthlyScanBudget: null,
    autonomyMaxLevel: 'AGGRESSIVE',
    autonomyMaxActionsPerWindow: null,        // unlimited — healing is never metered on any plan
    maxApiRequestsPerMonth: null,             // unlimited
    apiQuotaIsLifetime: false,
    maxPostgresStorageMb: null,               // custom / dedicated capacity
    maxFileStorageMb: null,
    maxRealtimeConnections: null,
    maxAiFunctionInvocationsPerMonth: null,
    maxTriggersPerProject: null,
    maxTeamSeats: 100,
    maxDeploymentHistory: null,

    logRetentionDays: 90,
    supportResponseHours: 12,                 // 12-hour priority SLA
    allowedAuthProviders: ['email', 'google', 'github', 'oidc'],

    allowCustomDomain: true,
    allowAdvancedMonitoring: true,
    allowRbac: true,
    allowSso: true,
    allowDeploymentRollback: true,
    allowWebhooks: true,
    prioritySupport: true,

    allowDeployment: true,
    isSandboxPlan: false,
    sandboxExpiryDays: null,
    isPayAsYouGo: false,

    maxRowsPerProject: null,
    apiRateLimitPerMin: 2_000,
    maxAiIntentsPerDay: null,
  },
]

async function main() {
  console.log('🌱 Seeding Backenly billing plans (v4: Free / Pro $25 / Enterprise custom)...\n')

  for (const planData of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { name: planData.name },
      update: planData,
      create: planData,
    })
    const monthly =
      plan.name === 'SCALE' ? 'Custom' : plan.priceCents === 0 ? 'Free' : `$${(plan.priceCents / 100).toFixed(0)}/mo`
    const annual = plan.annualPriceCents ? ` (annual: $${(plan.annualPriceCents / 100).toFixed(0)}/mo)` : ''
    const sandbox = plan.isSandboxPlan ? ` [expires in ${plan.sandboxExpiryDays}d]` : ''
    console.log(`✅  ${plan.name.padEnd(10)} ${monthly}${annual}${sandbox}`)
  }

  // Backfill SANDBOX subscriptions for existing users without any subscription
  const sandboxPlan = await prisma.plan.findUnique({ where: { name: 'SANDBOX' } })
  if (!sandboxPlan) throw new Error('SANDBOX plan not found after seeding')

  const usersWithoutSubscription = await prisma.user.findMany({
    where: { subscriptions: { none: {} } },
    select: { id: true, email: true },
  })

  if (usersWithoutSubscription.length > 0) {
    console.log(`\n📝 Backfilling SANDBOX subscriptions for ${usersWithoutSubscription.length} user(s)...`)
    for (const user of usersWithoutSubscription) {
      await prisma.subscription.create({
        data: { userId: user.id, planId: sandboxPlan.id, status: 'FREE' },
      })
      console.log(`   ✅  ${user.email}`)
    }
  }

  console.log('\n✨ Billing seed complete.')
  console.log('\nPlan summary:')
  console.log('  Free (SANDBOX):        $0/mo   — 200 AI credits/mo, autonomy every minute (uncapped, full dial), 50k MAU')
  console.log('  Pro (BUILDER):         $25/mo  — 3,000 AI credits/mo, autonomy every minute (uncapped, full dial — identical to Free), 200k MAU, 10 GB PG + 100 GB files')
  console.log('  Enterprise (SCALE):    Custom  — custom limits, SSO, 12h SLA, sales-led (no self-serve checkout)')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
