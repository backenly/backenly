/**
 * Container entry point for the production lineage capture. One mode, no
 * arguments, no payload: the only inputs are the database URL the task
 * definition supplies and the database name the operator states.
 */

import { encodeResult } from '../../migration-lineage/probe/output'
import { captureProduction } from './run'
import { ProductionGuardRefusal } from './guards'

captureProduction({
  databaseUrl: process.env.DATABASE_URL ?? '',
  expectedDatabase: process.env.PRODUCTION_DB_NAME,
})
  .then(result => {
    console.log(`[production-lineage] verdict ${result.verdict}`)
    for (const f of result.failures) console.log(`[production-lineage] FAIL ${f}`)
    for (const u of result.inconclusive) console.log(`[production-lineage] INCONCLUSIVE ${u}`)
    for (const line of encodeResult(result)) console.log(line)
    // exitCode, not exit(): stdout is a pipe, and exit() can cut off the chunks.
    process.exitCode = result.verdict === 'PASS' ? 0 : 1
  })
  .catch(err => {
    if (err instanceof ProductionGuardRefusal) {
      console.error(`[production-lineage] REFUSED: ${err.message}`)
      process.exitCode = 2
      return
    }
    console.error(`[production-lineage] unhandled: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
