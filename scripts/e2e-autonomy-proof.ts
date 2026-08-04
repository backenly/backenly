/**
 * e2e-autonomy-proof.ts — does the loop ACTUALLY heal a real backend?
 *
 * Not a unit test and not a mock. This builds a real project with a real
 * workspace schema on a real plan, breaks it in ways the invariant catalogue is
 * supposed to catch, runs the SAME dispatcher the production cron calls
 * (`runReconciler`), and then asks PostgreSQL — not the audit log, not the
 * finding row — whether the defect is actually gone.
 *
 * The distinction matters: every "we healed it" signal in this codebase is
 * written by the code under test. Only the catalog can say if a repair landed.
 *
 * Usage:
 *   npx tsx scripts/e2e-autonomy-proof.ts             # honours the 2-min cooldown
 *   npx tsx scripts/e2e-autonomy-proof.ts --patient   # sleeps it out (slow, complete)
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

const prisma = new PrismaClient()
const PATIENT = process.argv.includes('--patient')
/** Backdate the cooldown rows instead of sleeping — same gate, same decision. */
const FASTCLOCK = process.argv.includes('--fastclock')

const q = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <T = any>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql)

let userId = ''
let projectId = ''
let planId = ''
let schema = ''

const pass: string[] = []
const fail: string[] = []

function check(ok: boolean, label: string, detail = '') {
  ;(ok ? pass : fail).push(label)
  console.log(`   ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function setup() {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `e2e-autonomy+${userId.slice(0, 8)}@backenly.test`,
      name: 'e2e autonomy proof',
      password: 'not-a-real-hash',
    },
  })

  // Subscribe exactly the way signup does — createFreeSubscription resolves the
  // seeded SANDBOX plan. Deliberately NOT a hand-built plan row: the entitlements
  // the loop reads come from prisma/seed-billing.ts, so a fixture that mints its
  // own plan would prove the loop works on a plan no real user ever has. This
  // path fails loudly if the seed has not been run, which is the point.
  const { createFreeSubscription } = await import('@/lib/billing')
  const sub = await createFreeSubscription(userId)
  planId = sub.planId

  await prisma.project.create({
    data: { id: projectId, name: 'e2e-autonomy-proof', userId, autonomyLevel: 'AGGRESSIVE' } as any,
  })

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

  // ── The broken backend ─────────────────────────────────────────────────────
  // orders.user_id — a relationship column with no index (Tier 0, silent) and
  // the whole table with no row-level security (Tier 1, announced).
  await q(`
    CREATE TABLE "${schema}"."orders" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      total numeric NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await prisma.table.create({
    data: { projectId, name: 'orders', schema, description: 'e2e fixture' },
  })
}

async function teardown() {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceSchemaSnapshot.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.subscription.deleteMany({ where: { userId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
}

// ── Ground truth, read from the catalog rather than from our own logs ────────

async function indexedColumns(): Promise<string[]> {
  const r = await rows<{ col: string }>(`
    SELECT DISTINCT a.attname AS col
    FROM pg_index i
    JOIN pg_class c     ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
    WHERE n.nspname = '${schema}' AND c.relname = 'orders'
  `)
  return r.map(x => x.col).sort()
}

async function rlsEnabled(): Promise<boolean> {
  const r = await rows<{ relrowsecurity: boolean }>(`
    SELECT c.relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '${schema}' AND c.relname = 'orders'
  `)
  return r[0]?.relrowsecurity === true
}

async function policies(): Promise<string[]> {
  const r = await rows<{ policyname: string; qual: string | null }>(
    `SELECT policyname, qual FROM pg_policies WHERE schemaname = '${schema}' AND tablename = 'orders'`,
  )
  return r.map(x => `${x.policyname}[${x.qual ?? 'null'}]`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('\n════ E2E AUTONOMY PROOF ════\n')
  await setup()
  console.log(`project = ${projectId}`)
  console.log(`schema  = ${schema}`)
  console.log(`mode    = ${PATIENT ? 'patient (sleeps out the 2-min cooldown)' : 'fast'}\n`)

  console.log('1) Baseline — is the backend really broken?')
  const idx0 = await indexedColumns()
  console.log(`   indexed columns: ${JSON.stringify(idx0)}`)
  check(!idx0.includes('user_id'), 'orders.user_id starts with NO index')
  check(!(await rlsEnabled()), 'orders starts with RLS DISABLED')

  console.log('\n2) Detection — does the catalogue see it?')
  const { computeDesiredStateDiff, gapIdentity } = await import('@/lib/autonomy/desired-state')
  const report = await computeDesiredStateDiff(projectId)
  for (const v of report.violations) {
    console.log(
      `   • ${gapIdentity(v.type, v.details as any).padEnd(46)} tier=${v.tier} sev=${v.severity} inv=${v.invariantId}`,
    )
  }
  if (report.errors.length) console.log(`   probeErrors: ${JSON.stringify(report.errors)}`)

  const ids = report.violations.map(v => gapIdentity(v.type, v.details as any))
  check(ids.includes('missing_fk_index::orders.user_id'), 'detects the missing index on orders.user_id')
  check(
    report.violations.some(v =>
      ['missing_rls', 'unprotected_user_data'].includes(v.type) &&
      ((v.details as any)?.tableName === 'orders'),
    ),
    'detects unprotected data on orders',
  )

  console.log('\n3) Planning — what would the loop DO about it?')
  const { computeReconciliationPlan, runReconciler } = await import('@/lib/autonomy/reconciler')
  const plan = await computeReconciliationPlan(projectId)
  console.log(`   level=${plan.level} budget=${plan.autoBudget}`)
  for (const d of plan.decisions) {
    console.log(`   • ${gapIdentity(d.type, d.gap.details as any).padEnd(46)} → ${d.action}`)
  }
  check(plan.level === 'AGGRESSIVE', 'dial resolves to AGGRESSIVE on an AGGRESSIVE-capped plan', `got ${plan.level}`)
  check(plan.counts.WOULD_AUTO_APPLY > 0, 'plans at least one auto-apply', `${plan.counts.WOULD_AUTO_APPLY} gap(s)`)

  console.log('\n4) Execution — running runReconciler (the exact fn the cron calls)')
  const TICKS = PATIENT ? 8 : FASTCLOCK ? 10 : 4
  for (let i = 1; i <= TICKS; i++) {
    // The cadence gate reads audit rows; clear the tick markers so each pass is
    // allowed to run (the gate lives in the dispatcher, not in the fix path).
    await prisma.auditLog.deleteMany({
      where: {
        projectId,
        action: { in: ['AUTONOMY_TICK', 'AUTONOMY_LIVE_RUN', 'AUTONOMY_SHADOW_DECISION', 'AUTONOMY_CHANGE_FREEZE'] },
      },
    })
    const res: any = await runReconciler(projectId)
    if (res && 'applied' in res) {
      console.log(
        `   tick ${i}: attempted=${res.attempted} applied=${res.applied} ` +
        `escalated=${res.escalated} deferred=${res.deferred} frozen=${res.frozen}`,
      )
    } else if (res) {
      console.log(`   tick ${i}: SHADOW ONLY — decided, executed nothing. counts=${JSON.stringify(res.counts)}`)
    } else {
      console.log(`   tick ${i}: null (loop disabled or cadence-gated)`)
    }
    if (PATIENT && i < TICKS) {
      console.log('      … sleeping 125s to clear the post-mutation cooldown')
      await sleep(125_000)
    } else if (FASTCLOCK && i < TICKS) {
      // Time travel instead of sleeping. The cooldown gate compares
      // BackgroundJob.completedAt against now-2min, so backdating those rows is
      // exactly equivalent to having waited — same code path, same decision.
      const shifted = await prisma.$executeRawUnsafe(`
        UPDATE background_jobs
           SET "completedAt" = "completedAt" - interval '10 minutes',
               "startedAt"   = "startedAt"   - interval '10 minutes'
         WHERE "projectId" = '${projectId}' AND type = 'build_lock'
      `).catch(() => 0)
      console.log(`      … time-travelled ${shifted} build_lock row(s) back 10 min (cooldown cleared)`)
    }
  }

  console.log('\n5) Ground truth — did the DATABASE actually change?')
  const idx1 = await indexedColumns()
  const rls1 = await rlsEnabled()
  const pol1 = await policies()
  console.log(`   indexed columns now: ${JSON.stringify(idx1)}`)
  console.log(`   rls enabled: ${rls1}   policies: ${JSON.stringify(pol1)}`)
  check(idx1.includes('user_id'), 'orders.user_id NOW HAS an index (real DDL landed)')

  console.log('\n6) Bookkeeping honesty — do the records match PostgreSQL?')
  const findings = await prisma.healthFinding.findMany({
    where: { projectId },
    select: { type: true, status: true, details: true },
  })
  let lied = 0
  for (const f of findings) {
    const d = f.details as any
    const col = d?.columnName ?? d?.column ?? ''
    const ver = d?.rollbackData?.verification ?? '—'
    const claimsFixed = f.status === 'auto_fixed'
    // A claimed index fix whose column is still unindexed is a phantom fix.
    const phantom =
      claimsFixed && f.type === 'missing_fk_index' && col && !idx1.includes(col)
    if (phantom) lied++
    console.log(
      `   ${f.type.padEnd(22)} col=${String(col).padEnd(12)} status=${String(f.status).padEnd(16)} ` +
      `verification=${String(ver).padEnd(10)}${phantom ? '  ← PHANTOM' : ''}`,
    )
  }
  check(lied === 0, 'no finding claims auto_fixed while the defect is still present in PostgreSQL', `${lied} phantom(s)`)

  const audits = await prisma.auditLog.findMany({ where: { projectId }, select: { action: true } })
  const byAction = audits.reduce<Record<string, number>>((a, r) => {
    a[r.action] = (a[r.action] ?? 0) + 1
    return a
  }, {})
  console.log(`   audit actions: ${JSON.stringify(byAction)}`)

  console.log('\n════ RESULT ════')
  console.log(`passed ${pass.length} / ${pass.length + fail.length}`)
  if (fail.length) {
    console.log('\nFAILED:')
    for (const f of fail) console.log(`  ✗ ${f}`)
  }
  console.log('')
}

main()
  .catch(e => {
    console.error('\nHARNESS ERROR:', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await teardown().catch(() => {})
    await prisma.$disconnect()
  })
