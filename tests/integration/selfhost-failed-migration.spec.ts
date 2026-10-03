/**
 * WHAT HAPPENS WHEN A MIGRATION FAILS HALFWAY
 * ===========================================
 *
 * The upgrade suite proves migrations work. This proves what happens when one
 * does not, which is the case an operator actually meets at 3am and the one
 * where a wrong answer is unrecoverable.
 *
 * Four properties, and the first is the one everything else rests on: a failed
 * upgrade must NOT look like a successful one. A deployment that reports
 * "schema current" while a migration died halfway is worse than one that
 * refuses to start, because the next release will be applied on top of a schema
 * nobody can describe.
 *
 * ── The defect this found ───────────────────────────────────────────────────
 *
 * The failure was honest but ILLEGIBLE. `execFileSync` throws an Error whose
 * message is only
 *
 *   Command failed: <node> <prisma cli> migrate deploy --schema <temp path>
 *
 * and the wrapper re-threw exactly that. Prisma had already printed the P3018
 * code, WHICH migration failed, the PostgreSQL error underneath it and a link
 * explaining how to recover — all on stderr, all discarded. The operator got
 * the command line that produced the failure and nothing about the failure.
 *
 * That is the third time in this programme a diagnostic has hidden its own
 * cause, so it is fixed at the boundary where the output is lost rather than
 * papered over at the call site.
 *
 * ── Rehearsal migrations are disposable ─────────────────────────────────────
 *
 * `assembleMigrationWorkspace(root, extra)` already takes migrations that exist
 * only for a run, so the failing one never enters the repository and cannot be
 * shipped to anybody. The canonical chain is untouched.
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import crypto from 'crypto'
import { Client } from 'pg'

import {
  runSelfHostMigrations,
  MigrationFailed,
  checkSupportObjects,
  SUPPORT_OBJECTS,
} from '@/lib/selfhost/run-migrations'
import { appliedMigrations } from '@/lib/selfhost/migration-adoption'
import { assembleMigrationWorkspace } from '@/tools/managed-db/migration-workspace'

const ROOT = process.cwd()
const DB_NAME = `backenly_failmig_${crypto.randomBytes(4).toString('hex')}`

let adminUrl: string
let dbUrl: string
let db: Client

/** A migration that does real work and then fails, inside one transaction. */
const REHEARSAL_ID = '29990101000000_rehearsal_failure'
const FAILING_SQL = `
CREATE TABLE public.rehearsal_marker (id serial PRIMARY KEY, label text NOT NULL);
INSERT INTO public.rehearsal_marker (label) VALUES ('written-before-the-failure');
-- Fails: the column does not exist. PostgreSQL rolls the whole migration back,
-- which is the case worth proving first because it is the RECOVERABLE one.
ALTER TABLE public.rehearsal_marker ADD CONSTRAINT bad CHECK (nonexistent_column > 0);
`

/** The same migration, repaired. A controlled retry must be able to apply it. */
const FIXED_SQL = `
CREATE TABLE public.rehearsal_marker (id serial PRIMARY KEY, label text NOT NULL);
INSERT INTO public.rehearsal_marker (label) VALUES ('written-by-the-retry');
ALTER TABLE public.rehearsal_marker ADD CONSTRAINT positive_id CHECK (id > 0);
`

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url })
  c.on('error', () => {})
  await c.connect()
  return c
}

/** Run the Prisma CLI the way the product does. Used only for the repair step. */
function prismaCli(args: string[], schemaPath: string): string {
  const cli = require.resolve('prisma/build/index.js')
  return execFileSync(process.execPath, [cli, ...args, '--schema', schemaPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
  })
}

/** What the database looks like, for comparing "unchanged" honestly. */
async function schemaFingerprint(client: Client): Promise<string> {
  const rows = await client.query<{ sig: string }>(
    `SELECT string_agg(sig, '|' ORDER BY sig) AS sig FROM (
       SELECT table_schema || '.' || table_name || ':' || column_name || ':' || data_type AS sig
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ) s`,
  )
  return rows.rows[0]?.sig ?? ''
}

async function historyRow(client: Client, id: string) {
  const rows = await client.query<{
    finished_at: Date | null
    rolled_back_at: Date | null
    applied_steps_count: number
    logs: string | null
  }>(
    // NEWEST first. `migrate resolve --rolled-back` keeps the failed row and
    // stamps rolled_back_at on it; a later deploy inserts a SECOND row for the
    // same migration_name. Without the ordering this returned the old failed
    // row and the retry looked as though it had never finished.
    `SELECT finished_at, rolled_back_at, applied_steps_count, logs
       FROM _prisma_migrations WHERE migration_name = $1
      ORDER BY started_at DESC LIMIT 1`,
    [id],
  )
  return rows.rows[0] ?? null
}

beforeAll(async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!)
  const admin = new URL(base.toString())
  admin.pathname = '/postgres'
  adminUrl = admin.toString()
  const target = new URL(base.toString())
  target.pathname = `/${DB_NAME}`
  dbUrl = target.toString()

  const a = await connect(adminUrl)
  await a.query(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await a.query(`CREATE DATABASE ${DB_NAME}`)
  await a.end()

  db = await connect(dbUrl)

  // A healthy, migration-controlled deployment: the same state a fresh install
  // is in. Everything below is measured against this.
  await runSelfHostMigrations({
    root: ROOT,
    client: db,
    databaseUrl: dbUrl,
    assemble: root => assembleMigrationWorkspace(root),
  })

  // The support objects, installed the way the installer installs them: the
  // same SQL file scripts/postgrest-install.sh applies.
  //
  // They are NOT created by migrations, and `checkSupportObjects` treats their
  // absence as a failure only on a database that had them before. So a fixture
  // without them would make case D vacuous - "nothing was lost" is trivially
  // true when there was nothing to lose. The first run of this suite did
  // exactly that and reported six missing objects.
  //
  // BOTH files, in the installer's order. The registry file alone leaves the
  // three event triggers absent, which is what the first run reported: the DDL
  // sync file is what creates them, and hand-ordering these two is documented
  // as capable of bricking the database.
  for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
    await db.query(readFileSync(join(ROOT, 'scripts', 'sql', file), 'utf8'))
  }
}, 900_000)

afterAll(async () => {
  await db?.end().catch(() => {})
  const a = await connect(adminUrl).catch(() => null)
  if (a) {
    await a.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
    await a.end().catch(() => {})
  }
}, 300_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('the deployment is healthy before anything is broken', () => {
  it('is migration-controlled, with a marker row and the support objects', async () => {
    const applied = await appliedMigrations(db)
    expect(applied.size).toBeGreaterThan(0)

    // A row of the operator's own, so "the data survived" is a claim about
    // something that was actually there.
    await db.query(
      `CREATE TABLE IF NOT EXISTS public.operator_marker (id serial PRIMARY KEY, label text)`,
    )
    await db.query(`INSERT INTO public.operator_marker (label) VALUES ('before-the-failure')`)
    const rows = await db.query(`SELECT label FROM public.operator_marker`)
    expect(rows.rows[0].label).toBe('before-the-failure')

    const support = await checkSupportObjects(db)
    expect(support.length).toBe(SUPPORT_OBJECTS.length)
    expect(support.every(o => o.present)).toBe(true)
  }, 300_000)
})

describe('A — a forward migration that fails after doing work', () => {
  let before: { applied: number; fingerprint: string }

  it('fails LOUDLY, naming the migration and the database error', async () => {
    before = {
      applied: (await appliedMigrations(db)).size,
      fingerprint: await schemaFingerprint(db),
    }

    let caught: unknown = null
    try {
      await runSelfHostMigrations({
        root: ROOT,
        client: db,
        databaseUrl: dbUrl,
        assemble: root =>
          assembleMigrationWorkspace(root, [{ id: REHEARSAL_ID, sql: FAILING_SQL }]),
      })
    } catch (err) {
      caught = err
    }

    // It must not report success. That is the whole gate.
    expect(caught).toBeTruthy()
    expect(caught).toBeInstanceOf(MigrationFailed)

    const failure = caught as MigrationFailed
    // The defect: the message used to be "Command failed: <node> <cli> ...".
    expect(failure.message).not.toMatch(/^Command failed/)
    expect(failure.migration).toBe(REHEARSAL_ID)
    // Everything an operator needs to act, in the message they are shown.
    expect(failure.message).toContain('P3018')
    expect(failure.message).toContain(REHEARSAL_ID)
    expect(failure.message).toContain('nonexistent_column')
  }, 900_000)

  it('rolled the failed migration back, leaving no half-built schema', async () => {
    const table = await db.query<{ t: string | null }>(
      `SELECT to_regclass('public.rehearsal_marker')::text AS t`,
    )
    // The migration created a table and inserted a row before it failed. In one
    // transaction, PostgreSQL undoes both.
    expect(table.rows[0].t).toBeNull()
  }, 300_000)

  it('records the failure in the history rather than hiding it', async () => {
    const row = await historyRow(db, REHEARSAL_ID)
    expect(row).toBeTruthy()
    // Present but UNFINISHED. A row that claimed completion here is how a
    // half-applied schema becomes permanent.
    expect(row!.finished_at).toBeNull()
    expect(row!.logs).toBeTruthy()

    // And it is not counted as applied, because appliedMigrations requires
    // finished_at IS NOT NULL AND rolled_back_at IS NULL.
    const applied = await appliedMigrations(db)
    expect(applied.has(REHEARSAL_ID)).toBe(false)
    expect(applied.size).toBe(before.applied)
  }, 300_000)

  it('leaves the live deployment readable, with its data intact', async () => {
    const rows = await db.query(`SELECT label FROM public.operator_marker`)
    expect(rows.rows.map(r => r.label)).toEqual(['before-the-failure'])
    expect(await schemaFingerprint(db)).toBe(before.fingerprint)

    const support = await checkSupportObjects(db)
    expect(support.every(o => o.present)).toBe(true)
  }, 300_000)

  it('refuses to report the schema current while the failure is unresolved', async () => {
    // The dangerous alternative: a later run that skips the failed migration
    // and answers "already current". Prisma refuses (P3009) and the wrapper
    // must surface that refusal rather than swallowing it.
    let caught: unknown = null
    try {
      await runSelfHostMigrations({
        root: ROOT,
        client: db,
        databaseUrl: dbUrl,
        assemble: root => assembleMigrationWorkspace(root),
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MigrationFailed)
    expect((caught as MigrationFailed).message).toMatch(/P3009|failed migration/i)
  }, 900_000)

  it('allows a controlled retry once the failed migration is resolved', async () => {
    // The documented recovery: mark the rolled-back migration as such, then
    // apply the repaired one. Prisma's own mechanism, not a Backenly invention.
    const workspace = assembleMigrationWorkspace(ROOT, [{ id: REHEARSAL_ID, sql: FIXED_SQL }])
    try {
      prismaCli(['migrate', 'resolve', '--rolled-back', REHEARSAL_ID], workspace.schemaPath)
    } finally {
      workspace.dispose()
    }

    await runSelfHostMigrations({
      root: ROOT,
      client: db,
      databaseUrl: dbUrl,
      assemble: root => assembleMigrationWorkspace(root, [{ id: REHEARSAL_ID, sql: FIXED_SQL }]),
    })

    // Asserted on the DATABASE, not on `report.deployed`. The plan is computed
    // from the canonical directory, and a rehearsal migration exists only in
    // the assembled workspace, so the report cannot name it - which is correct
    // for the product and simply means the report is the wrong witness here.
    const recorded = await historyRow(db, REHEARSAL_ID)
    expect(recorded!.finished_at).toBeTruthy()
    expect(recorded!.rolled_back_at).toBeNull()

    // The repaired migration's effects are really there.
    const rows = await db.query<{ label: string }>(
      `SELECT label FROM public.rehearsal_marker`,
    )
    expect(rows.rows.map(r => r.label)).toEqual(['written-by-the-retry'])

    // And the operator's own data was never touched by any of it.
    const marker = await db.query(`SELECT label FROM public.operator_marker`)
    expect(marker.rows.map((r: any) => r.label)).toEqual(['before-the-failure'])
  }, 900_000)
})

describe('C — the run after a successful one changes nothing', () => {
  it('adopts nothing, deploys nothing, and leaves the schema identical', async () => {
    const fingerprint = await schemaFingerprint(db)
    const applied = (await appliedMigrations(db)).size

    const report = await runSelfHostMigrations({
      root: ROOT,
      client: db,
      databaseUrl: dbUrl,
      assemble: root => assembleMigrationWorkspace(root, [{ id: REHEARSAL_ID, sql: FIXED_SQL }]),
    })

    // Adoption is for a database with no history. This one has a complete one,
    // so entering that path again would mean the install could re-adopt for
    // ever — the property the upgrade tranche exists to guarantee.
    expect(report.adopted).toEqual([])
    expect(report.deployed).toEqual([])
    expect((await appliedMigrations(db)).size).toBe(applied)
    expect(await schemaFingerprint(db)).toBe(fingerprint)
  }, 900_000)
})

describe('D — the objects Prisma does not model survived all of it', () => {
  it('still has the PostgREST registry and every event trigger', async () => {
    // A failed migration, a resolve, a retry and a no-op run later. These are
    // created by SQL rather than by Prisma, so nothing in the migration engine
    // is watching them — which is exactly why the runner checks explicitly.
    const support = await checkSupportObjects(db)
    const missing = support.filter(o => !o.present).map(o => o.name)
    expect(missing).toEqual([])
  }, 300_000)
})
