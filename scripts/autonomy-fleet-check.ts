/**
 * autonomy-fleet-check.ts — is the self-healing loop actually healing, fleet-wide?
 *
 * READ-ONLY. Mutates nothing, calls no model.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 2026-08-01 the loop was found to have applied ZERO fixes in production for
 * thirteen days. Every dashboard read it as healthy, because the surfaces all
 * quote `AUTONOMY_LIVE_RUN` — a row the loop writes whenever it FINDS work, not
 * when it FIXES any. 7,636 of those rows had accumulated, each one logging
 * `attempted=0`, and nothing anywhere turned that into a sentence a human would
 * read as "broken".
 *
 * Finding it took a hand-written SQL query against the box. This is that query,
 * made repeatable and made correct: it asks the real `classifyFix` whether a
 * stuck finding was one the platform claims it repairs automatically, rather
 * than hardcoding a list that will drift away from the classifier.
 *
 *   npx tsx scripts/autonomy-fleet-check.ts
 *   npx tsx scripts/autonomy-fleet-check.ts --hours=24
 *
 * Exit code is 0 when the fleet is healthy and 1 when something needs a human,
 * so it can be wired to a cron or a deploy gate.
 */

import { prisma } from '@/lib/db/prisma'
import { classifyFix } from '@/lib/core/fix-classifier'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'

const HOURS = Number(process.argv.find(a => a.startsWith('--hours='))?.split('=')[1] ?? 24)

/** ANSI, but only when attached to a terminal. */
const c = process.stdout.isTTY
  ? { red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      green: (s: string) => `\x1b[32m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m` }
  : { red: (s: string) => s, yellow: (s: string) => s, green: (s: string) => s, dim: (s: string) => s }

interface Problem { project: string; detail: string }

async function main() {
  const since = new Date(Date.now() - HOURS * 3600_000)
  const problems: Problem[] = []
  const warnings: Problem[] = []

  const projects = await prisma.project.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, autonomyLevel: true, _count: { select: { tables: true } } },
  })

  // Which projects the loop is even allowed to spend a cycle on. A project that
  // is silently outside the gate is the other way self-healing goes missing, and
  // it looks identical to "healthy" from the outside.
  const eligible = new Set(
    (await prisma.project.findMany({ where: activeProjectsWhere(), select: { id: true } }))
      .map(p => p.id),
  )

  console.log(`\n${'='.repeat(78)}`)
  console.log(`AUTONOMY FLEET CHECK — ${projects.length} project(s), ${HOURS}h window`)
  console.log('='.repeat(78))

  for (const p of projects) {
    const label = `${p.name?.slice(0, 44) ?? '(unnamed)'} · ${p.id.slice(0, 8)}`

    const [findings, lastTick, fixes, stalls, retries] = await Promise.all([
      prisma.healthFinding.findMany({
        where: { projectId: p.id, status: { in: ['open', 'pending_approval'] } },
        select: { type: true, status: true, details: true, detectedAt: true },
      }),
      prisma.auditLog.findFirst({
        where: { projectId: p.id, action: 'AUTONOMY_TICK' },
        orderBy: { timestamp: 'desc' }, select: { timestamp: true },
      }),
      prisma.auditLog.count({
        where: { projectId: p.id, action: 'HEALTH_AUTO_FIXED', timestamp: { gte: since } },
      }),
      prisma.auditLog.count({
        where: { projectId: p.id, action: 'AUTONOMY_LOOP_STALLED', timestamp: { gte: since } },
      }),
      prisma.auditLog.count({
        where: { projectId: p.id, action: 'AUTONOMY_ESCALATION_RETRIED', timestamp: { gte: since } },
      }),
    ])

    const level = await getProjectAutonomyLevel(p.id)
    const tickAge = lastTick ? (Date.now() - lastTick.timestamp.getTime()) / 60000 : null

    console.log(`\n${label}`)
    console.log(c.dim(`  tables=${p._count.tables}  dial=${level}  eligible=${eligible.has(p.id)}` +
      `  lastTick=${tickAge === null ? 'never' : `${tickAge.toFixed(0)}m ago`}` +
      `  fixed(${HOURS}h)=${fixes}  retried=${retries}`))

    // ── The defect this script was written for ───────────────────────────────
    // A finding the classifier rates `auto`, sitting in the human queue. The
    // platform says it repairs these without asking; the row says otherwise.
    const strandedAuto = findings.filter(f =>
      f.status === 'pending_approval' &&
      classifyFix(f.type, (f.details ?? {}) as Record<string, unknown>).decision === 'auto',
    )
    for (const f of strandedAuto) {
      const days = ((Date.now() - f.detectedAt.getTime()) / 86400_000).toFixed(1)
      problems.push({
        project: label,
        detail: `${f.type} is classified AUTO but has sat in pending_approval for ${days}d`,
      })
    }

    // An `open` finding is work the loop owns. Older than a few ticks means it
    // is not being picked up — the exact shape of the thirteen-day stall.
    const staleOpen = findings.filter(
      f => f.status === 'open' && Date.now() - f.detectedAt.getTime() > 3600_000,
    )
    for (const f of staleOpen) {
      const hrs = ((Date.now() - f.detectedAt.getTime()) / 3600_000).toFixed(1)
      problems.push({ project: label, detail: `${f.type} has been open and unattempted for ${hrs}h` })
    }

    if (stalls > 0) {
      problems.push({ project: label, detail: `loop reported ${stalls} STALLED tick(s) in the window` })
    }

    // Has tables, dial is on, but the gate does not select it: self-healing is
    // silently off for this customer while the dashboard says AGGRESSIVE.
    if (p._count.tables > 0 && level !== 'OFF' && !eligible.has(p.id)) {
      problems.push({ project: label, detail: 'has tables and an active dial but is OUTSIDE the activity gate' })
    }
    if (p._count.tables > 0 && level !== 'OFF' && (tickAge === null || tickAge > 15)) {
      problems.push({
        project: label,
        detail: `loop has not ticked in ${tickAge === null ? 'ever' : `${tickAge.toFixed(0)}m`} (cadence is 1m)`,
      })
    }

    const awaitingHuman = findings.filter(f =>
      f.status === 'pending_approval' &&
      classifyFix(f.type, (f.details ?? {}) as Record<string, unknown>).decision !== 'auto',
    )
    if (awaitingHuman.length > 0) {
      // Correct behaviour, not a defect — Tier-2 work always gates on a human.
      warnings.push({ project: label, detail: `${awaitingHuman.length} finding(s) legitimately awaiting approval` })
    }
  }

  console.log(`\n${'='.repeat(78)}`)
  if (problems.length === 0) {
    console.log(c.green('HEALTHY — no project is silently failing to heal.'))
  } else {
    console.log(c.red(`${problems.length} PROBLEM(S):`))
    for (const p of problems) console.log(c.red(`  ✗ [${p.project}] ${p.detail}`))
  }
  if (warnings.length > 0) {
    console.log(c.yellow('\nAwaiting a human (expected, not a fault):'))
    for (const w of warnings) console.log(c.yellow(`  • [${w.project}] ${w.detail}`))
  }
  console.log('='.repeat(78) + '\n')

  await prisma.$disconnect()
  process.exit(problems.length > 0 ? 1 : 0)
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
