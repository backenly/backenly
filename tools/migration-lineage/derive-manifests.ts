/**
 * Derive provisioning manifests by replaying the repository's own provisioning
 * SQL and capturing what each file actually creates.
 *
 *   PG_BINDIR=/path/to/postgres/bin \
 *     npx tsx tools/migration-lineage/derive-manifests.ts --out tools/migration-lineage/manifests
 *
 * ── Why derive rather than write them ───────────────────────────────────────
 *
 * A manifest entry has to say what a source produces, in the same terms the
 * capture reads. Reading SQL and typing expectations by hand is how a manifest
 * ends up attributing by name, which is the one thing attribution must not do.
 * Here each entry is the captured definition of an object that appeared while
 * that file, and only that file, was being applied.
 *
 * ── Why a throwaway cluster ─────────────────────────────────────────────────
 *
 * The provisioning SQL creates and alters ROLES, which are cluster-wide. Running
 * it against staging, or against a developer's cluster, would change state
 * outside any scratch database. So this starts its own cluster on a spare port,
 * uses it, and deletes it, data directory included.
 *
 * ── Order ───────────────────────────────────────────────────────────────────
 *
 * scripts/postgrest-install.sh is the only authority on the order the PostgREST
 * files are applied in, and applying them the other way round bricks a database.
 * The order is read out of that script rather than restated here.
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Manifest, ManifestEntry } from './attribute'
import { assertRepoRoot, buildPushInput } from './build-inputs'
import { diffSnapshots, KINDS } from './diff'
import { captureSnapshot, type Snapshot } from './probe/capture'
import { clientConfig, connect, parseDatabaseUrl, type PgClient } from './probe/connect'
import { platformSchemas } from './probe/inventory'
import { replayFiles, withScratchDatabase } from './probe/scratch'

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** The PostgREST files, in the order postgrest-install.sh applies them. */
export function provisioningOrder(root: string): string[] {
  const script = readFileSync(join(root, 'scripts', 'postgrest-install.sh'), 'utf8')
  const loop = script.match(/for f in ([^;]+); do/)
  if (!loop) throw new Error('could not read the install order from scripts/postgrest-install.sh')
  const files = loop[1].trim().split(/\s+/).map(f => `scripts/sql/${f}`)
  for (const f of files) if (!existsSync(join(root, f))) throw new Error(`install order names a missing file: ${f}`)
  // Documented alongside it: the direct-access install is applied after.
  const direct = 'scripts/setup-direct-access.sql'
  if (!existsSync(join(root, direct))) throw new Error(`missing ${direct}`)
  return [...files, direct]
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

interface Cluster {
  url: string
  stop: () => void
}

async function startThrowawayCluster(binDir: string): Promise<Cluster> {
  const initdb = join(binDir, 'initdb')
  const pgCtl = join(binDir, 'pg_ctl')
  const base = mkdtempSync(join(tmpdir(), 'lineage-derive-'))
  const data = join(base, 'data')
  const log = join(base, 'server.log')
  const port = await freePort()

  console.log(`  cluster   ${data} on port ${port}`)
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--no-sync'], { stdio: 'pipe' })

  // `pg_ctl start` is deliberately NOT used. It hands the server the pipe it was
  // given and does not return under this toolchain, so a synchronous call waits
  // for a server that is already running. Spawning the postmaster with its
  // output on a file, then polling for readiness, is the same thing without the
  // trap.
  const logFd = openSync(log, 'a')
  const server = spawn(join(binDir, 'postgres'), ['-D', data, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'], {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  server.unref()

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`
  const { target } = parseDatabaseUrl(url)
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const probe = await connect(clientConfig(target, { mode: 'loopback-plaintext' }))
      await probe.end()
      break
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`throwaway cluster did not accept connections: ${err instanceof Error ? err.message : err}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  console.log('  cluster   accepting connections')

  return {
    url,
    stop: () => {
      try {
        execFileSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' })
      } catch (err) {
        console.error(`  WARNING: could not stop the throwaway cluster: ${err instanceof Error ? err.message : err}`)
        server.kill('SIGKILL')
      }
      closeSync(logFd)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(base, { recursive: true, force: true })
          break
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
        }
      }
      if (existsSync(base)) console.error(`  WARNING: throwaway cluster directory remains at ${base}`)
      else console.log('  cluster   removed')
    },
  }
}

/**
 * Manifest entries for everything a file created OR changed.
 *
 * `differs` matters as much as `extra`: these files use CREATE OR REPLACE, and
 * two of them define the same function. Recording only what appeared would leave
 * the first file's stale definition as the expectation, so the object would fail
 * to match the live database and be reported unexplained. The file that last
 * changed an object owns the expectation for it.
 */
function entriesFor(before: Snapshot, after: Snapshot): ManifestEntry[] {
  const fieldsByKind = new Map(KINDS.map(k => [k.kind, k.fields]))
  return diffSnapshots(before, after)
    .filter(d => d.status === 'extra_in_right' || d.status === 'differs')
    .map(d => {
      const row = d.right ?? {}
      const fields = fieldsByKind.get(d.kind) ?? []
      const expect: Record<string, unknown> = {}
      for (const f of fields) expect[f] = row[f] ?? null
      // A schema is compared by presence, so its identity is the expectation.
      if (Object.keys(expect).length === 0) expect.name = row.name ?? null
      return { key: d.key, expect }
    })
}

async function main(): Promise<void> {
  const root = process.cwd()
  assertRepoRoot(root)
  const out = arg('--out') ?? 'tools/migration-lineage/manifests'
  const binDir = process.env.PG_BINDIR
  if (!binDir || !existsSync(binDir)) {
    console.error('PG_BINDIR must point at a PostgreSQL bin directory (initdb, pg_ctl)')
    process.exit(2)
  }

  const order = provisioningOrder(root)
  console.log('\nDeriving provisioning manifests\n')
  console.log(`  order     ${order.join(' -> ')}`)

  const cluster = await startThrowawayCluster(binDir)
  let failed = false
  try {
    const { target } = parseDatabaseUrl(cluster.url)
    const policy = { mode: 'loopback-plaintext' as const }
    const admin = await connect(clientConfig(target, policy))
    const version = (await admin.query('SELECT version() AS v')).rows[0].v

    const outcome = await withScratchDatabase(admin, 'push', async name => {
      const client: PgClient = await connect(clientConfig(target, policy, { database: name }))
      try {
        // The current model first, so provisioning runs against the schema it
        // expects rather than an empty database.
        const projection = buildPushInput(root)
        const seeded = await replayFiles(client, projection.files)
        if (seeded.status !== 'complete') throw new Error(`projection did not replay: ${seeded.steps.find(s => !s.ok)?.error?.message}`)

        let before = await captureSnapshot(client, await platformSchemas(client))
        const manifests: Manifest[] = []
        for (const file of order) {
          const sql = readFileSync(join(root, file), 'utf8')
          const replay = await replayFiles(client, [{ name: file, sql }])
          if (replay.status !== 'complete') {
            const err = replay.steps[0]?.error
            console.error(`  NOT DERIVED  ${file}: ${err?.code} ${err?.message}`)
            failed = true
            continue
          }
          const after = await captureSnapshot(client, await platformSchemas(client))
          const entries = entriesFor(before, after)
          before = after
          console.log(`  ${String(entries.length).padStart(3)} objects  ${file}`)
          manifests.push({
            id: `provisioning/${file.split('/').pop()}`,
            bucket: 'known_provisioning_effect',
            source: file,
            derivation: 'replayed',
            confidence: 'derived',
            notes:
              `Observed by replaying ${file} into a throwaway cluster (${version}) on top of the ` +
              'schema.prisma projection, in the order scripts/postgrest-install.sh applies. ' +
              'Roles, grants and default privileges are cluster or database state rather than schema ' +
              'objects, and are reported in the provisioning inventory instead of here.',
            entries,
          })
        }
        return manifests
      } finally {
        await client.end().catch(() => {})
      }
    })
    await admin.end().catch(() => {})

    if (outcome.error) throw new Error(outcome.error)
    if (!outcome.cleanup.dropped) throw new Error(`scratch database ${outcome.cleanup.name} was not dropped`)

    for (const manifest of outcome.value ?? []) {
      const path = join(out, `${manifest.id.replace('/', '-').replace(/\.sql$/, '')}.json`)
      writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
      console.log(`  wrote     ${path}`)
    }
  } finally {
    cluster.stop()
  }
  process.exitCode = failed ? 1 : 0
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
