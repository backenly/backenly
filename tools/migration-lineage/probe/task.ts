/**
 * Container entry point for the lineage probe. Bundled by
 * scripts/run-migration-lineage-fargate.ts and run once inside a staging task.
 */

import { encodeResult } from './output'
import { ProbeRefusal, runProbe } from './run'

runProbe({
  mode: process.env.LINEAGE_MODE,
  databaseUrl: process.env.DATABASE_URL ?? '',
  local: process.env.LINEAGE_LOCAL === '1',
  inputB64: process.env.LINEAGE_INPUT_B64,
})
  .then(result => {
    console.log(`[lineage] ${result.mode} verdict ${result.verdict}`)
    for (const f of result.failures) console.log(`[lineage] FAIL ${f}`)
    for (const u of result.inconclusive) console.log(`[lineage] INCONCLUSIVE ${u}`)
    for (const line of encodeResult(result)) console.log(line)
    // exitCode, not exit(): stdout is a pipe in a container, and exit() can cut
    // off the result chunks still being written.
    process.exitCode = result.verdict === 'PASS' || result.verdict === 'LOCAL_ONLY' ? 0 : 1
  })
  .catch(err => {
    if (err instanceof ProbeRefusal) {
      console.error(`[lineage] REFUSED: ${err.message}`)
      process.exitCode = 2
      return
    }
    console.error(`[lineage] unhandled: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
