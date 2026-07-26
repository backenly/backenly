/**
 * Billing Seed Script — Backenly 3-Plan Architecture (v4)
 *
 * Plans (internal code → display name):
 *   SANDBOX → Free        $0/mo    — 200 AI credits/mo, autonomy every 30 min
 *   BUILDER → Pro         $25/mo   — 3,000 AI credits/mo, 30-min funded autonomy
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
 * stable ratio). The always-on autonomy loop (monitor + self-repair) NEVER
 * deducts user credits — the platform funds it on every tier; Free gets a
 * bounded daily taste that converts (see lib/ai/background-monitor.ts).
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

    // Autonomy: self-healing is the product — Free gets the full dial on a
    // 30-min cadence (founder decisions 2026-07-18 + 2026-07-23; Pro runs
    // every minute). Cadence AND the monthly scan budget are the Free↔Pro
    // conversion levers: after ~120 loop runs/mo it degrades to detect-only.
    autonomyScanIntervalMin: 30,               // every 30 min
    autonomyMonthlyScanBudget: 120,            // ~4 healing windows/day, then detect-only
    autonomyMaxLevel: 'AGGRESSIVE',            // full dial — Autopilot available
    autonomyMaxActionsPerWindow: 5,
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
  // they don't have: the 30-min autonomous self-healing loop (deterministic — no model, no credits)
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
    autonomyMaxActionsPerWindow: 20,
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
    autonomyMaxActionsPerWindow: 50,
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
  console.log('  Free (SANDBOX):        $0/mo   — 200 AI credits/mo, autonomy every 30 min (~30/mo then detect-only), 50k MAU')
  console.log('  Pro (BUILDER):         $25/mo  — 3,000 AI credits/mo, 30-min funded autonomy (full dial), 200k MAU, 10 GB PG + 100 GB files')
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
