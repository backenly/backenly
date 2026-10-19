/**
 * Install the change ledger's guard triggers in a test database.
 *
 * `prisma db push` builds test databases from the schema and knows nothing of
 * triggers, so a suite that relies on the guard (status edges, write-once
 * evidence, append-only events) installs exactly what the migration installs:
 * the section between its BEGIN and END markers, read from the file itself so
 * the test cannot drift from what ships.
 *
 * Multi-statement, so it goes over a plain pg client (Prisma prepares one
 * statement at a time). Serialised by an advisory lock, because suites run in
 * parallel and two concurrent CREATE OR REPLACE FUNCTION on one function fail.
 */

import fs from 'fs'
import path from 'path'
import { Client } from 'pg'

const MIGRATION = 'prisma/migrations-canonical/20261018120000_backend_change_ledger/migration.sql'

export function changeLedgerGuardSql(): string {
  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), 'utf8')
  const start = sql.indexOf('-- BEGIN backend change guard')
  const end = sql.indexOf('-- END backend change guard')
  if (start < 0 || end < 0) throw new Error(`${MIGRATION} has no backend change guard section`)
  return sql.slice(start, end)
}

export async function installChangeLedgerGuard(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('backenly-test:change-ledger-guard'))`)
    try {
      await client.query(changeLedgerGuardSql())
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('backenly-test:change-ledger-guard'))`)
    }
  } finally {
    await client.end()
  }
}
