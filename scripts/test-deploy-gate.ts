/**
 * Run the actual behavioral verifier against the user's live project to
 * prove the deploy gate will now pass — same code path the deploy flow uses.
 *
 * Usage:
 *   npx tsx scripts/test-deploy-gate.ts <projectId>
 */

import { runBehavioralVerification } from '../lib/ai/behavioral-verifier'

async function main() {
  const projectId = process.argv[2]
  if (!projectId) {
    console.error('Usage: tsx scripts/test-deploy-gate.ts <projectId>')
    process.exit(2)
  }

  console.log(`\nRunning behavioral verifier for project ${projectId}...\n`)
  const t0 = Date.now()
  const result = await runBehavioralVerification(projectId)
  const elapsed = Date.now() - t0

  console.log(`Overall passed: ${result.passed}`)
  console.log(`Elapsed: ${elapsed}ms\n`)
  console.log('Per-check breakdown:')
  for (const check of result.checks) {
    const tag = check.passed ? '✓ PASS'
      : check.skipped ? '⏭ SKIP'
      : '✗ FAIL'
    console.log(`  ${tag}  ${check.id}`)
    console.log(`         name: ${check.name}`)
    if (check.error) {
      console.log(`         error: ${check.error.toString().split('\n')[0].slice(0, 200)}`)
    }
    if (check.skipped && check.skipReason) {
      console.log(`         skipReason: ${check.skipReason}`)
    }
    if (check.details && check.details.length > 0) {
      for (const d of check.details.slice(0, 4)) {
        console.log(`         · ${d}`)
      }
    }
  }

  const failed = result.checks.filter(c => !c.passed && !c.skipped)
  console.log(`\nResult: ${failed.length} failing check${failed.length === 1 ? '' : 's'}`)
  if (failed.length === 0) {
    console.log('→ Deploy gate should now CLEAR.')
  } else {
    console.log('→ Deploy gate will still BLOCK on:')
    for (const f of failed) console.log(`   - ${f.id}: ${(f.error ?? '').toString().split('\n')[0].slice(0, 160)}`)
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('Test runner threw:', err)
  process.exit(2)
})
