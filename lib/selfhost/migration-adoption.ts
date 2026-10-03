/**
 * BRINGING A DATABASE UNDER MIGRATION CONTROL, ONCE
 * ================================================
 *
 * Two kinds of self-host database exist, and they need different things:
 *
 *   born under migrations   `_prisma_migrations` is present. Upgrading is
 *                           `migrate deploy` and nothing else, for ever.
 *
 *   legacy, unbaselined     installed by `prisma db push`, which records no
 *                           history at all. It needs a ONE-TIME adoption: work
 *                           out which canonical migrations it already
 *                           satisfies, record those, then deploy the rest.
 *
 * After adoption the second kind becomes the first kind, permanently. This
 * module is never consulted again for that database.
 *
 * ── Prefix, not a set ───────────────────────────────────────────────────────
 *
 * Canonical migrations are ordered and cumulative, so a database satisfies a
 * PREFIX of them. Finding migration 3 satisfied while 2 is absent is not a
 * database that skipped one; it is a database nobody understands, and adopting
 * it would be guessing. That is refused.
 *
 * ── Refuse before mutating, always ──────────────────────────────────────────
 *
 * Every decision is made, and every refusal raised, before a single row is
 * written. An adoption that got halfway and stopped would leave exactly the
 * ambiguous state this exists to prevent.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { Client } from 'pg'

import {
  parsePostconditions,
  verifyMigration,
  type CatalogSnapshot,
  type MigrationVerdict,
} from './migration-postconditions'

export const CANONICAL_DIR = join('prisma', 'migrations-canonical')

/**
 * The oldest release whose database shape this adoption can prove.
 *
 * MEASURED, not assumed. An install older than this is refused before any
 * mutation, with the route it should take instead, because an adoption that
 * cannot prove what it is looking at must not proceed on optimism.
 *
 * The floor is expressed as the first canonical migration: a database that does
 * not satisfy the baseline is not a Backenly database this code recognises.
 */
export const SUPPORTED_FLOOR_MIGRATION = '00000000000000_baseline'

export interface MigrationPlan {
  /** Already recorded in `_prisma_migrations`. */
  alreadyTracked: boolean
  /** Migrations to record as applied without running them. */
  adopt: string[]
  /** Migrations `migrate deploy` will run. */
  deploy: string[]
  /** Set when the database must not be touched, and why. */
  refusal: string | null
}

/** Every canonical migration id, in order. */
export function canonicalMigrations(root: string): string[] {
  const dir = join(root, CANONICAL_DIR)
  if (!existsSync(dir)) throw new Error(`${CANONICAL_DIR} does not exist`)
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
}

function migrationSql(root: string, id: string): string {
  return readFileSync(join(root, CANONICAL_DIR, id, 'migration.sql'), 'utf8')
}

/**
 * Read the catalog once.
 *
 * One snapshot for every migration's verification, rather than a query per
 * object: the baseline alone declares 119 tables, 411 indexes and 110
 * constraints, and asking the catalog per object would turn adoption into
 * thousands of round trips.
 */
export async function snapshotCatalog(client: Client, schema = 'public'): Promise<CatalogSnapshot> {
  const tables = new Map<string, Set<string>>()

  const columns = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1`,
    [schema],
  )
  for (const row of columns.rows) {
    const key = row.table_name.toLowerCase()
    if (!tables.has(key)) tables.set(key, new Set())
    tables.get(key)!.add(row.column_name.toLowerCase())
  }

  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
    [schema],
  )

  const constraints = await client.query<{ conname: string }>(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1`,
    [schema],
  )

  const types = await client.query<{ typname: string }>(
    `SELECT t.typname
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'e'`,
    [schema],
  )

  return {
    tables,
    indexes: new Set(indexes.rows.map(r => r.indexname.toLowerCase())),
    constraints: new Set(constraints.rows.map(r => r.conname.toLowerCase())),
    types: new Set(types.rows.map(r => r.typname.toLowerCase())),
  }
}

/**
 * Migration ids Prisma has recorded as applied.
 *
 * Only the ones that FINISHED: a row with a null `finished_at` is a migration
 * that started and did not complete, and treating it as applied would be
 * adopting exactly the half-applied state this module refuses elsewhere.
 */
export async function appliedMigrations(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM public._prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  )
  return new Set(rows.map(r => r.migration_name))
}

/** Is this database already under migration control? */
export async function hasMigrationHistory(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
  )
  return rows[0]?.present === true
}

/** Is this database empty of Backenly's platform tables? */
export async function isEmptyDatabase(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.projects') IS NOT NULL AS present`,
  )
  return rows[0]?.present !== true
}

/**
 * What to tell an operator whose database is older, or stranger, than this
 * release can prove.
 *
 * Names the floor AND the route out. A refusal that only says no leaves an
 * operator with a deployment they cannot upgrade and no next step.
 */
function belowFloorRefusal(missingCount: number): string {
  return (
    'This database holds Backenly tables but does not satisfy ' +
    SUPPORTED_FLOOR_MIGRATION +
    (missingCount > 0 ? ` (${missingCount} expected object(s) absent)` : '') +
    ', so its shape is older than, or different from, the oldest release this ' +
    'upgrade can prove.\n\n' +
    'The minimum supported source release is the one that produced ' +
    SUPPORTED_FLOOR_MIGRATION +
    '.\n\n' +
    'Nothing has been changed. To move this deployment forward: take a deployment ' +
    'recovery bundle from it while it is still running, install this release into ' +
    'an EMPTY database, and restore the bundle into that.'
  )
}

function describeVerdict(id: string, verdict: MigrationVerdict): string {
  switch (verdict.state) {
    case 'partial':
      return (
        `${id} is only PARTLY present in this database, so it cannot be recorded as applied ` +
        `and cannot safely be re-run.\n\n` +
        `  present (${verdict.present.length}): ${verdict.present.slice(0, 8).join(', ')}` +
        `${verdict.present.length > 8 ? ', …' : ''}\n` +
        `  missing (${verdict.missing.length}): ${verdict.missing.slice(0, 12).join(', ')}` +
        `${verdict.missing.length > 12 ? ', …' : ''}\n\n` +
        `Nothing has been changed. Restore this deployment from a backup taken before the ` +
        `partial upgrade, or bring the listed objects into line by hand and run this again.`
      )
    case 'unverifiable':
      return (
        `${id} contains a statement this adoption cannot prove:\n\n` +
        verdict.statements.map(s => `  ${s}`).join('\n') +
        `\n\nAdoption refuses rather than assuming it ran. A migration with a statement ` +
        `outside the supported shapes needs a verifier written for it.`
      )
    default:
      return `${id}: ${verdict.state}`
  }
}

/**
 * Decide what to adopt and what to deploy, without touching anything.
 *
 * The returned plan is complete: a caller that acts on it performs no further
 * decisions, so there is no path where half a decision has been carried out.
 */
export async function planMigrations(root: string, client: Client): Promise<MigrationPlan> {
  const all = canonicalMigrations(root)

  if (await hasMigrationHistory(client)) {
    // Born under migrations, or adopted previously. Legacy logic must never run
    // again for this database.
    //
    // `deploy` lists what is actually PENDING rather than the whole chain. The
    // first version reported all four on an up-to-date database, so a no-op
    // rerun printed "deploying 4 migrations" and having nothing to do looked
    // identical to having done everything. A report that cannot distinguish
    // those is the kind this program keeps replacing.
    const applied = await appliedMigrations(client)
    return {
      alreadyTracked: true,
      adopt: [],
      deploy: all.filter(id => !applied.has(id)),
      refusal: null,
    }
  }

  if (await isEmptyDatabase(client)) {
    // Nothing to adopt: every migration runs, which is how a fresh install now
    // gets its history rather than being handed a manufactured one.
    return { alreadyTracked: false, adopt: [], deploy: all, refusal: null }
  }

  // A legacy install. Work out the prefix it satisfies.
  const catalog = await snapshotCatalog(client)
  const adopt: string[] = []
  let refusal: string | null = null

  for (const id of all) {
    const verdict = verifyMigration(parsePostconditions(migrationSql(root, id)), catalog)

    if (verdict.state === 'satisfied') {
      adopt.push(id)
      continue
    }

    // A BASELINE that is only partly present is not an interrupted upgrade. It
    // is a database whose shape this release cannot recognise at all - an
    // install older than the supported floor, or something that merely has
    // tables with the same names. Those need the floor message and its route,
    // not "restore the backup you took before the partial upgrade", which
    // describes an event that never happened.
    if (id === SUPPORTED_FLOOR_MIGRATION && verdict.state === 'partial') {
      refusal = belowFloorRefusal(verdict.missing.length)
      break
    }

    if (verdict.state === 'absent') {
      // The prefix ends here. Everything from this point is deployed, and any
      // LATER migration that looks present is a contradiction rather than a
      // bonus — checked below.
      break
    }

    refusal = describeVerdict(id, verdict)
    break
  }

  if (!refusal && adopt.length === 0) {
    refusal = belowFloorRefusal(0)
  }

  const deploy = all.slice(adopt.length)

  // A migration AFTER the end of the prefix that already looks satisfied means
  // the database is not a clean prefix of the canonical history. Adopting it
  // would be recording a story nobody can vouch for.
  if (!refusal) {
    for (const id of deploy) {
      const verdict = verifyMigration(parsePostconditions(migrationSql(root, id)), catalog)
      if (verdict.state === 'satisfied' || verdict.state === 'partial') {
        refusal =
          `This database satisfies ${adopt.length} canonical migration(s) in order, then ` +
          `appears to contain objects from ${id}, which is out of sequence.\n\n` +
          `A database that is not a clean prefix of the canonical history cannot be adopted ` +
          `safely. Nothing has been changed.`
        break
      }
    }
  }

  return { alreadyTracked: false, adopt, deploy, refusal }
}
