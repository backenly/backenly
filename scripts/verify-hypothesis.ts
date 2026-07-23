/**
 * PHASE 4 — run a real investigation against a live project.
 *
 * Read-only: every probe observes, none repairs. Prints the reasoning trail so
 * the conclusion can be checked against the evidence rather than taken on
 * trust — which is the entire point of doing this deterministically.
 *
 *   npx tsx scripts/verify-hypothesis.ts --project <id> --symptom empty_reads --table orders
 *   npx tsx scripts/verify-hypothesis.ts --project <id> --symptom all_tenants_failing
 */

import { investigate } from '@/lib/autonomy/hypothesis/investigate'
import { SYMPTOM_CATALOG } from '@/lib/autonomy/hypothesis/catalog'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const projectId = arg('--project')
  const symptom = arg('--symptom')
  const table = arg('--table')

  if (!projectId || !symptom) {
    console.error('Usage: --project <id> --symptom <id> [--table <name>]')
    console.error(`Symptoms: ${SYMPTOM_CATALOG.map(s => s.id).join(', ')}`)
    process.exit(2)
  }

  const report = await investigate(symptom, { projectId, table })

  console.log('')
  for (const line of report.trail) console.log(`  ${line}`)
  console.log('')
  console.log(`  verdict: ${report.verdict.kind}`)
  if (report.unavailable.length > 0) {
    console.log(`  could not observe: ${report.unavailable.map(u => u.testId).join(', ')}`)
  }
  console.log('')

  // Nonzero only for a genuinely broken run. An inconclusive investigation is a
  // legitimate result, not a failure — treating it as one would push the system
  // toward manufacturing answers.
  process.exit(0)
}

main().catch(err => {
  console.error('investigation failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
