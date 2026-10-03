/**
 * Runs a lineage probe mode against a LOOPBACK PostgreSQL, for development.
 *
 *   LINEAGE_LOCAL_DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     npx tsx tools/migration-lineage/run-local.ts <tls-rls|capture|replay-chain|replay-push> [--out file.json]
 *
 * The URL is read from its own variable, never from .env, so a local run cannot
 * pick up a remote DATABASE_URL by accident; the probe refuses any host that is
 * not loopback regardless. Verdicts are LOCAL_ONLY: a local run proves the code
 * path, not anything about staging.
 */

import { writeFileSync } from 'node:fs'
import { buildChainInput, buildPushInput, assertRepoRoot } from './build-inputs'
import { encodeInput } from './probe/input'
import { runProbe, type ProbeResult } from './probe/run'

const MODES = {
  'tls-rls': { mode: 'tls-rls', input: null },
  capture: { mode: 'capture-staging', input: null },
  'replay-chain': { mode: 'replay', input: buildChainInput },
  'replay-push': { mode: 'replay', input: buildPushInput },
} as const

function summarise(r: ProbeResult): void {
  console.log(`  verdict ${r.verdict}`)
  for (const f of r.failures) console.log(`  FAIL ${f}`)
  for (const u of r.inconclusive) console.log(`  INCONCLUSIVE ${u}`)
  if (r.replay) console.log(`  replay ${r.replay.status} ${r.replay.applied}/${r.replay.total}`)
  if (r.snapshot) {
    const s = r.snapshot
    console.log(
      `  captured ${s.meta.schemas.join(',')}: tables ${s.tables.length}, columns ${s.columns.length}, ` +
        `constraints ${s.constraints.length}, indexes ${s.indexes.length}, types ${s.types.length}, ` +
        `policies ${s.policies.length}, triggers ${s.triggers.length}, routines ${s.routines.length}, ` +
        `event triggers ${s.eventTriggers.length}`,
    )
  }
  if (r.rlsControl) console.log(`  rls control failures ${JSON.stringify(r.rlsControl.failures)} error ${r.rlsControl.error}`)
  for (const c of r.scratch) console.log(`  scratch ${c.name} created=${c.created} dropped=${c.dropped}`)
  console.log(`  scratch databases after: ${JSON.stringify(r.scratchDatabasesAfter)}`)
}

async function main(): Promise<void> {
  const choice = process.argv[2] as keyof typeof MODES
  const spec = MODES[choice]
  if (!spec) {
    console.error(`usage: run-local.ts <${Object.keys(MODES).join('|')}> [--out file.json]`)
    process.exit(2)
  }
  const url = process.env.LINEAGE_LOCAL_DATABASE_URL
  if (!url) {
    console.error('LINEAGE_LOCAL_DATABASE_URL is not set')
    process.exit(2)
  }
  const root = process.cwd()
  assertRepoRoot(root)

  const result = await runProbe({
    mode: spec.mode,
    databaseUrl: url,
    local: true,
    inputB64: spec.input ? encodeInput(spec.input(root)) : undefined,
  })
  summarise(result)

  const i = process.argv.indexOf('--out')
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], JSON.stringify(result, null, 2))
  process.exitCode = result.verdict === 'LOCAL_ONLY' ? 0 : 1
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
