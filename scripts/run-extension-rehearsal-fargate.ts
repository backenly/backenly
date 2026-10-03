/**
 * LAYER 2 EXTENSION REHEARSAL LAUNCHER — staging, scratch database only
 * =====================================================================
 *
 * Runs `tools/managed-db/rehearsal-task.ts` inside the staging VPC as a one-shot
 * Fargate task. It proves extension provisioning in a throwaway database: the
 * real staging database is not touched, and Layer 3 and Layer 4 are not involved.
 *
 * Before the bundle may ship it must pass the Layer 2 audit: exactly one
 * mutation vocabulary (`CREATE EXTENSION IF NOT EXISTS`), no drops, no roles,
 * no grants, no event triggers, no tenant schemas, no migration runner, and no
 * import that reaches the SQL replay path or the Layer 4 installers. The audit
 * also fails a bundle that contains NO mutation at all, because a provisioner
 * that cannot install anything is broken rather than safe.
 *
 *   # Windows
 *   npx tsx scripts/run-extension-rehearsal-fargate.ts --emit tools/managed-db/out/bundle
 *
 *   # WSL, from the repository root
 *   REHEARSAL_AWS_ACCOUNT_ID=<staging account id> \
 *     node tools/managed-db/out/bundle/launcher.cjs --run \
 *     --from tools/managed-db/out/bundle --out tools/managed-db/out/<run>
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { decodeResult, hasCompleteResult } from '../tools/migration-lineage/probe/output'
import {
  assertProvisionerBundle,
  assertProvisionerModules,
} from '../tools/managed-db/provisioner-audit'
import type { ExtensionRehearsalResult } from '../tools/managed-db/rehearse-extensions'
import type { RepairResult } from '../tools/managed-db/repair-extensions'
import {
  argValue,
  assertStagingOnly,
  die,
  resolveStagingTaskContext,
  runTaskAndReadLogs,
  withEphemeralTaskDefinition,
  type OneShotTaskSpec,
} from './lib/staging-fargate-task'

const FAMILY = 'backenly-staging-layer2-extensions'
const CONTAINER = 'layer2'
const LOG_PREFIX = 'layer2'

const BOOTSTRAP =
  "const z=require('zlib'),f=require('fs');" +
  "f.writeFileSync('/tmp/layer2.cjs',z.brotliDecompressSync(Buffer.from(process.env.PROBE_B64,'base64')));" +
  "require('/tmp/layer2.cjs')"

function sources(root: string): string[] {
  const dir = 'tools/managed-db'
  const shared = 'tools/migration-lineage/probe'
  return [
    ...readdirSync(join(root, dir)).filter(f => f.endsWith('.ts')).map(f => `${dir}/${f}`),
    `${shared}/capabilities.ts`,
    `${shared}/connect.ts`,
    `${shared}/output.ts`,
    `${shared}/rds-ca.ts`,
    'scripts/run-extension-rehearsal-fargate.ts',
  ].sort()
}

const digests = (root: string): Record<string, string> =>
  Object.fromEntries(sources(root).map(rel => [rel, createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')]))

function assertRepoRoot(root: string): void {
  for (const marker of ['prisma/schema.prisma', 'AGENTS.md', 'tools/managed-db/rehearsal-task.ts']) {
    if (!existsSync(join(root, marker))) die(`${root} is not the repository root (no ${marker})`)
  }
}

async function emit(dir: string): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  mkdirSync(dir, { recursive: true })

  const { build } = await import('esbuild')
  const probe = await build({
    entryPoints: [join(root, 'tools', 'managed-db', 'rehearsal-task.ts')],
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
  const modules = Object.keys(probe.metafile?.inputs ?? {})
  assertProvisionerBundle(code)
  assertProvisionerModules(modules)
  console.log(`  layer 2 audit: ${modules.length} modules, one mutation vocabulary, nothing it does not own`)

  const launcher = await build({
    entryPoints: [join(root, 'scripts', 'run-extension-rehearsal-fargate.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['esbuild'],
    write: false,
    logLevel: 'silent',
  })

  // The repair entry is the same mechanism pointed at a real database. It is
  // audited by exactly the same rules: one mutation vocabulary, nothing else.
  const repair = await build({
    entryPoints: [join(root, 'tools', 'managed-db', 'repair-task.ts')],
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
  const repairCode = repair.outputFiles[0].text
  const repairModules = Object.keys(repair.metafile?.inputs ?? {})
  assertProvisionerBundle(repairCode)
  assertProvisionerModules(repairModules)
  console.log(`  layer 2 audit: repair bundle ${repairModules.length} modules, same vocabulary`)

  const pack = (text: string) =>
    brotliCompressSync(Buffer.from(text, 'utf8'), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).toString('base64')
  const probeB64 = pack(code)
  const repairB64 = pack(repairCode)
  writeFileSync(join(dir, 'probe.b64'), probeB64)
  writeFileSync(join(dir, 'repair.b64'), repairB64)
  writeFileSync(join(dir, 'launcher.cjs'), launcher.outputFiles[0].text)
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { createdAt: new Date().toISOString(), sources: digests(root), probeModules: modules, repairModules },
      null,
      2,
    ),
  )
  console.log(`  probe ${(probeB64.length / 1024).toFixed(1)} KB · repair ${(repairB64.length / 1024).toFixed(1)} KB of environment`)
  console.log(`  wrote bundle to ${dir}`)
}

function summarise(r: ExtensionRehearsalResult): void {
  console.log(`\n  layer 2 rehearsal: ${r.verdict}`)
  for (const f of r.failures) console.log(`    FAIL          ${f}`)
  for (const u of r.inconclusive) console.log(`    INCONCLUSIVE  ${u}`)
  console.log(`    before        ${r.beforeStatuses.map(s => `${s.name}=${s.status}`).join(' ')}`)
  console.log(`    installed     ${JSON.stringify(r.firstRun?.executed ?? [])}`)
  console.log(`    operational   ${JSON.stringify(r.firstRun?.operational ?? [])}`)
  for (const id of r.identitiesAfterFirst) console.log(`    identity      ${id.name} ${id.version} in ${id.schema}`)
  console.log(`    second run    executed ${JSON.stringify(r.secondRun?.executed ?? [])}, idempotent=${r.idempotent}`)
  console.log(`    scratch       ${r.scratch?.name} created=${r.scratch?.created} dropped=${r.scratch?.dropped}`)
  console.log(`    leftovers     ${JSON.stringify(r.scratchDatabasesAfter)}`)
}

/** Parity expectations come from the production capture, not from a constant. */
function expectedVersions(capturePath: string): Record<string, string> {
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'))
  const extensions: Array<{ name: string; version: string }> = capture?.snapshot?.extensions ?? []
  const wanted = Object.fromEntries(
    extensions.filter(e => e.name !== 'plpgsql').map(e => [e.name, e.version]),
  )
  if (Object.keys(wanted).length === 0) die(`${capturePath} holds no extension versions to expect`)
  return wanted
}

function summariseRepair(r: RepairResult): void {
  console.log(`\n  layer 2 parity repair: ${r.verdict}   database=${r.database}`)
  for (const x of r.refusals) console.log(`    REFUSED       ${x}`)
  for (const f of r.failures) console.log(`    FAIL          ${f}`)
  console.log(`    before        ${r.beforeStatuses.map(s => `${s.name}=${s.status}`).join(' ')}`)
  console.log(`    installed     ${JSON.stringify(r.outcome?.executed ?? [])}`)
  console.log(`    after         ${r.afterStatuses.map(s => `${s.name}=${s.status}`).join(' ')}`)
  for (const id of r.identities) console.log(`    identity      ${id.name} ${id.version} in ${id.schema}`)
}

async function run(from: string, out: string, mode: 'rehearsal' | 'repair'): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)

  const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
  const now = digests(root)
  for (const key of new Set([...Object.keys(now), ...Object.keys(manifest.sources)])) {
    if (manifest.sources[key] !== now[key]) die(`${key} has changed since the bundle was emitted; re-emit it`)
  }

  const bundleFile = mode === 'repair' ? 'repair.b64' : 'probe.b64'
  const probeB64 = readFileSync(join(from, bundleFile), 'utf8')
  assertProvisionerBundle(brotliDecompressSync(Buffer.from(probeB64, 'base64')).toString('utf8'))
  assertProvisionerModules((mode === 'repair' ? manifest.repairModules : manifest.probeModules) ?? [])

  const environment = [
    { name: 'LAYER2_BOOTSTRAP', value: BOOTSTRAP },
    { name: 'PROBE_B64', value: probeB64 },
  ]

  if (mode === 'repair') {
    // Writing to the real staging database needs saying so, and needs the
    // parity reference it is being repaired towards.
    if (!process.argv.includes('--confirm-staging-write')) {
      die('repair writes to the real staging database; pass --confirm-staging-write to say so explicitly')
    }
    const expectPath = argValue('--expect')
    if (!expectPath) die('repair needs --expect <production capture json> to state the parity expectations')
    const versions = expectedVersions(expectPath)
    environment.push({ name: 'LAYER2_CONFIRM', value: 'repair-staging' })
    environment.push({ name: 'LAYER2_EXPECTED_VERSIONS', value: JSON.stringify(versions) })
    console.log('\nLayer 2 parity repair — staging, the REAL database\n')
    console.log(`  expecting: ${Object.entries(versions).map(([n, v]) => `${n} ${v}`).join(', ')}`)
  } else {
    console.log('\nLayer 2 extension rehearsal — staging, scratch database only\n')
  }
  console.log('  layer 2 audit: shipped bundle is one mutation vocabulary')
  assertStagingOnly()
  const ctx = resolveStagingTaskContext()

  const spec: OneShotTaskSpec = {
    family: mode === 'repair' ? `${FAMILY}-repair` : FAMILY,
    containerName: CONTAINER,
    logPrefix: LOG_PREFIX,
    startedBy: mode === 'repair' ? 'layer2-parity-repair' : 'layer2-extension-rehearsal',
    command: ['sh', '-c', 'exec node -e "$LAYER2_BOOTSTRAP"'],
    environment,
    cpu: '512',
    memory: '1024',
  }

  const exitCode = await withEphemeralTaskDefinition(ctx, spec, taskDefArn => {
    const lines = runTaskAndReadLogs(ctx, taskDefArn, spec, {
      complete: hasCompleteResult,
      echo: line => !line.startsWith('LINEAGE-CHUNK '),
    })
    if (!hasCompleteResult(lines)) {
      console.error('\n  no complete result in the task logs')
      return 1
    }
    mkdirSync(out, { recursive: true })
    if (mode === 'repair') {
      const result = decodeResult<RepairResult>(lines)
      writeFileSync(join(out, 'layer2-parity-repair.json'), JSON.stringify(result, null, 2))
      summariseRepair(result)
      console.log(`\n  wrote ${join(out, 'layer2-parity-repair.json')}`)
      return result.verdict === 'PASS' ? 0 : result.verdict === 'REFUSED' ? 2 : 1
    }
    const result = decodeResult<ExtensionRehearsalResult>(lines)
    writeFileSync(join(out, 'layer2-extension-rehearsal.json'), JSON.stringify(result, null, 2))
    summarise(result)
    console.log(`\n  wrote ${join(out, 'layer2-extension-rehearsal.json')}`)
    return result.verdict === 'PASS' ? 0 : 1
  })

  process.exit(exitCode)
}

async function main(): Promise<void> {
  const emitTo = argValue('--emit')
  if (emitTo) return emit(emitTo)
  if (!process.argv.includes('--run')) {
    die('usage: --emit <dir> | --run [--mode rehearsal|repair] --from <dir> --out <dir>')
  }
  const from = argValue('--from')
  const out = argValue('--out')
  if (!from || !out) die('--run needs --from <bundle dir> and --out <result dir>')
  const mode = (argValue('--mode') ?? 'rehearsal') as 'rehearsal' | 'repair'
  if (mode !== 'rehearsal' && mode !== 'repair') die(`unknown mode ${mode}`)
  return run(from, out, mode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
