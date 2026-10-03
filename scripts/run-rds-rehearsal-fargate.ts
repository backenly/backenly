/**
 * PHASE 6 RDS REHEARSAL LAUNCHER — ephemeral in AWS, reproducible in the repo
 * ===========================================================================
 *
 * Runs `scripts/rehearse-maintenance-rds.ts` inside the VPC, against the staging
 * database, as a one-shot Fargate task. Then deregisters everything it created.
 *
 * The staging mechanics — account, region and naming guards, secret selection,
 * task registration, execution, log collection and deregistration — live in
 * `scripts/lib/staging-fargate-task.ts`, shared with the migration-lineage
 * probe. This file supplies only what is specific to the rehearsal: its bundle,
 * its container command, and how to read its verdict.
 *
 * ── Why the rehearsal is injected rather than baked into an image ───────────
 *
 * The runtime image ships `dist-runtime` plus `@prisma/client` and bundles
 * everything else, so `pg` is not resolvable inside it — but Prisma is, which is
 * all the rehearsal needs. The script is bundled with esbuild, base64-encoded,
 * and carried in the TASK DEFINITION rather than a RunTask override, because
 * overrides are capped near 8 KB and a task definition is not.
 *
 * The canonical logic stays in `scripts/rehearse-maintenance-rds.ts`. Nothing
 * authoritative lives inside a shell string.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   REHEARSAL_AWS_ACCOUNT_ID=<staging account id>  *     npx tsx scripts/run-rds-rehearsal-fargate.ts
 *
 * Requires an authenticated AWS CLI on PATH. Exits non-zero if the rehearsal
 * fails or if any guard refuses.
 */

import { writeFileSync } from 'node:fs'
import {
  argValue,
  assertStagingOnly,
  bundleEntry,
  resolveBundle,
  resolveStagingTaskContext,
  runTaskAndReadLogs,
  withEphemeralTaskDefinition,
  type BundleSpec,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'

const LOG_PREFIX = 'rehearsal'
const FAMILY = 'backenly-staging-maintenance-rehearsal'

const RESULT_BEGIN = '---REHEARSAL-RESULT-BEGIN---'
const RESULT_END = '---REHEARSAL-RESULT-END---'

const BUNDLE: BundleSpec = {
  entry: 'scripts/rehearse-maintenance-rds.ts',
  label: 'rehearsal',
  // Present in the runtime image; bundling it would be pointless and huge.
  external: ['@prisma/client', '.prisma/client'],
}

async function main(): Promise<void> {
  // Bundle-only mode: makes no AWS calls at all, so it runs on a machine that
  // has the repo's toolchain but no credentials.
  const emitTo = argValue('--emit-bundle')
  if (emitTo) {
    writeFileSync(emitTo, await bundleEntry(BUNDLE), 'utf8')
    console.log(`  wrote ${emitTo}`)
    process.exit(0)
  }

  console.log('\nPhase 6 RDS rehearsal — staging, one-shot Fargate task\n')
  assertStagingOnly()

  const ctx = resolveStagingTaskContext()
  const b64 = await resolveBundle(BUNDLE)

  const spec: OneShotTaskSpec = {
    family: FAMILY,
    containerName: 'rehearsal',
    logPrefix: LOG_PREFIX,
    startedBy: 'phase6-rds-rehearsal',
    // Decoded at start rather than eval'd from an argv string, so nothing
    // depends on shell quoting.
    command: [
      'sh',
      '-c',
      'echo "$REHEARSAL_B64" | base64 -d > /tmp/rehearsal.cjs && node /tmp/rehearsal.cjs',
    ],
    environment: [{ name: 'REHEARSAL_B64', value: b64 }],
    cpu: '512',
    memory: '1024',
  }

  const exitCode = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const lines = runTaskAndReadLogs(ctx, taskDefArn, spec, {
      complete: ls => ls.some(l => l.includes(RESULT_END)),
    })

    const a = lines.findIndex(l => l.includes(RESULT_BEGIN))
    const b = lines.findIndex(l => l.includes(RESULT_END))
    if (a >= 0 && b > a) {
      const parsed = JSON.parse(lines.slice(a + 1, b).join('\n'))
      console.log('\n  RESULT:', parsed.result)
      for (const [k, v] of Object.entries(parsed.tests)) {
        console.log(`    ${String(v).padEnd(4)} ${k}`)
      }
      return parsed.result === 'PASS' ? 0 : 1
    }
    console.error('\n  no machine-readable result found in the task logs')
    return 1
  })

  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
