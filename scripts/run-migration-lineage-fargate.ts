/**
 * MIGRATION LINEAGE LAUNCHER — staging, one-shot Fargate tasks, staging read-only
 * ===============================================================================
 *
 * Runs `tools/migration-lineage/probe` inside the staging VPC, one task per
 * database state, and writes each decoded result locally. It answers the gate in
 * docs/managed-db-migration-findings.md: can the current Prisma model plus
 * documented non-Prisma effects fully explain staging? This launcher compares
 * nothing itself; comparison runs locally over the results.
 *
 * Tasks, in the only order they run:
 *
 *   tls-rls          verified TLS with negative controls, RLS visibility on
 *                    staging, RLS positive control in a scratch database
 *   capture-staging  C: read-only capture of staging plus provisioning inventory
 *   replay-chain     A: the legacy 18-migration chain, replayed and captured
 *   replay-push      P: the schema.prisma projection, replayed and captured
 *
 * Nothing runs after tls-rls unless tls-rls passed, in this run or a previous
 * one recorded in the same output directory.
 *
 * ── One task per state ──────────────────────────────────────────────────────
 *
 * A task definition is capped at 64 KB. The pg client, the probe, the chain and
 * the schema projection together exceed that once base64-encoded, so each task
 * carries the probe plus only its own SQL, brotli-compressed.
 *
 * ── Two halves, two platforms ───────────────────────────────────────────────
 *
 *   # Windows (repo toolchain: esbuild, Prisma CLI)
 *   npx tsx scripts/run-migration-lineage-fargate.ts --emit tools/migration-lineage/out/bundle
 *
 *   # WSL (authenticated AWS CLI), from the repository root
 *   REHEARSAL_AWS_ACCOUNT_ID=<staging account id> \
 *     node tools/migration-lineage/out/bundle/launcher.cjs --run tls-rls \
 *     --from tools/migration-lineage/out/bundle --out tools/migration-lineage/out/<run>
 *
 * The run half refuses a bundle if any source it was built from has changed
 * since, compared by SHA-256 rather than modification time.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import { assertRepoRoot, buildChainInput, buildPushInput, EVIDENCE_DIR } from '../tools/migration-lineage/build-inputs'
import { encodeInput } from '../tools/migration-lineage/probe/input'
import { decodeResult, hasCompleteResult } from '../tools/migration-lineage/probe/output'
import type { ProbeResult } from '../tools/migration-lineage/probe/run'
import {
  argValue,
  assertStagingOnly,
  die,
  resolveStagingTaskContext,
  runTaskAndReadLogs,
  withEphemeralTaskDefinition,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'

const TASKS = ['tls-rls', 'capture-staging', 'replay-chain', 'replay-push'] as const
type TaskName = (typeof TASKS)[number]

// Headroom under the 64 KB task-definition limit for the rest of the definition.
const ENVIRONMENT_BUDGET = 58_000

// Decoded at start, from an environment variable, so nothing depends on quoting.
const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/lineage-probe.cjs',z.brotliDecompressSync(Buffer.from(process.env.PROBE_B64,'base64')));" +
  "require('/tmp/lineage-probe.cjs')"

function sources(root: string): string[] {
  const probeDir = 'tools/migration-lineage/probe'
  return [
    ...readdirSync(join(root, probeDir)).filter(f => f.endsWith('.ts')).map(f => `${probeDir}/${f}`),
    'tools/migration-lineage/build-inputs.ts',
    `${EVIDENCE_DIR}/SHA256SUMS`,
    'prisma/schema.prisma',
    'scripts/run-migration-lineage-fargate.ts',
    'scripts/lib/staging-fargate-task.ts',
  ].sort()
}

function digests(root: string): Record<string, string> {
  return Object.fromEntries(
    sources(root).map(rel => [rel, createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')]),
  )
}

const brotli = (buf: Buffer) =>
  brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).toString('base64')

async function emit(dir: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  mkdirSync(dir, { recursive: true })

  // Lazy for the same reason as the rehearsal: esbuild's native binary must not
  // be required on the platform that only runs the bundle.
  const { build } = await import('esbuild')
  const probe = await build({
    entryPoints: [join(root, 'tools', 'migration-lineage', 'probe', 'task.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
    write: false,
    logLevel: 'silent',
  })
  const launcher = await build({
    entryPoints: [join(root, 'scripts', 'run-migration-lineage-fargate.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['esbuild'],
    write: false,
    logLevel: 'silent',
  })

  const probeB64 = brotli(Buffer.from(probe.outputFiles[0].text, 'utf8'))
  const chainB64 = encodeInput(buildChainInput(root))
  const pushB64 = encodeInput(buildPushInput(root))

  writeFileSync(join(dir, 'probe.b64'), probeB64)
  writeFileSync(join(dir, 'input-chain.b64'), chainB64)
  writeFileSync(join(dir, 'input-push.b64'), pushB64)
  writeFileSync(join(dir, 'launcher.cjs'), launcher.outputFiles[0].text)

  const budget = {
    'tls-rls': BOOTSTRAP.length + probeB64.length,
    'capture-staging': BOOTSTRAP.length + probeB64.length,
    'replay-chain': BOOTSTRAP.length + probeB64.length + chainB64.length,
    'replay-push': BOOTSTRAP.length + probeB64.length + pushB64.length,
  }
  for (const [task, bytes] of Object.entries(budget)) {
    console.log(`  ${task.padEnd(16)} ${(bytes / 1024).toFixed(1)} KB of environment`)
    if (bytes > ENVIRONMENT_BUDGET) die(`${task} would exceed the task-definition budget (${bytes} bytes)`)
  }

  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), sources: digests(root), environmentBytes: budget }, null, 2),
  )
  console.log(`  wrote bundle to ${dir}`)
}

function summarise(task: TaskName, r: ProbeResult): void {
  console.log(`\n  ${task}: ${r.verdict}`)
  for (const f of r.failures) console.log(`    FAIL          ${f}`)
  for (const u of r.inconclusive) console.log(`    INCONCLUSIVE  ${u}`)
  if (r.tls && 'authorized' in r.tls) {
    console.log(`    tls           authorized=${r.tls.authorized} server.ssl=${r.tls.server.ssl} ${r.tls.protocol} ${r.tls.server.cipher}`)
    console.log(`    chain         ${r.tls.chain.map(c => c.subject).join(' <- ')}`)
  }
  for (const c of r.tlsControls) {
    console.log(`    control       ${c.refusedByVerification ? 'REFUSED' : 'NOT REFUSED'} ${c.label} (${c.code})`)
  }
  if (r.rls) {
    console.log(`    rls           consistent=${r.rls.consistent} policies pg_policy=${r.rls.policiesTotalUnjoined} joined=${r.rls.policiesTotalJoined} view=${r.rls.policiesTotalView}`)
    for (const s of r.rls.bySchema) {
      console.log(`      ${s.schema.padEnd(22)} tables=${s.tables} rls=${s.rlsEnabled} forced=${s.rlsForced} policies=${s.policiesFromCatalog} ${s.classification}`)
    }
  }
  if (r.rlsControl) console.log(`    rls control   failures=${JSON.stringify(r.rlsControl.failures)} error=${r.rlsControl.error}`)
  if (r.replay) console.log(`    replay        ${r.replay.status} ${r.replay.applied}/${r.replay.total}`)
  if (r.snapshot) {
    const s = r.snapshot
    console.log(
      `    captured      ${s.meta.schemas.join(',')} tables=${s.tables.length} columns=${s.columns.length} ` +
        `constraints=${s.constraints.length} indexes=${s.indexes.length} policies=${s.policies.length} ` +
        `triggers=${s.triggers.length} routines=${s.routines.length} eventTriggers=${s.eventTriggers.length}`,
    )
  }
  for (const c of r.scratch) console.log(`    scratch       ${c.name} created=${c.created} dropped=${c.dropped}${c.error ? ` ${c.error}` : ''}`)
  if (r.scratchDatabasesAfter) console.log(`    leftovers     ${JSON.stringify(r.scratchDatabasesAfter)}`)
}

async function run(requested: TaskName[], from: string, out: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
  const now = digests(root)
  const keys = new Set([...Object.keys(now), ...Object.keys(manifest.sources)])
  for (const k of keys) {
    if (manifest.sources[k] !== now[k]) die(`${k} has changed since the bundle was emitted; re-emit it`)
  }

  mkdirSync(out, { recursive: true })
  if (!requested.includes('tls-rls')) {
    const prior = join(out, 'tls-rls.json')
    if (!existsSync(prior) || JSON.parse(readFileSync(prior, 'utf8')).verdict !== 'PASS') {
      die(`tls-rls has not passed in ${out}; run it first`)
    }
  }

  console.log('\nMigration lineage probe — staging, one-shot Fargate tasks\n')
  assertStagingOnly()
  const ctx = resolveStagingTaskContext()
  const probeB64 = readFileSync(join(from, 'probe.b64'), 'utf8')

  let overall = 0
  for (const task of TASKS.filter(t => requested.includes(t))) {
    console.log(`\n── ${task}`)
    const environment = [
      { name: 'LINEAGE_BOOTSTRAP', value: BOOTSTRAP },
      { name: 'PROBE_B64', value: probeB64 },
      { name: 'LINEAGE_MODE', value: task.startsWith('replay-') ? 'replay' : task },
    ]
    if (task === 'replay-chain') environment.push({ name: 'LINEAGE_INPUT_B64', value: readFileSync(join(from, 'input-chain.b64'), 'utf8') })
    if (task === 'replay-push') environment.push({ name: 'LINEAGE_INPUT_B64', value: readFileSync(join(from, 'input-push.b64'), 'utf8') })
    const bytes = environment.reduce((n, e) => n + e.name.length + e.value.length, 0)
    if (bytes > ENVIRONMENT_BUDGET) die(`${task} exceeds the task-definition budget (${bytes} bytes)`)

    const spec: OneShotTaskSpec = {
      family: 'backenly-staging-migration-lineage',
      containerName: 'lineage',
      logPrefix: 'lineage',
      startedBy: 'migration-lineage-probe',
      command: ['sh', '-c', 'exec node -e "$LINEAGE_BOOTSTRAP"'],
      environment,
      cpu: '512',
      memory: '1024',
    }

    let verdict: string = 'NO_RESULT'
    const code = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
      const lines = runTaskAndReadLogs(ctx, taskDefArn, spec, {
        complete: hasCompleteResult,
        echo: line => !line.startsWith('LINEAGE-CHUNK '),
      })
      if (!hasCompleteResult(lines)) {
        console.error('\n  no complete result in the task logs')
        return 1
      }
      const result = decodeResult<ProbeResult>(lines)
      writeFileSync(join(out, `${task}.json`), JSON.stringify(result, null, 2))
      verdict = result.verdict
      summarise(task, result)
      return result.verdict === 'PASS' ? 0 : 1
    })

    if (code !== 0) overall = code
    if (task === 'tls-rls' && verdict !== 'PASS') {
      console.error('\n  tls-rls did not pass; no later task runs')
      break
    }
  }
  process.exit(overall)
}

async function main(): Promise<void> {
  const emitTo = argValue('--emit')
  if (emitTo) return emit(emitTo)

  const tasks = (argValue('--run') ?? '').split(',').filter(Boolean)
  const from = argValue('--from')
  const out = argValue('--out')
  if (tasks.length === 0 || !from || !out) {
    die('usage: --emit <dir>  |  --run <task[,task]> --from <bundle dir> --out <result dir>')
  }
  for (const t of tasks) if (!(TASKS as readonly string[]).includes(t)) die(`unknown task ${t}`)
  return run(tasks as TaskName[], from, out)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
