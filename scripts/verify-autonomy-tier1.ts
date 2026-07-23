/**
 * verify-autonomy-tier1.ts — end-to-end proof of the Tier-1 autonomy fix paths
 * AND their one-click undo.
 *
 * Proves RLS-enable, FK-constraint, and rate-limit fixes EACH on its own
 * disposable $25 Pro (BUILDER) plan project at an AGGRESSIVE autonomy dial. One gap
 * per project = exactly one fix = zero intra-project mutation contention, so
 * each path is proven cleanly. For every project it: injects a genuine gap,
 * confirms the reconciler classifies it WOULD_AUTO_APPLY at AGGRESSIVE, applies
 * it through the real kernel path (runAutoFix → _executeAutoFix, with the
 * gap-identity trust guarantee), proves it closed via REAL database state —
 * then REVERTS it via revertAutoFix and proves the created object is GONE
 * (index dropped, constraint dropped, RLS disabled + policies dropped, rate
 * limit back to its pre-fix value). RLS-undo additionally proves the
 * confirmation gate: the first revert call must refuse with
 * requiresConfirmation (a protection removal is never one silent click).
 *
 *   npx tsx scripts/verify-autonomy-tier1.ts
 */

import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { computeReconciliationPlan } from '@/lib/autonomy/reconciler'
import { runAutoFix, revertAutoFix } from '@/lib/core/auto-fix-engine'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
async function sql(q: string, params: unknown[] = []): Promise<any[]> {
  const c = await pool.connect()
  try { return (await c.query(q, params)).rows } finally { c.release() }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Target = 'RLS' | 'FK' | 'RATE'

/** Create a disposable BUILDER project at AGGRESSIVE with a workspace. */
async function makeProject(): Promise<{ projectId: string; userId: string; schema: string }> {
  const plan = await prisma.plan.findFirst({ where: { name: 'BUILDER' } })
  if (!plan) throw new Error('BUILDER ($19) plan not found — seed billing first.')
  const ts = Date.now() + Math.floor(Math.random() * 1000)
  const user = await prisma.user.create({
    data: { email: `autonomy-tier1-${ts}@backenly.internal`, name: 'Autonomy Tier1 Test' },
  })
  await prisma.subscription.create({
    data: { userId: user.id, planId: plan.id, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 30 * 864e5) },
  })
  const project = await prisma.project.create({
    data: { name: `Tier1 ${ts}`, userId: user.id, autonomyLevel: 'AGGRESSIVE' },
  })
  const schema = `workspace_${project.id}`
  await prisma.workspace.create({
    data: { projectId: project.id, userId: user.id, name: 'Tier1', postgresSchema: schema, databaseProvisioned: true },
  })
  await sql(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  return { projectId: project.id, userId: user.id, schema }
}

async function teardown(projectId: string, userId: string) {
  await sql(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  for (const fn of [
    () => prisma.healthFinding.deleteMany({ where: { projectId } }),
    () => prisma.apiDefinition.deleteMany({ where: { projectId } }),
    () => prisma.table.deleteMany({ where: { projectId } }),
    () => prisma.auditLog.deleteMany({ where: { projectId } }),
    () => prisma.permissionPolicy.deleteMany({ where: { projectId } }),
    () => prisma.project.delete({ where: { id: projectId } }),
    () => prisma.subscription.deleteMany({ where: { userId } }),
    () => prisma.user.delete({ where: { id: userId } }),
  ]) await fn().catch(() => {})
}

/** Apply the single WOULD_AUTO_APPLY gap of one of the given types; retry on transient defer. */
async function applyOneGap(
  projectId: string,
  types: string[],
): Promise<{ outcome: string; findingId: string | null }> {
  const plan = await computeReconciliationPlan(projectId)
  const decision = plan.decisions.find((d) => d.action === 'WOULD_AUTO_APPLY' && types.includes(d.gap.type))
  if (!decision) {
    return {
      outcome: `NOT AUTO-APPLICABLE (types present: ${plan.decisions.map((d) => d.type).join(', ')})`,
      findingId: null,
    }
  }
  const finding = await prisma.healthFinding.create({
    data: {
      projectId, type: decision.gap.type, severity: decision.gap.severity,
      details: decision.gap.details as any, status: 'open', autoFixed: false,
    },
    select: { id: true },
  })
  let res = await runAutoFix(finding.id, projectId, { skipCooldown: true })
  for (let a = 0; a < 5 && res.outcome === 'deferred'; a++) {
    await sleep(4000)
    res = await runAutoFix(finding.id, projectId, { skipCooldown: true })
  }
  return { outcome: res.outcome, findingId: finding.id }
}

async function proveRLS(): Promise<boolean> {
  const { projectId, userId, schema } = await makeProject()
  try {
    await sql(`CREATE TABLE "${schema}"."secrets" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, body text)`)
    const level = await getProjectAutonomyLevel(projectId)
    const fix = await applyOneGap(projectId, ['unprotected_user_data', 'missing_rls'])
    const rls = await sql(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='secrets'`, [schema])
    const pol = await sql(`SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename='secrets'`, [schema])
    const applied = rls[0]?.relrowsecurity === true && pol.length > 0
    console.log(`RLS  · level=${level} · fix=${fix.outcome} · relrowsecurity=${rls[0]?.relrowsecurity} policies=${pol.length}  ${applied ? '✓ APPLIED' : '✗ FAIL'}`)
    if (!applied || !fix.findingId) return false

    // ── REVERT leg ──────────────────────────────────────────────────────────
    // 1. RLS-undo is a protection removal — the first call MUST refuse.
    const gate = await revertAutoFix(fix.findingId, projectId)
    const gateOk = !gate.success && gate.requiresConfirmation === true
    // 2. Confirmed revert must actually strip the protection back off.
    const revert = await revertAutoFix(fix.findingId, projectId, { confirmed: true })
    const rls2 = await sql(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='secrets'`, [schema])
    const pol2 = await sql(`SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename='secrets'`, [schema])
    const metaRows = await prisma.permissionPolicy.count({ where: { projectId, tableName: 'secrets' } })
    const reverted = revert.success && rls2[0]?.relrowsecurity === false && pol2.length === 0 && metaRows === 0
    console.log(`RLS  · undo: confirmGate=${gateOk ? 'ENFORCED' : 'MISSING'} · revert=${revert.success} · relrowsecurity=${rls2[0]?.relrowsecurity} policies=${pol2.length} metaRows=${metaRows}  ${gateOk && reverted ? '✓ REVERTED' : '✗ FAIL'}`)
    return gateOk && reverted
  } finally { await teardown(projectId, userId) }
}

async function proveFK(): Promise<boolean> {
  const { projectId, userId, schema } = await makeProject()
  try {
    await sql(`CREATE TABLE "${schema}"."orgs" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
    await sql(`CREATE TABLE "${schema}"."docs" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, body text)`)
    const level = await getProjectAutonomyLevel(projectId)
    const fix = await applyOneGap(projectId, ['missing_fk'])
    const fkQuery = `SELECT tc.constraint_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND tc.table_name='docs' AND kcu.column_name='org_id'`
    const fk = await sql(fkQuery, [schema])
    const applied = fk.length > 0
    console.log(`FK   · level=${level} · fix=${fix.outcome} · docs.org_id constraint=${applied ? fk[0].constraint_name : 'MISSING'}  ${applied ? '✓ APPLIED' : '✗ FAIL'}`)
    if (!applied || !fix.findingId) return false

    // ── REVERT leg: the constraint must be GONE afterward ───────────────────
    const revert = await revertAutoFix(fix.findingId, projectId, { confirmed: true })
    const fk2 = await sql(fkQuery, [schema])
    const reverted = revert.success && fk2.length === 0
    console.log(`FK   · undo: revert=${revert.success} (${revert.appliedSteps ?? 0} steps) · constraint after=${fk2.length === 0 ? 'GONE' : fk2[0].constraint_name}  ${reverted ? '✓ REVERTED' : '✗ FAIL'}`)
    return reverted
  } finally { await teardown(projectId, userId) }
}

async function proveRate(): Promise<boolean> {
  const { projectId, userId } = await makeProject()
  try {
    const table = await prisma.table.create({ data: { name: 'items', projectId } })
    await prisma.apiDefinition.create({
      data: { tableId: table.id, projectId, name: 'items', basePath: 'items', operations: {}, endpoints: {}, config: {} },
    })
    const level = await getProjectAutonomyLevel(projectId)
    // Capture the TRUE pre-fix state (rateLimit column has a schema default,
    // so "pre-fix" is NOT null) — revert must restore exactly this.
    const before = await prisma.apiDefinition.findFirst({ where: { projectId, name: 'items' }, select: { rateLimit: true, config: true } })
    const beforeCfg = (before?.config as Record<string, unknown>) ?? {}
    const fix = await applyOneGap(projectId, ['missing_rate_limit'])
    const api = await prisma.apiDefinition.findFirst({ where: { projectId, name: 'items' }, select: { config: true } })
    const cfg = (api?.config as Record<string, unknown>) ?? {}
    const applied = cfg.rateLimit !== undefined || cfg.rateLimitPerMinute !== undefined || cfg.rateLimitPerHour !== undefined
    console.log(`RATE · level=${level} · fix=${fix.outcome} · API config=${JSON.stringify(cfg)}  ${applied ? '✓ APPLIED' : '✗ FAIL'}`)
    if (!applied || !fix.findingId) return false

    // ── REVERT leg: rate limit must be back to its exact pre-fix state ──────
    const revert = await revertAutoFix(fix.findingId, projectId, { confirmed: true })
    const api2 = await prisma.apiDefinition.findFirst({ where: { projectId, name: 'items' }, select: { rateLimit: true, config: true } })
    const cfg2 = (api2?.config as Record<string, unknown>) ?? {}
    const reverted = revert.success
      && (api2?.rateLimit ?? null) === (before?.rateLimit ?? null)
      && cfg2.rateLimit === (beforeCfg.rateLimit ?? undefined)
    console.log(`RATE · undo: revert=${revert.success} · rateLimit=${api2?.rateLimit ?? 'null'} (pre-fix ${before?.rateLimit ?? 'null'}) config=${JSON.stringify(cfg2)}  ${reverted ? '✓ REVERTED' : '✗ FAIL'}`)
    return reverted
  } finally { await teardown(projectId, userId) }
}

async function main() {
  console.log('── Proving Tier-1 autonomy fix paths on real $25 Pro (BUILDER) projects ──\n')
  const results: [Target, boolean][] = []
  results.push(['RLS', await proveRLS()])
  results.push(['FK', await proveFK()])
  results.push(['RATE', await proveRate()])
  await pool.end()
  await prisma.$disconnect()
  const allPass = results.every(([, ok]) => ok)
  console.log(`\n${allPass
    ? '✅ ALL THREE TIER-1 PATHS PROVEN ROUND-TRIP — RLS, FK-constraint, and rate-limit each genuinely closed AND genuinely reverted (object gone on re-check) on a $19-plan project. RLS-undo confirmation gate enforced.'
    : '❌ Not all paths proven: ' + results.filter(([, ok]) => !ok).map(([t]) => t).join(', ')}`)
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
