/**
 * DEMO DRIVER — break → detect → apply, as separate passes
 * ========================================================
 *
 * Recording aid for the self-healing demo. The autonomy loop normally does
 * everything in ONE tick (reconciler.ts: ensureFinding → runAutoFix on the very
 * next line), so a finding opens and closes milliseconds apart. The dashboard
 * only animates a heal it personally witnessed — WorkspaceHome polls at 2.5s
 * ONLY while a finding is already open, and fires the Detect→Propose→Apply→
 * Verify sweep only when an ID it previously saw open disappears. A same-tick
 * fix is therefore invisible: nothing to film.
 *
 * This script splits the tick in two so the camera can see each half. It does
 * NOT fake anything:
 *
 *   • `break`  runs real DDL against the real workspace schema.
 *   • `detect` runs the real computeReconciliationPlan + the real ensureFinding.
 *   • `apply`  runs the real runAutoFix — same kernel, same classifier gate,
 *              same circuit breaker, same pre-fix snapshot, same audit ledger.
 *
 * The only thing being controlled is WHEN each pass runs. Every row written is
 * a row the autonomous loop would have written by itself.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   npx tsx scripts/demo-selfheal.ts status  <projectId>
 *   npx tsx scripts/demo-selfheal.ts break   <projectId> <table>
 *   npx tsx scripts/demo-selfheal.ts detect  <projectId>
 *   npx tsx scripts/demo-selfheal.ts apply   <projectId>
 *   npx tsx scripts/demo-selfheal.ts reset   <projectId> <table>
 *
 * ── Recording order ─────────────────────────────────────────────────────────
 *   status  → confirm the board is clean and the table is retake-eligible
 *   break   → roll camera; RLS is now genuinely off
 *   detect  → cut to browser, click in (focus refresh) → DETECT lights up
 *   apply   → the 2.5s poll catches the close → the sweep plays
 *   reset   → between takes; clears the 24h recurrence suppression
 *
 * ── Retake trap (read this) ─────────────────────────────────────────────────
 * reconciler.ts sets RECURRENCE_WINDOW_HOURS = 24. If the same type+location
 * was auto_fixed in the last 24h, `detect` mints NOTHING and DETECT stays 0.
 * After RECURRENCE_ESCALATE_AFTER = 3 it escalates to the approval queue
 * instead of self-healing — the opposite of the story. Always run `reset`
 * between takes, or shoot a different table each take.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * Refuses to run without an explicit projectId. Touches only that project's
 * workspace schema. `break` is fully reversed by `reset`.
 */

import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'

const prisma = new PrismaClient()
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// ── helpers ──────────────────────────────────────────────────────────────────

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

function schemaFor(projectId: string): string {
  return `workspace_${projectId}`
}

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect()
  try {
    const r = await client.query(text, params)
    return r.rows as T[]
  } finally {
    client.release()
  }
}

async function assertProject(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, autonomyLevel: true },
  })
  if (!p) throw new Error(`No project ${projectId}`)
  return p
}

/** Identify the RLS-shaped gaps this script cares about. */
const RLS_TYPES = new Set(['missing_rls', 'unprotected_user_data', 'rls_denies_everything'])

// ── status ───────────────────────────────────────────────────────────────────

async function status(projectId: string) {
  const project = await assertProject(projectId)
  const schema = schemaFor(projectId)

  console.log(`\n${c.bold('PROJECT')}  ${project.name}`)
  console.log(`${c.dim('id')}       ${project.id}`)
  console.log(`${c.dim('dial')}     ${project.autonomyLevel}`)
  if (project.autonomyLevel === 'OFF') {
    console.log(c.red('  ⚠ dial is OFF — the loop observes but never acts. No heal will film.'))
  }

  // RLS state per table
  const tables = await sql<{ table_name: string; rls: boolean; policies: number }>(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    [schema],
  )

  console.log(`\n${c.bold('TABLES')}  ${c.dim(schema)}`)
  if (tables.length === 0) console.log(c.dim('  (none)'))
  for (const t of tables) {
    const state = t.rls
      ? c.green(`RLS on, ${t.policies} polic${t.policies === 1 ? 'y' : 'ies'}`)
      : c.red('RLS OFF')
    console.log(`  ${t.table_name.padEnd(24)} ${state}`)
  }

  // Findings currently on the board — these are what the dashboard renders
  const findings = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] } },
    select: { id: true, type: true, status: true, details: true },
    take: 25,
  })
  console.log(`\n${c.bold('ON THE BOARD')}  ${c.dim('(DETECT counts these)')}`)
  if (findings.length === 0) console.log(c.green('  0 — clean, good to shoot'))
  for (const f of findings) {
    const loc = (f.details as any)?.location ?? (f.details as any)?.tableName ?? ''
    const tag = f.status === 'pending_approval' ? c.yellow('HELD') : c.red('OPEN')
    console.log(`  ${tag}  ${f.type} ${c.dim(String(loc))}`)
  }
  if (findings.some(f => f.status === 'pending_approval')) {
    console.log(c.yellow('  ⚠ a held finding shows as "waiting on you" on camera. Clear it first.'))
  }

  // Retake eligibility — the 24h recurrence suppression
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await prisma.healthFinding.findMany({
    where: { projectId, status: 'auto_fixed', fixAppliedAt: { gte: since } },
    select: { type: true, details: true, fixAppliedAt: true },
    orderBy: { fixAppliedAt: 'desc' },
    take: 25,
  })
  console.log(`\n${c.bold('SUPPRESSED FOR 24h')}  ${c.dim('(detect will mint NOTHING for these)')}`)
  if (recent.length === 0) console.log(c.green('  none — every table is retake-eligible'))
  for (const r of recent) {
    const loc = (r.details as any)?.location ?? (r.details as any)?.tableName ?? ''
    const mins = Math.round((Date.now() - new Date(r.fixAppliedAt!).getTime()) / 60000)
    console.log(`  ${c.yellow(r.type)} ${c.dim(String(loc))} ${c.dim(`— fixed ${mins}m ago`)}`)
  }
  console.log()
}

// ── break ────────────────────────────────────────────────────────────────────

async function breakRls(projectId: string, table: string) {
  await assertProject(projectId)
  const schema = schemaFor(projectId)

  const exists = await sql(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  )
  if (exists.length === 0) throw new Error(`No table "${table}" in ${schema}`)

  const before = await sql<{ policyname: string }>(
    `SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
    [schema, table],
  )

  // The break: drop every policy, then disable row security. This is exactly
  // what a careless migration or an agent with DDL access does by accident.
  for (const p of before) {
    await sql(`DROP POLICY IF EXISTS "${p.policyname}" ON "${schema}"."${table}"`)
  }
  await sql(`ALTER TABLE "${schema}"."${table}" DISABLE ROW LEVEL SECURITY`)

  console.log(
    `\n${c.red('BROKEN')}  ${schema}.${table} — ` +
    `dropped ${before.length} polic${before.length === 1 ? 'y' : 'ies'}, RLS disabled.`,
  )
  console.log(c.dim('Every row in this table is now readable by any authenticated caller.'))
  console.log(c.dim('Next: run `detect`, then cut to the browser and click into the page.\n'))
}

// ── detect ───────────────────────────────────────────────────────────────────

async function detect(projectId: string) {
  await assertProject(projectId)

  // Real probe pass — the same one the cron tick runs.
  const { computeReconciliationPlan, ensureFinding } = await import('../lib/autonomy/reconciler')
  const plan = await computeReconciliationPlan(projectId)

  const actionable = plan.decisions.filter(d => d.action === 'WOULD_AUTO_APPLY')
  const rlsGaps = actionable.filter(d => RLS_TYPES.has(d.gap.type))
  const chosen = rlsGaps.length > 0 ? rlsGaps : actionable

  if (chosen.length === 0) {
    console.log(`\n${c.yellow('NOTHING DETECTED')}`)
    console.log(c.dim('Either the break did not land, or the 24h recurrence window is'))
    console.log(c.dim('suppressing this gap. Run `status` — check SUPPRESSED FOR 24h.\n'))
    return
  }

  console.log(`\n${c.bold('DETECT')}  ${chosen.length} gap(s) the loop will act on:`)
  for (const d of chosen) {
    const loc = (d.gap.details as any)?.location ?? (d.gap.details as any)?.tableName ?? ''
    console.log(`  ${c.red(d.gap.type)} ${c.dim(String(loc))}  tier=${d.gap.tier}`)
  }

  // Mint the findings — real ensureFinding, real dedupe, real suppression rules.
  let created = 0
  for (const d of chosen) {
    const { findingId, skip } = await ensureFinding(projectId, d.gap)
    if (findingId) {
      created++
      console.log(`  ${c.green('→ finding')} ${findingId}`)
    } else {
      console.log(`  ${c.yellow('→ skipped')} (${skip})`)
    }
  }

  if (created === 0) {
    console.log(c.yellow('\nNo finding minted — nothing will appear on the dashboard.\n'))
    return
  }

  console.log(`\n${c.bold('NOW:')} click into the browser. The focus refresh pulls it in and`)
  console.log(`DETECT lights up. The 2.5s poll starts and captures its baseline.`)
  console.log(c.dim('Give it ~3 seconds on camera, then run `apply`.\n'))
}

// ── apply ────────────────────────────────────────────────────────────────────

async function apply(projectId: string) {
  await assertProject(projectId)
  const { runAutoFix } = await import('../lib/core/auto-fix-engine')

  const open = await prisma.healthFinding.findMany({
    where: { projectId, status: 'open' },
    select: { id: true, type: true, details: true },
    take: 10,
  })

  if (open.length === 0) {
    console.log(`\n${c.yellow('NO OPEN FINDING')} — run \`detect\` first.\n`)
    return
  }

  const rls = open.filter(f => RLS_TYPES.has(f.type))
  const target = rls.length > 0 ? rls : open

  console.log(`\n${c.bold('APPLY')}  ${target.length} fix(es)`)
  for (const f of target) {
    // skipCooldown: the kernel enforces a 2-min pause between mutations. That
    // pacing is real and correct in production, but it would strand a retake
    // mid-shoot. The FIX itself is untouched — same action, same snapshot,
    // same audit row. Only the wait is skipped.
    const res = await runAutoFix(f.id, projectId, { skipCooldown: true })
    const mark =
      res.outcome === 'auto_fixed' ? c.green('✓ auto_fixed')
      : res.outcome === 'deferred' ? c.yellow('· deferred')
      : c.red(`✗ ${res.outcome}`)
    console.log(`  ${mark}  ${f.type}`)
    if (res.message) console.log(`     ${c.dim(res.message)}`)
    if ((res as any).snapshotId) {
      console.log(`     ${c.dim(`pre-fix snapshot ${(res as any).snapshotId}`)}`)
    }
  }

  console.log(`\n${c.bold('WATCH THE SCREEN:')} within 2.5s the poll sees the finding close,`)
  console.log(`the sweep walks Detect→Propose→Apply→Verify (~3.6s), headline settles.`)
  console.log(c.dim('Snapshot is in Deploy → version history for the rollback beat.\n'))
}

// ── reset ────────────────────────────────────────────────────────────────────

async function reset(projectId: string, table: string) {
  await assertProject(projectId)
  const schema = schemaFor(projectId)

  // 1. Clear the board.
  const cleared = await prisma.healthFinding.deleteMany({
    where: { projectId, status: { in: ['open', 'pending_approval'] } },
  })

  // 2. Lift the 24h recurrence suppression — otherwise the next `detect` mints
  //    nothing and the retake is dead on arrival.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const unsuppressed = await prisma.healthFinding.deleteMany({
    where: { projectId, status: 'auto_fixed', fixAppliedAt: { gte: since } },
  })
  const audits = await prisma.auditLog.deleteMany({
    where: { projectId, action: 'AUTONOMY_RECURRENCE_SUPPRESSED', timestamp: { gte: since } },
  })

  // 3. Put RLS back exactly as a healthy project has it, so the next `break`
  //    has something real to destroy.
  await sql(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)
  const policies = await sql(
    `SELECT policyname FROM pg_policies WHERE schemaname = $1 AND tablename = $2`,
    [schema, table],
  )

  console.log(`\n${c.bold('RESET')}`)
  console.log(`  board cleared        ${cleared.count} finding(s)`)
  console.log(`  suppression lifted   ${unsuppressed.count} auto_fixed, ${audits.count} audit row(s)`)
  console.log(`  RLS re-enabled       ${schema}.${table} (${policies.length} policy)`)
  if (policies.length === 0) {
    console.log(c.yellow('  ⚠ no policy on the table — RLS is on but nothing is defined.'))
    console.log(c.yellow('    Let the loop heal it once (detect + apply) to mint a real policy,'))
    console.log(c.yellow('    then reset again. That gives you a clean healthy baseline.'))
  }
  console.log(c.dim('\nRun `status` to confirm the board is clean before the next take.\n'))
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, projectId, table] = process.argv.slice(2)

  if (!cmd || !projectId) {
    console.log(`
${c.bold('demo-selfheal')} — split the autonomy tick so it can be filmed

  npx tsx scripts/demo-selfheal.ts status <projectId>
  npx tsx scripts/demo-selfheal.ts break  <projectId> <table>
  npx tsx scripts/demo-selfheal.ts detect <projectId>
  npx tsx scripts/demo-selfheal.ts apply  <projectId>
  npx tsx scripts/demo-selfheal.ts reset  <projectId> <table>
`)
    process.exit(1)
  }

  switch (cmd) {
    case 'status': await status(projectId); break
    case 'break':
      if (!table) throw new Error('break needs a table name')
      await breakRls(projectId, table); break
    case 'detect': await detect(projectId); break
    case 'apply':  await apply(projectId); break
    case 'reset':
      if (!table) throw new Error('reset needs a table name')
      await reset(projectId, table); break
    default: throw new Error(`Unknown command: ${cmd}`)
  }
}

main()
  .catch(err => { console.error(c.red(`\n${err?.message ?? err}\n`)); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
