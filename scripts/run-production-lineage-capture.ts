/**
 * PRODUCTION LINEAGE CAPTURE LAUNCHER — read-only by construction
 * ==============================================================
 *
 * Runs `tools/production-lineage/probe` against production as a one-shot Fargate
 * task and writes the decoded capture locally. It reads. It has no other mode.
 *
 * ── Why this does not reuse scripts/lib/staging-fargate-task.ts ─────────────
 *
 * That module is the STAGING execution surface: it carries an arbitrary payload
 * environment variable, it is what the replay tasks ride on, and its guards
 * assert "staging". Adding a production target to it would put one flag between
 * a replay and production. This launcher instead has production constants, one
 * fixed container command, no payload input, and it refuses to ship a probe
 * bundle that contains a mutation primitive
 * (`tools/production-lineage/readonly-audit.ts`). The duplication is the point.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   # Windows (repo toolchain)
 *   npx tsx scripts/run-production-lineage-capture.ts --emit tools/production-lineage/out/bundle
 *
 *   # WSL (authenticated AWS CLI), from the repository root
 *   PRODUCTION_AWS_ACCOUNT_ID=<account> PRODUCTION_DB_NAME=<database> \
 *     node tools/production-lineage/out/bundle/launcher.cjs --run \
 *     --from tools/production-lineage/out/bundle \
 *     --out tools/production-lineage/out/<run> --confirm-production-read
 *
 * Nothing runs without `--confirm-production-read`, and no default points at
 * production: the account and the database name are supplied from outside.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { decodeResult, hasCompleteResult } from '../tools/migration-lineage/probe/output'
import type { ProductionCaptureResult } from '../tools/production-lineage/probe/run'
import { assertReadOnlyBundle, assertReadOnlyModuleGraph } from '../tools/production-lineage/readonly-audit'

const REGION = 'ap-south-1'
const CLUSTER = 'backenly-production'
const SERVICE = 'backenly-production-runtime'
const LOG_GROUP = '/ecs/backenly-production/runtime'
const LOG_PREFIX = 'lineage-capture'
const FAMILY = 'backenly-production-lineage-capture'
const CONTAINER = 'lineage-capture'

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/production-capture.cjs',z.brotliDecompressSync(Buffer.from(process.env.PROBE_B64,'base64')));" +
  "require('/tmp/production-capture.cjs')"

function aws(args: string[]): any {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.trim() ? JSON.parse(out) : null
}

function die(msg: string): never {
  console.error(`\n  REFUSED: ${msg}\n`)
  process.exit(2)
}

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function assertProductionAccount(): void {
  const expected = process.env.PRODUCTION_AWS_ACCOUNT_ID?.trim() ?? ''
  if (!expected) {
    die('PRODUCTION_AWS_ACCOUNT_ID is not set. It is deliberately not hardcoded: this repository is public.')
  }
  const id = aws(['sts', 'get-caller-identity'])
  if (id?.Account !== expected) die(`account is ${id?.Account}, expected ${expected}`)
  if (!CLUSTER.includes('production') || CLUSTER.includes('staging')) die(`cluster "${CLUSTER}" is not production`)
  if (!SERVICE.includes('production') || SERVICE.includes('staging')) die(`service "${SERVICE}" is not production`)
  console.log(`  account ${id.Account} · region ${REGION} · cluster ${CLUSTER}`)
}

/**
 * One secret, and it must be production's.
 *
 * DIRECT_URL is not carried: a read-only capture needs one connection. Nothing
 * that could decrypt anything is carried either.
 */
function productionDbSecret(taskDef: any): Array<{ name: string; valueFrom: string }> {
  const all: Array<{ name: string; valueFrom: string }> = taskDef.containerDefinitions?.[0]?.secrets ?? []
  const wanted = all.filter(s => s.name === 'DATABASE_URL')
  if (wanted.length !== 1) die('production task definition does not expose exactly one DATABASE_URL secret')
  const { valueFrom } = wanted[0]
  if (/staging/i.test(valueFrom)) die(`DATABASE_URL resolves to a staging ARN: ${valueFrom}`)
  if (!/production/i.test(valueFrom)) die(`DATABASE_URL does not identify a production resource: ${valueFrom}`)
  return wanted
}

/** Every page of one log stream; the CLI does not paginate this operation. */
function readLogStream(stream: string): string[] {
  const lines: string[] = []
  let token: string | undefined
  for (let page = 0; page < 1000; page++) {
    const args = ['logs', 'get-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', stream, '--start-from-head']
    if (token) args.push('--next-token', token)
    const res = aws(args)
    for (const e of res?.events ?? []) lines.push(String(e.message))
    const next: string | undefined = res?.nextForwardToken
    if (!next || next === token) return lines
    token = next
  }
  throw new Error(`log stream ${stream} did not end within 1000 pages`)
}

const sleep = (ms: number) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sources(root: string): string[] {
  const probeDir = 'tools/production-lineage/probe'
  const shared = 'tools/migration-lineage/probe'
  return [
    ...readdirSync(join(root, probeDir)).filter(f => f.endsWith('.ts')).map(f => `${probeDir}/${f}`),
    'tools/production-lineage/readonly-audit.ts',
    `${shared}/capture.ts`,
    `${shared}/connect.ts`,
    `${shared}/inventory.ts`,
    `${shared}/output.ts`,
    `${shared}/rds-ca.ts`,
    'scripts/run-production-lineage-capture.ts',
  ].sort()
}

const digests = (root: string): Record<string, string> =>
  Object.fromEntries(sources(root).map(rel => [rel, createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')]))

function assertRepoRoot(root: string): void {
  for (const marker of ['prisma/schema.prisma', 'AGENTS.md', 'tools/production-lineage/probe/task.ts']) {
    if (!existsSync(join(root, marker))) die(`${root} is not the repository root (no ${marker})`)
  }
}

async function emit(dir: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  mkdirSync(dir, { recursive: true })

  const { build } = await import('esbuild')
  const probe = await build({
    entryPoints: [join(root, 'tools', 'production-lineage', 'probe', 'task.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    external: ['pg-native', 'pg-cloudflare', 'cloudflare:sockets'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  })
  const code = probe.outputFiles[0].text
  const probeModules = Object.keys(probe.metafile?.inputs ?? {})
  // The structural gate, both halves: a bundle that can mutate never gets
  // written, and neither does one that merely reaches the machinery.
  assertReadOnlyBundle(code)
  assertReadOnlyModuleGraph(probeModules)
  console.log(`  read-only audit: ${probeModules.length} modules, no mutation primitives, no mutation-capable imports`)

  const launcher = await build({
    entryPoints: [join(root, 'scripts', 'run-production-lineage-capture.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['esbuild'],
    write: false,
    logLevel: 'silent',
  })

  const probeB64 = brotliCompressSync(Buffer.from(code, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64')
  writeFileSync(join(dir, 'probe.b64'), probeB64)
  writeFileSync(join(dir, 'launcher.cjs'), launcher.outputFiles[0].text)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sources: digests(root),
        probeModules,
        environmentBytes: BOOTSTRAP.length + probeB64.length,
      },
      null,
      2,
    ),
  )
  console.log(`  probe ${(probeB64.length / 1024).toFixed(1)} KB of environment`)
  console.log(`  wrote bundle to ${dir}`)
}

function summarise(r: ProductionCaptureResult): void {
  console.log(`\n  capture: ${r.verdict}`)
  for (const f of r.failures) console.log(`    FAIL          ${f}`)
  for (const u of r.inconclusive) console.log(`    INCONCLUSIVE  ${u}`)
  if (r.tls) console.log(`    tls           authorized=${r.tls.authorized} server.ssl=${r.tls.server.ssl} ${r.tls.protocol}`)
  if (r.role) console.log(`    role          ${JSON.stringify(r.role)}`)
  if (r.rls) {
    console.log(`    rls           consistent=${r.rls.consistent} policies=${r.rls.policiesTotalJoined}`)
    for (const s of r.rls.bySchema) {
      console.log(`      ${s.schema.padEnd(22)} tables=${s.tables} rls=${s.rlsEnabled} forced=${s.rlsForced} policies=${s.policiesFromCatalog} ${s.classification}`)
    }
  }
  if (r.snapshot) {
    const s = r.snapshot
    console.log(
      `    captured      ${s.meta.schemas.join(',')} tables=${s.tables.length} columns=${s.columns.length} ` +
        `constraints=${s.constraints.length} indexes=${s.indexes.length} policies=${s.policies.length} ` +
        `triggers=${s.triggers.length} routines=${s.routines.length} eventTriggers=${s.eventTriggers.length}`,
    )
  }
}

async function run(from: string, out: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  if (!process.argv.includes('--confirm-production-read')) {
    die('this reads the production database; pass --confirm-production-read to say so explicitly')
  }
  const database = process.env.PRODUCTION_DB_NAME?.trim()
  if (!database) die('PRODUCTION_DB_NAME is not set; state the database this capture is allowed to read')

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
  const now = digests(root)
  for (const key of new Set([...Object.keys(now), ...Object.keys(manifest.sources)])) {
    if (manifest.sources[key] !== now[key]) die(`${key} has changed since the bundle was emitted; re-emit it`)
  }

  const probeB64 = readFileSync(join(from, 'probe.b64'), 'utf8')
  // Audited again here, on the bytes about to be shipped and on the module list
  // recorded when they were built, not only at build time.
  assertReadOnlyBundle(brotliDecompressSync(Buffer.from(probeB64, 'base64')).toString('utf8'))
  assertReadOnlyModuleGraph(manifest.probeModules ?? [])
  console.log('\nProduction lineage capture — read-only, one-shot Fargate task\n')
  console.log('  read-only audit: no mutation primitives in the shipped bundle')

  assertProductionAccount()

  const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE])?.services?.[0]
  if (!svc) die(`service ${SERVICE} not found in ${CLUSTER}`)
  const net = svc.networkConfiguration?.awsvpcConfiguration
  if (!net) die('production service has no awsvpc configuration to mirror')
  const srcDef = aws(['ecs', 'describe-task-definition', '--task-definition', SERVICE])?.taskDefinition
  if (!srcDef) die('could not read the production task definition')
  const secrets = productionDbSecret(srcDef)
  console.log(`  secrets carried: ${secrets.map(s => s.name).join(', ')}`)
  console.log(`  expected database: ${database}`)

  const container = {
    name: CONTAINER,
    image: srcDef.containerDefinitions[0].image,
    essential: true,
    command: ['sh', '-c', 'exec node -e "$CAPTURE_BOOTSTRAP"'],
    environment: [
      { name: 'CAPTURE_BOOTSTRAP', value: BOOTSTRAP },
      { name: 'PROBE_B64', value: probeB64 },
      { name: 'PRODUCTION_DB_NAME', value: database },
      { name: 'NODE_PATH', value: '/app/node_modules' },
    ],
    secrets,
    logConfiguration: {
      logDriver: 'awslogs',
      options: { 'awslogs-group': LOG_GROUP, 'awslogs-region': REGION, 'awslogs-stream-prefix': LOG_PREFIX },
    },
  }

  // Cleanup is armed from the moment a durable AWS resource can exist, so it
  // covers the window between a successful registration and reading its ARN.
  // Registering outside the try is how the staging launcher leaked a task
  // definition once already.
  let taskDefArn: string | null = null
  let exitCode = 1
  try {
    const registered = aws([
      'ecs', 'register-task-definition',
      '--family', FAMILY,
      '--requires-compatibilities', 'FARGATE',
      '--network-mode', 'awsvpc',
      '--cpu', '512',
      '--memory', '1024',
      '--execution-role-arn', srcDef.executionRoleArn,
      '--container-definitions', JSON.stringify([container]),
    ])?.taskDefinition
    if (!registered?.taskDefinitionArn) throw new Error('register-task-definition returned no taskDefinitionArn')
    taskDefArn = String(registered.taskDefinitionArn)
    console.log(`  registered ${taskDefArn.split('/').pop()}`)

    const netCfg = JSON.stringify({
      awsvpcConfiguration: { subnets: net.subnets, securityGroups: net.securityGroups, assignPublicIp: net.assignPublicIp },
    })
    const started = aws([
      'ecs', 'run-task',
      '--cluster', CLUSTER,
      '--task-definition', taskDefArn,
      '--launch-type', 'FARGATE',
      '--network-configuration', netCfg,
      '--started-by', 'production-lineage-capture',
    ])
    if (started?.failures?.length) throw new Error(`run-task failed: ${JSON.stringify(started.failures)}`)

    const taskArn: string = started.tasks[0].taskArn
    const taskId = taskArn.split('/').pop()!
    console.log(`  task ${taskId} starting…`)
    execFileSync('aws', ['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER, '--tasks', taskArn, '--region', REGION], { stdio: 'inherit' })
    const done = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', taskArn])?.tasks?.[0]
    console.log(`  task stopped: ${done?.stoppedReason ?? 'n/a'} (exit ${done?.containers?.[0]?.exitCode})`)

    let lines: string[] = []
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        lines = readLogStream(`${LOG_PREFIX}/${CONTAINER}/${taskId}`)
        if (hasCompleteResult(lines)) break
        if (attempt < 6) console.log(`  logs incomplete, waiting for delivery (${attempt}/6)`)
      } catch (err) {
        console.error('  could not read task logs:', err instanceof Error ? err.message : err)
      }
      if (attempt < 6) sleep(Number(process.env.CAPTURE_LOG_POLL_MS ?? 5000))
    }
    for (const l of lines) if (!l.startsWith('LINEAGE-CHUNK ')) console.log(`    | ${l}`)

    if (!hasCompleteResult(lines)) {
      console.error('\n  no complete result in the task logs')
    } else {
      const result = decodeResult<ProductionCaptureResult>(lines)
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'production-capture.json'), JSON.stringify(result, null, 2))
      summarise(result)
      console.log(`\n  wrote ${join(out, 'production-capture.json')}`)
      exitCode = result.verdict === 'PASS' ? 0 : 1
    }
  } finally {
    if (taskDefArn) {
      const name = taskDefArn.split('/').pop()
      try {
        aws(['ecs', 'deregister-task-definition', '--task-definition', taskDefArn])
        console.log(`  deregistered ${name}`)
      } catch (err) {
        console.error(`  CLEANUP FAILED: ${name} is still registered: ${err instanceof Error ? err.message : String(err)}`)
        console.error('  deregister it by hand; this run does not count as clean')
        if (exitCode === 0) exitCode = 3
      }
    }
  }
  process.exit(exitCode)
}

async function main(): Promise<void> {
  const emitTo = argValue('--emit')
  if (emitTo) return emit(emitTo)
  if (!process.argv.includes('--run')) die('usage: --emit <dir> | --run --from <dir> --out <dir> --confirm-production-read')
  const from = argValue('--from')
  const out = argValue('--out')
  if (!from || !out) die('--run needs --from <bundle dir> and --out <result dir>')
  return run(from, out)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
