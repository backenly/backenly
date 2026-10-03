/**
 * Scratch databases: create one, use it, drop it, prove it is gone.
 *
 * Extracted from the lineage probe so the Layer 2 extension provisioner can
 * rehearse inside a throwaway database without importing the SQL replay path
 * that lives beside it. This module creates and drops databases and does
 * nothing else; `replayFiles` deliberately stayed behind.
 *
 * Every guard is checked against what the server reports, never against the name
 * the caller asked for.
 */

import { randomBytes } from 'node:crypto'
import type { PgClient } from '../migration-lineage/probe/connect'

export type ScratchPurpose = 'chain' | 'push' | 'rlsctl' | 'ext' | 'base'

export const SCRATCH_NAME = /^backenly_lineage_(chain|push|rlsctl|ext|base)_[0-9a-f]{8}$/
const RESERVED = new Set(['backenly', 'postgres', 'rdsadmin', 'template0', 'template1'])

export function scratchName(purpose: ScratchPurpose, suffix = randomBytes(4).toString('hex')): string {
  const name = `backenly_lineage_${purpose}_${suffix}`
  assertScratchName(name)
  return name
}

export function assertScratchName(name: string): void {
  if (!SCRATCH_NAME.test(name) || RESERVED.has(name)) {
    throw new Error(`refusing to treat ${JSON.stringify(name)} as a scratch database`)
  }
}

export interface ScratchCleanup {
  name: string
  created: boolean
  dropped: boolean
  error: string | null
}

/**
 * Create a scratch database, run `body` against its name, and drop it whatever
 * happened. The cleanup outcome is returned rather than logged, so a caller
 * cannot report success while a database it created still exists.
 */
export async function withScratchDatabase<T>(
  admin: PgClient,
  purpose: ScratchPurpose,
  body: (name: string) => Promise<T>,
): Promise<{ value: T | null; error: string | null; cleanup: ScratchCleanup }> {
  const name = scratchName(purpose)
  const cleanup: ScratchCleanup = { name, created: false, dropped: false, error: null }

  const [{ current }] = (await admin.query('SELECT current_database() AS current')).rows
  if (current === name) throw new Error('refusing: scratch name equals the connected database')
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  if (exists.rowCount) throw new Error(`refusing: database ${name} already exists`)

  // Identifiers cannot be bound as parameters. `name` has passed SCRATCH_NAME,
  // which admits only [a-z0-9_], so quoting it is sufficient.
  await admin.query(`CREATE DATABASE "${name}"`)
  cleanup.created = true

  let value: T | null = null
  let error: string | null = null
  try {
    value = await body(name)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      const still = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
      cleanup.dropped = still.rowCount === 0
      if (!cleanup.dropped) cleanup.error = 'database still present after DROP'
    } catch (err) {
      cleanup.error = err instanceof Error ? err.message : String(err)
    }
  }
  return { value, error, cleanup }
}

/** Every lineage scratch database on the instance, from this run or any other. */
export async function listScratchDatabases(admin: PgClient): Promise<string[]> {
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'backenly\\_lineage\\_%' ORDER BY 1",
  )
  return rows.map(r => r.datname as string)
}
