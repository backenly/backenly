/**
 * Rules Backenly guessed from a name, across every project: a list for the release.
 *
 * Before #654 a table declared in SQL got rules its statement never wrote:
 * UNIQUE on any column with email, username or slug in its name, and a CHECK
 * value list on status for tables named like orders, posts or tasks
 * (lib/db/name-rules.ts). Production QA (2026-11-09) met both: orders_email_key
 * let each customer place one order, and chk_orders_status refused "paid".
 * The detector that finds them, and the finding a person answers on the
 * Autonomy page, are lib/autonomy/guessed-constraints.ts. This lists what it
 * finds on every project the observer watches, read-only by default.
 *
 * It never removes a rule. `--file` puts the findings in each project's Review
 * Queue now instead of at the observer's next pass, by running that pass (the
 * same as the Re-scan button), for the projects that have any.
 *
 *   npx tsx scripts/report-guessed-constraints.ts                   # list, change nothing
 *   npx tsx scripts/report-guessed-constraints.ts --project=<id>    # one project
 *   npx tsx scripts/report-guessed-constraints.ts --json            # one JSON line per rule
 *   npx tsx scripts/report-guessed-constraints.ts --file            # list, then file them
 */

import { prisma } from '@/lib/db/prisma'
import { watchableProjectsWhere } from '@/lib/projects/backend-presence'
import { skipUnreachable } from '@/lib/autonomy/region-skip'
import { detectGuessedConstraints } from '@/lib/autonomy/guessed-constraints'
import { guessedConstraintSummary } from '@/lib/core/guessed-constraint-words'

interface Row {
  projectId: string
  table: string
  constraint: string
  rule: string
  evidence: string
  says: string
}

async function main(): Promise<void> {
  const file = process.argv.includes('--file')
  const json = process.argv.includes('--json')
  const only = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1] ?? null

  const projects = await skipUnreachable(
    await prisma.project.findMany({
      where: only ? { id: only } : watchableProjectsWhere(),
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }),
    'report-guessed-constraints',
  )

  const rows: Row[] = []
  const failed: Array<{ projectId: string; error: string }> = []
  for (const p of projects) {
    try {
      for (const f of await detectGuessedConstraints(p.id)) {
        const d = f.details as Record<string, unknown>
        rows.push({
          projectId: p.id,
          table: String(d.tableName),
          constraint: String(d.constraintName),
          rule: String(d.rule),
          evidence: String(d.evidence),
          says: guessedConstraintSummary(d),
        })
      }
    } catch (err) {
      failed.push({ projectId: p.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (json) {
    for (const r of rows) console.log(JSON.stringify(r))
  } else {
    let current = ''
    for (const r of rows) {
      if (r.projectId !== current) {
        current = r.projectId
        console.log(`\nproject ${r.projectId}`)
      }
      console.log(`  ${r.table}.${r.constraint}  [${r.rule}, ${r.evidence}]`)
      console.log(`    ${r.says}`)
    }
  }

  // With --json the rules alone go to stdout, one per line; what is said about them goes to stderr.
  const say = json ? console.error : console.log
  const affected = new Set(rows.map((r) => r.projectId))
  const byRule = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.rule]: (acc[r.rule] ?? 0) + 1 }), {})
  const byEvidence = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.evidence]: (acc[r.evidence] ?? 0) + 1 }), {})
  say(
    `\n${rows.length} rule(s) on ${affected.size} of ${projects.length} project(s). ` +
      `By rule: ${JSON.stringify(byRule)}. By evidence: ${JSON.stringify(byEvidence)}.` +
      (failed.length ? ` ${failed.length} project(s) could not be read.` : ''),
  )
  for (const f of failed) say(`  could not read ${f.projectId}: ${f.error}`)

  if (!file) {
    say('Nothing was changed. --file puts these in each project\'s Review Queue now.')
    return
  }
  const { runObserverForProject } = await import('@/lib/services/workspace-observer')
  let filed = 0
  for (const projectId of affected) {
    await runObserverForProject(projectId)
    filed += await prisma.healthFinding.count({
      where: { projectId, type: 'guessed_constraint', status: 'pending_approval' },
    })
  }
  say(`Filed: ${filed} finding(s) waiting for a person across ${affected.size} project(s). No rule was removed.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
