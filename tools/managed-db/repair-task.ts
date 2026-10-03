/**
 * Container entry for the Layer 2 parity repair. Staging only, the real
 * database, one mutation vocabulary, and only under stated preconditions.
 *
 * Two independent confirmations are required: the launcher passes
 * LAYER2_CONFIRM, and the URL itself must identify staging. Neither alone is
 * enough, and there is no flag that makes this run anywhere else.
 */

import { encodeResult } from '../migration-lineage/probe/output'
import { clientConfig, connect, parseDatabaseUrl } from '../migration-lineage/probe/connect'
import { loadRdsCa } from '../migration-lineage/probe/rds-ca'
import { repairExtensions, type RepairExpectations } from './repair-extensions'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''
  if (process.env.LAYER2_CONFIRM !== 'repair-staging') {
    throw new Error('LAYER2_CONFIRM is not set to repair-staging; this writes to a real database')
  }
  if (!/staging/i.test(url)) throw new Error('DATABASE_URL does not identify a staging database')
  if (/production|prod-/i.test(url)) throw new Error('DATABASE_URL looks like production')

  const { target } = parseDatabaseUrl(url)
  if (!/\.rds\.amazonaws\.com$/i.test(target.host)) throw new Error('database host is not an RDS endpoint')

  let expectations: RepairExpectations
  try {
    expectations = { availableVersions: JSON.parse(process.env.LAYER2_EXPECTED_VERSIONS ?? '{}') }
  } catch {
    throw new Error('LAYER2_EXPECTED_VERSIONS is not valid JSON')
  }
  if (Object.keys(expectations.availableVersions).length === 0) {
    throw new Error('LAYER2_EXPECTED_VERSIONS is empty; parity expectations must be supplied')
  }

  const client = await connect(clientConfig(target, { mode: 'verify-full', ca: loadRdsCa() }))
  try {
    const result = await repairExtensions(client, expectations)
    console.log(`[layer2-repair] verdict ${result.verdict} database=${result.database}`)
    for (const r of result.refusals) console.log(`[layer2-repair] REFUSED ${r}`)
    for (const f of result.failures) console.log(`[layer2-repair] FAIL ${f}`)
    for (const line of encodeResult(result)) console.log(line)
    process.exitCode = result.verdict === 'PASS' ? 0 : result.verdict === 'REFUSED' ? 2 : 1
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(`[layer2-repair] REFUSED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 2
})
