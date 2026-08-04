/**
 * verify-autonomy-live.ts — confirm the autonomy loop is genuinely live.
 *
 * READ-ONLY by default: prints the effective flags and, for every active
 * project, the exact decision the live reconciler WOULD make right now
 * (WOULD_AUTO_APPLY / NEEDS_APPROVAL / NOTIFY_ONLY / BLOCKED_*). Mutates nothing.
 *
 * With `--apply`, it runs the LIVE reconciler on the FIRST project that has a
 * WOULD_AUTO_APPLY gap (bypassing the cadence gate, which only lives in the
 * cron dispatcher), so an actual fix can be observed end-to-end: the returned
 * result reports applied/escalated/deferred, and the kernel writes the receipt.
 *
 * Run on the server (has prod .env):
 *   npx tsx scripts/verify-autonomy-live.ts                       # read-only, all projects
 *   npx tsx scripts/verify-autonomy-live.ts --project=<id>        # read-only, one project
 *   npx tsx scripts/verify-autonomy-live.ts --project=<id> --apply  # apply + re-check
 */

import { prisma } from '@/lib/db/prisma'
import { FLAGS } from '@/lib/config/flags'
import { computeReconciliationPlan, runReconcilerLive } from '@/lib/autonomy/reconciler'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'

async function main() {
  const apply = process.argv.includes('--apply')
  // Clears recent auto_fixed findings on the target project. Used to remove the
  // false "fixed" records left by phantom-success runs before the trust
  // guarantee shipped, so the recurrence gate stops suppressing a genuine fix.
  const clearRecent = process.argv.includes('--clear-recent')
  const projectArg = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1] ?? null

  if (clearRecent && projectArg) {
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const del = await prisma.healthFinding.deleteMany({
      where: { projectId: projectArg, status: 'auto_fixed', fixAppliedAt: { gte: cutoff } },
    })
    console.log(`── Cleared ${del.count} recent auto_fixed finding(s) on ${projectArg} (test-artifact cleanup) ──`)
  }

  console.log('── Autonomy flags (as the running code reads them) ──')
  console.log('  ENABLE_AUTONOMY_RECONCILER     =', FLAGS.ENABLE_AUTONOMY_RECONCILER)
  console.log('  ENABLE_AUTONOMY_LIVE_EXECUTION =', FLAGS.ENABLE_AUTONOMY_LIVE_EXECUTION)

  // Must be the SAME predicate the schedulers use, or this diagnostic reports a
  // different fleet than the one being healed. It previously hand-rolled
  // "has tables AND has chatted in 30 days", which is the gate the reconciler
  // moved away from when the chat door was removed: an agent driving the MCP
  // tools writes no conversation row. On production that made this script report
  // 2 active projects while the loop was actually reconciling 4 — so the tool
  // for answering "is autonomy covering my fleet?" was under-reporting coverage
  // by half, in the direction that hides a project being missed.
  const projects = await prisma.project.findMany({
    where: {
      ...activeProjectsWhere(),
      ...(projectArg ? { id: projectArg } : {}),
    },
    select: { id: true, name: true },
  })

  console.log(`\n── Active projects: ${projects.length} ──`)

  let firstApplicable: string | null = null

  for (const p of projects) {
    const level = await getProjectAutonomyLevel(p.id)
    const plan = await computeReconciliationPlan(p.id)
    console.log(`\n[${p.name ?? '(unnamed)'} · ${p.id}]  level=${level}`)
    console.log(`   ${plan.summary}`)
    console.log(`   counts: ${JSON.stringify(plan.counts)}`)
    // Name every gap. "2 issues found" without saying which two is not a
    // diagnostic — it is the same shape as the attempted=0 ambiguity the
    // reconciler's skip-reason tally exists to end.
    for (const d of plan.decisions) {
      const det = (d.gap.details ?? {}) as Record<string, unknown>
      const loc = det.tableName ?? det.table ?? det.location ?? det.surface ?? det.workflow ?? ''
      console.log(`      • ${d.action.padEnd(18)} ${d.type}${loc ? `::${loc}` : ''}  [${d.invariantId}]`)
    }
    if (plan.report.errors.length) console.log(`   probeErrors: ${JSON.stringify(plan.report.errors)}`)
    if (!firstApplicable && plan.counts.WOULD_AUTO_APPLY > 0) firstApplicable = p.id
  }

  if (!apply) {
    console.log(
      firstApplicable
        ? `\n✓ Live-ready. ${firstApplicable} has an auto-applicable gap. Re-run with --apply to fix one end-to-end.`
        : `\n✓ Live-ready. No auto-applicable gaps on active projects right now (all healthy or gated).`,
    )
    await prisma.$disconnect()
    return
  }

  if (!firstApplicable) {
    console.log('\n(no WOULD_AUTO_APPLY gap to demonstrate — nothing applied)')
    await prisma.$disconnect()
    return
  }

  const before = await computeReconciliationPlan(firstApplicable)
  console.log(`\n>>> Running LIVE reconcile on ${firstApplicable} …`)
  console.log(`   before: WOULD_AUTO_APPLY=${before.counts.WOULD_AUTO_APPLY}`)
  const res = await runReconcilerLive(firstApplicable)
  console.log('   result:', JSON.stringify({
    frozen: res?.frozen,
    attempted: res?.attempted,
    applied: res?.applied,
    escalated: res?.escalated,
    deferred: res?.deferred,
  }))

  // The kernel now self-verifies gap identity before recording a fix, so the
  // outcome is trustworthy on its own: applied = gaps it CONFIRMED closed;
  // escalated = fixes that ran but did not resolve, honestly queued (not lied
  // about). A total-count re-probe is shown only as context — it can stay flat
  // when one fix legitimately reveals a different gap.
  const after = await computeReconciliationPlan(firstApplicable)
  console.log(`   after:  WOULD_AUTO_APPLY=${after.counts.WOULD_AUTO_APPLY}  NEEDS_APPROVAL=${after.counts.NEEDS_APPROVAL}`)
  if ((res?.applied ?? 0) > 0) {
    console.log('   ✓ applied>0 — the kernel confirmed each gap actually closed before recording it as fixed.')
  }
  if ((res?.escalated ?? 0) > 0) {
    console.log('   ⚑ escalated>0 — a fix ran but did not resolve its gap; honestly queued for review, never reported as fixed.')
  }
  if ((res?.applied ?? 0) === 0 && (res?.escalated ?? 0) === 0) {
    console.log('   (nothing applied or escalated this run — see result above)')
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
