/**
 * LAYER 3 REHEARSAL — baseline an existing database, then move it forward.
 *
 *   LINEAGE_LOCAL_DATABASE_URL=postgresql://user:pass@localhost:5432/db \
 *     npx tsx tools/managed-db/rehearse-baseline.ts [--out file.json]
 *
 * Reproduces staging's exact shape — the canonical schema present, no migration
 * history — and then does what we intend to do there:
 *
 *   phase 1  mark the baseline applied, and prove it changed NOTHING
 *   phase 2  deploy the migrations after it, and prove they changed exactly
 *            what they claim, twice being a no-op
 *
 * The property in phase 1 is not "_prisma_migrations has rows". It is that
 * establishing history on an already-correct database causes zero semantic
 * change, measured with the same catalog diff the lineage investigation used.
 * The ledger's own tables are reported separately rather than counted as drift
 * or quietly ignored.
 *
 * Loopback only; everything happens in a scratch database dropped in `finally`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffSnapshots, type Difference } from '../migration-lineage/diff'
import { captureSnapshot } from '../migration-lineage/probe/capture'
import { clientConfig, connect, isLoopback, parseDatabaseUrl, type PgClient } from '../migration-lineage/probe/connect'
import { platformSchemas } from '../migration-lineage/probe/inventory'
import { BASELINE_ID, BASELINE_SQL_PATH } from './generate-baseline'
import { assembleMigrationWorkspace } from './migration-workspace'
import { listScratchDatabases, withScratchDatabase } from './scratch-database'

// Used only when the canonical chain has nothing after the baseline, so the
// forward half proves a working migration system rather than being skipped.
const FIXTURE_ID = '29990101000000_rehearsal_fixture'
const FIXTURE_SQL =
  'CREATE TABLE "_baseline_rehearsal_fixture" ("id" TEXT NOT NULL, CONSTRAINT "_baseline_rehearsal_fixture_pkey" PRIMARY KEY ("id"));\n'

const LEDGER = /_prisma_migrations/

export interface PrismaRun {
  command: string
  exitCode: number
  stdout: string
}

export interface BaselineRehearsalResult {
  rehearsal: 'layer3-baseline'
  version: 2
  startedAt: string
  finishedAt: string
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
  failures: string[]
  database: string | null
  forwardMigrations: string[]
  runs: PrismaRun[]
  historyRows: Array<{ migration_name: string; applied_steps_count: number; finished: boolean }>
  /** Canonical-schema change caused by baselining. Must be empty. */
  baseliningDelta: Difference[]
  /** Objects the migration ledger itself introduced. Reported, not hidden. */
  ledgerObjects: string[]
  /**
   * Whether those objects are exactly the ones the lineage manifest claims the
   * runner creates. The manifest says its values were replayed; this is the
   * replay, so a drifting Prisma CLI surfaces here instead of being absorbed as
   * an explained difference on every future capture.
   */
  ledgerMatchesManifest: string[] | null
  /** What deploying the forward migrations actually added. */
  forwardDelta: Difference[]
  forwardSecondDeployNoOp: boolean | null
  scratchDatabasesAfter: string[] | null
  error: string | null
}

function prisma(root: string, schemaPath: string, url: string, args: string[]): PrismaRun {
  const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args, '--schema', schemaPath], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    })
    return { command: `prisma ${args.join(' ')}`, exitCode: 0, stdout: stdout.trim() }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string }
    return {
      command: `prisma ${args.join(' ')}`,
      exitCode: e.status ?? 1,
      stdout: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`.trim(),
    }
  }
}

const NO_PENDING = /No pending migrations|Database schema is up to date/i

export const LEDGER_MANIFEST = join(
  'tools', 'migration-lineage', 'manifests', 'provisioning-prisma-migration-ledger.json',
)

/**
 * The manifest that lets a lineage capture explain `_prisma_migrations` must
 * describe what the runner actually creates, object for object. Names only: the
 * field values are gated by the lineage report's own attribution.
 */
function compareLedgerToManifest(root: string, created: string[]): string[] {
  const manifest = JSON.parse(readFileSync(join(root, LEDGER_MANIFEST), 'utf8')) as { entries: Array<{ key: string }> }
  const claimed = new Set(manifest.entries.map(e => e.key))
  const problems: string[] = []
  for (const key of created) if (!claimed.has(key)) problems.push(`${key} was created but no entry claims it`)
  for (const key of claimed) if (!created.includes(key)) problems.push(`${key} is claimed but was not created`)
  return problems
}

export async function rehearseBaseline(root: string, adminUrl: string): Promise<BaselineRehearsalResult> {
  const r: BaselineRehearsalResult = {
    rehearsal: 'layer3-baseline',
    version: 2,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    verdict: 'INCONCLUSIVE',
    failures: [],
    database: null,
    forwardMigrations: [],
    runs: [],
    historyRows: [],
    baseliningDelta: [],
    ledgerObjects: [],
    ledgerMatchesManifest: null,
    forwardDelta: [],
    forwardSecondDeployNoOp: null,
    error: null,
    scratchDatabasesAfter: null,
  }

  const { target } = parseDatabaseUrl(adminUrl)
  if (!isLoopback(target.host)) throw new Error('the baseline rehearsal runs against a loopback database only')
  const policy = { mode: 'loopback-plaintext' as const }
  const admin = await connect(clientConfig(target, policy))

  const full = assembleMigrationWorkspace(root)
  const canonicalForward = full.migrations.filter(id => id !== BASELINE_ID)
  r.forwardMigrations = canonicalForward.length > 0 ? canonicalForward : [FIXTURE_ID]

  // Phase 1 sees only the baseline, which is the state staging was in.
  const baselineOnly = assembleMigrationWorkspace(root, [], { only: [BASELINE_ID] })
  const forwardWorkspace =
    canonicalForward.length > 0 ? full : assembleMigrationWorkspace(root, [{ id: FIXTURE_ID, sql: FIXTURE_SQL }])

  try {
    const out = await withScratchDatabase(admin, 'base', async name => {
      r.database = name
      const url = (() => {
        const u = new URL(adminUrl)
        u.pathname = `/${name}`
        return u.toString()
      })()

      const client: PgClient = await connect(clientConfig(target, policy, { database: name }))
      try {
        // Staging's shape: canonical schema present, no migration history.
        await client.query(readFileSync(join(root, BASELINE_SQL_PATH), 'utf8'))
        const before = await captureSnapshot(client, await platformSchemas(client))

        // ── phase 1: baseline an existing database ───────────────────────────
        r.runs.push(prisma(root, baselineOnly.schemaPath, url, ['migrate', 'resolve', '--applied', BASELINE_ID]))
        const afterResolve = await captureSnapshot(client, await platformSchemas(client))
        const introduced = diffSnapshots(before, afterResolve)
        r.baseliningDelta = introduced.filter(d => !LEDGER.test(d.key))
        r.ledgerObjects = introduced.filter(d => LEDGER.test(d.key)).map(d => d.key)

        r.runs.push(prisma(root, baselineOnly.schemaPath, url, ['migrate', 'status']))
        r.runs.push(prisma(root, baselineOnly.schemaPath, url, ['migrate', 'deploy']))
        r.runs.push(prisma(root, baselineOnly.schemaPath, url, ['migrate', 'deploy']))

        // ── phase 2: move forward ────────────────────────────────────────────
        const forwardDeploy = prisma(root, forwardWorkspace.schemaPath, url, ['migrate', 'deploy'])
        r.runs.push(forwardDeploy)
        const afterForward = await captureSnapshot(client, await platformSchemas(client))
        r.forwardDelta = diffSnapshots(afterResolve, afterForward).filter(d => !LEDGER.test(d.key))

        const secondForward = prisma(root, forwardWorkspace.schemaPath, url, ['migrate', 'deploy'])
        r.runs.push(secondForward)
        r.forwardSecondDeployNoOp = secondForward.exitCode === 0 && NO_PENDING.test(secondForward.stdout)

        const history = await client.query(
          'SELECT migration_name, applied_steps_count, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name',
        )
        r.historyRows = history.rows as BaselineRehearsalResult['historyRows']
      } finally {
        await client.end().catch(() => {})
      }
    })

    if (out.error) r.failures.push(`rehearsal did not complete: ${out.error}`)
    if (out.cleanup.created && !out.cleanup.dropped) {
      r.failures.push(`scratch database ${out.cleanup.name} was not dropped: ${out.cleanup.error}`)
    }
    r.scratchDatabasesAfter = await listScratchDatabases(admin)
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err)
    r.failures.push(`rehearsal error: ${r.error}`)
  } finally {
    full.dispose()
    baselineOnly.dispose()
    if (forwardWorkspace !== full) forwardWorkspace.dispose()
    await admin.end().catch(() => {})
  }

  const [resolve, status, deploy, deployAgain, forwardDeploy] = r.runs
  if (resolve?.exitCode !== 0) r.failures.push(`migrate resolve failed: ${resolve?.stdout}`)
  if (status?.exitCode !== 0) r.failures.push(`migrate status was not clean after baselining: ${status?.stdout}`)
  if (deploy?.exitCode !== 0 || !NO_PENDING.test(deploy?.stdout ?? '')) {
    r.failures.push(`migrate deploy after baselining was not a no-op: ${deploy?.stdout}`)
  }
  if (deployAgain?.exitCode !== 0 || !NO_PENDING.test(deployAgain?.stdout ?? '')) {
    r.failures.push(`the second migrate deploy was not a no-op: ${deployAgain?.stdout}`)
  }
  if (r.baseliningDelta.length > 0) {
    r.failures.push(`baselining changed ${r.baseliningDelta.length} canonical object(s); it must change none`)
  }
  if (r.ledgerObjects.length === 0) {
    r.failures.push('no migration ledger was introduced; the baseline did not take effect')
  } else {
    r.ledgerMatchesManifest = compareLedgerToManifest(root, r.ledgerObjects)
    for (const problem of r.ledgerMatchesManifest) r.failures.push(`migration ledger manifest: ${problem}`)
  }
  if (!r.historyRows.some(h => h.migration_name === BASELINE_ID && h.finished)) {
    r.failures.push('the baseline is not recorded as applied in _prisma_migrations')
  }
  if (forwardDeploy?.exitCode !== 0) r.failures.push(`the forward deploy failed: ${forwardDeploy?.stdout}`)
  if (r.forwardDelta.length === 0) r.failures.push('the forward migration added nothing')
  if (r.forwardSecondDeployNoOp !== true) r.failures.push('a repeated forward deploy was not a no-op')
  for (const id of r.forwardMigrations) {
    if (!r.historyRows.some(h => h.migration_name === id && h.finished)) {
      r.failures.push(`${id} is not recorded as applied`)
    }
  }
  if (r.scratchDatabasesAfter?.length) {
    r.failures.push(`scratch databases still exist: ${r.scratchDatabasesAfter.join(', ')}`)
  }

  r.finishedAt = new Date().toISOString()
  r.verdict = r.failures.length ? 'FAIL' : 'PASS'
  return r
}

async function main(): Promise<void> {
  const url = process.env.LINEAGE_LOCAL_DATABASE_URL
  if (!url) {
    console.error('LINEAGE_LOCAL_DATABASE_URL is not set')
    process.exit(2)
  }
  const result = await rehearseBaseline(process.cwd(), url)

  console.log(`\n  layer 3 baseline rehearsal: ${result.verdict}  (scratch ${result.database})`)
  for (const f of result.failures) console.log(`    FAIL  ${f}`)
  for (const run of result.runs) {
    console.log(`    ${String(run.exitCode).padEnd(2)} ${run.command.padEnd(36)} ${run.stdout.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`)
  }
  console.log(`    forward migrations   ${JSON.stringify(result.forwardMigrations)}`)
  console.log(`    baselining delta     ${result.baseliningDelta.length} (canonical schema)`)
  const manifest = result.ledgerMatchesManifest
  console.log(
    `    ledger objects       ${result.ledgerObjects.length}` +
      (manifest === null ? '' : manifest.length === 0 ? ' (all claimed by the lineage manifest)' : ` (${manifest.length} manifest problem(s))`),
  )
  console.log(`    forward delta        ${result.forwardDelta.length}: ${result.forwardDelta.slice(0, 6).map(d => d.key).join(', ')}`)
  console.log(`    second forward no-op ${result.forwardSecondDeployNoOp}`)
  console.log(`    history              ${result.historyRows.map(h => h.migration_name).join(', ')}`)
  console.log(`    leftovers            ${JSON.stringify(result.scratchDatabasesAfter)}`)

  const i = process.argv.indexOf('--out')
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1], JSON.stringify(result, null, 2))
  process.exitCode = result.verdict === 'PASS' ? 0 : 1
}

if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1 })
