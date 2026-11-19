/**
 * Any Postgres reachable from the internet → a new Backenly project: the named
 * schemas' tables and rows (public by default). A read-only database user is
 * enough: Backenly reads inside a READ ONLY transaction and never writes.
 *
 * The same engine as Supabase (lib/import/drivers/pg-common.ts), without Auth
 * and Storage, which a plain Postgres does not have. Its row-level-security
 * policies are translated and held for approval when they use shapes
 * Backenly understands; most plain Postgres apps use none, and their tables
 * answer only the server key, as the app's own server did.
 */

import type { ImportConnection, ImportPreview } from '../contract'
import type { DriverContext, ImportDriver, RunContext } from '../driver'
import { readSnapshot } from '../net'
import { secretsOf } from '../redact'
import { analyze, checkPg, openSource, previewOf, runPg, sourceLabelOf } from './pg-common'

type PostgresConnection = Extract<ImportConnection, { source: 'postgres' }>

function schemasOf(connection: PostgresConnection): string[] {
  const list = (connection.schemas ?? []).map((s) => s.trim()).filter(Boolean)
  return list.length ? [...new Set(list)] : ['public']
}

const NOT_MOVED = 'Roles, grants and extensions stay in the source; Backenly sets up its own access for every table.'

export const postgresDriver: ImportDriver<'postgres'> = {
  source: 'postgres',

  async check(connection, ctx) {
    await checkPg(connection.connectionString, { secrets: secretsOf(connection), schemas: schemasOf(connection), ctx })
  },

  async inspect(connection, ctx: DriverContext): Promise<ImportPreview> {
    const secrets = secretsOf(connection)
    const schemas = schemasOf(connection)
    // The preview's deadline ends the connection, and the statement in flight.
    const { conn, parsed } = await openSource(connection.connectionString, secrets, ctx.signal)
    try {
      const { analysis, label } = await readSnapshot(conn, async (db) => ({
        analysis: await analyze(db, { source: 'postgres', schemas, usersMoving: false, withAuth: false, countAll: false, signal: ctx.signal }),
        label: await sourceLabelOf(db, parsed, 'postgres'),
      }))
      return previewOf(analysis, { source: 'postgres', sourceLabel: label, buckets: null, warnings: [NOT_MOVED], ctx, user: parsed.user })
    } finally {
      await conn.end()
    }
  },

  async run(connection, ctx: RunContext) {
    const result = await runPg({
      source: 'postgres',
      label: 'Postgres',
      connectionString: connection.connectionString,
      schemas: schemasOf(connection),
      secrets: secretsOf(connection),
      users: false,
      storage: null,
      buckets: null,
      ctx,
    })
    result.warnings.push(NOT_MOVED)
    return result
  },
}
