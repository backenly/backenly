/**
 * Container entry for the Layer 2 extension rehearsal. Staging only, scratch
 * database only, one thing it can do.
 */

import { encodeResult } from '../migration-lineage/probe/output'
import { clientConfig, connect, parseDatabaseUrl } from '../migration-lineage/probe/connect'
import { loadRdsCa } from '../migration-lineage/probe/rds-ca'
import { rehearseExtensions } from './rehearse-extensions'

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? ''

  // Structural refusal, the same shape the maintenance rehearsal uses: this
  // creates and drops databases, so it runs nowhere but staging.
  if (!/staging/i.test(url)) throw new Error('DATABASE_URL does not identify a staging database')
  if (/production|prod-/i.test(url)) throw new Error('DATABASE_URL looks like production')

  const { target } = parseDatabaseUrl(url)
  if (!/\.rds\.amazonaws\.com$/i.test(target.host)) throw new Error('database host is not an RDS endpoint')

  const policy = { mode: 'verify-full' as const, ca: loadRdsCa() }
  const admin = await connect(clientConfig(target, policy))
  try {
    const result = await rehearseExtensions(admin, target, policy)
    console.log(`[layer2] verdict ${result.verdict}`)
    for (const f of result.failures) console.log(`[layer2] FAIL ${f}`)
    for (const u of result.inconclusive) console.log(`[layer2] INCONCLUSIVE ${u}`)
    for (const line of encodeResult(result)) console.log(line)
    process.exitCode = result.verdict === 'PASS' ? 0 : 1
  } finally {
    await admin.end().catch(() => {})
  }
}

main().catch(err => {
  console.error(`[layer2] REFUSED: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 2
})
