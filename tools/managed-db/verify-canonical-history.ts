/**
 * Does the canonical migration chain still produce schema.prisma?
 *
 * Once forward migrations exist, "the baseline matches the schema" is no longer
 * the invariant: schema.prisma is the baseline PLUS every migration after it.
 * Prisma answers this exactly, by replaying the chain into a shadow database and
 * diffing the result against the model. An empty diff means no drift.
 *
 * Needs a database, so it lives in the database-backed suite rather than the
 * unit suite. Loopback only: the shadow database is created and dropped by
 * Prisma itself inside the scratch database this creates.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { clientConfig, connect, isLoopback, parseDatabaseUrl } from '../migration-lineage/probe/connect'
import { assembleMigrationWorkspace } from './migration-workspace'
import { withScratchDatabase } from './scratch-database'

export interface CanonicalHistoryCheck {
  inSync: boolean
  /** The SQL Prisma would need to reconcile the chain with the model. */
  drift: string
  migrations: string[]
}

export async function verifyCanonicalHistory(root: string, adminUrl: string): Promise<CanonicalHistoryCheck> {
  const { target } = parseDatabaseUrl(adminUrl)
  if (!isLoopback(target.host)) throw new Error('the canonical history check runs against a loopback database only')

  const policy = { mode: 'loopback-plaintext' as const }
  const admin = await connect(clientConfig(target, policy))
  const workspace = assembleMigrationWorkspace(root)

  try {
    const out = await withScratchDatabase(admin, 'base', async name => {
      const shadowUrl = (() => {
        const u = new URL(adminUrl)
        u.pathname = `/${name}`
        return u.toString()
      })()

      const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js')
      const drift = execFileSync(
        process.execPath,
        [
          cli, 'migrate', 'diff',
          '--from-migrations', workspace.migrationsDir,
          '--to-schema-datamodel', workspace.schemaPath,
          '--shadow-database-url', shadowUrl,
          '--script',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
        },
      )
      return drift
    })

    if (out.error) throw new Error(out.error)
    if (!out.cleanup.dropped) throw new Error(`scratch database ${out.cleanup.name} was not dropped`)

    const drift = (out.value ?? '').trim()
    // Prisma prints a comment when there is nothing to do.
    const inSync = drift === '' || /^--\s*This is an empty migration\.?$/im.test(drift)
    return { inSync, drift, migrations: workspace.migrations }
  } finally {
    workspace.dispose()
    await admin.end().catch(() => {})
  }
}
