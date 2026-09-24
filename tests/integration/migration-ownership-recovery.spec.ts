/**
 * THE ENUM OWNERSHIP INCIDENT, REPRODUCED AND RECOVERED
 * =====================================================
 *
 * On 2026-09-24 staging's deploy of 20260924120000_project_pause failed on its
 * first statement:
 *
 *   ALTER TYPE "WebhookDeliveryStatus" ADD VALUE 'CANCELLED'
 *   ERROR: must be owner of type "WebhookDeliveryStatus"   (42501)
 *
 * The app-role cutover had moved every public table to the application role and
 * left every enum with the admin role that created it. Nothing was applied, but
 * Prisma wrote a FAILED row into _prisma_migrations, and a failed row refuses
 * every later deploy.
 *
 * This builds that exact database. An admin role that is NOT a superuser, like
 * the RDS master, applies the canonical chain up to the pause migration. The
 * tables then move to an application role and the enums stay behind. Then it
 * walks the recovery the release follows, with the real runner entrypoint, the
 * real Prisma CLI and the real repair SQL:
 *
 *   A  the ownership preflight refuses a deploy BEFORE Prisma writes history;
 *   B  rollback cannot fabricate history for a migration that never ran;
 *   C  without the preflight the incident reproduces: a failed row, and
 *      nothing applied;
 *   D  rollback refuses without the exact confirmation, and refuses while any
 *      declared effect is present;
 *   E  rollback resolves the genuinely absent state, and the migration is
 *      pending again;
 *   F  the repair reports, refuses the wrong database and role, converges, and
 *      is a no-op the second time;
 *   G  the preflight passes, the deploy applies, and the presence proof holds;
 *   H  rollback refuses a migration that is applied.
 *
 * The steps depend on each other in order, which is the point: this is the
 * release sequence, not eight unrelated facts.
 */

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import crypto from 'crypto'
import { Client } from 'pg'

import { assembleMigrationWorkspace, CANONICAL_DIR, type AssembledWorkspace } from '@/tools/managed-db/migration-workspace'
import {
  ENUM_REPAIR_SQL_PATH,
  buildEnumRepairScript,
  parseRepairResult,
} from '@/tools/managed-db/enum-ownership-repair'

const ROOT = process.cwd()
const PAUSE = '20260924120000_project_pause'
const ENTRYPOINT = join(ROOT, 'tools', 'managed-db', 'runner', 'entrypoint.sh').replace(/\\/g, '/')
const CHECKS = join(ROOT, 'tools', 'managed-db', 'runner', 'checks').replace(/\\/g, '/')

const HEX = crypto.randomBytes(4).toString('hex')
const DB_NAME = `backenly_migown_${HEX}`
const ADMIN_ROLE = `bkn_migown_admin_${HEX}`
const APP_ROLE = `bkn_migown_app_${HEX}`
const ADMIN_PW = `admin_pw_${HEX}`
const APP_PW = `app_pw_${HEX}`

const ENUMS = [
  'AutonomyLevel',
  'ProjectStatus',
  'SubscriptionStatus',
  'TriggerDeliveryStatus',
  'WebhookDeliveryStatus',
]

let superOnPostgres = ''
let superOnTarget = ''
let adminUrl = ''
let appUrl = ''
let su: Client
let before: AssembledWorkspace
let full: AssembledWorkspace
let scratch = ''
let prismaWrapper = ''

function urlFor(base: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(base)
  u.pathname = `/${db}`
  if (user) {
    u.username = user.name
    u.password = user.password
  }
  return u.toString()
}

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url })
  c.on('error', () => {})
  await c.connect()
  return c
}

const PRISMA_CLI = require.resolve('prisma/build/index.js')

/** The Prisma CLI directly, as the OLD runner ran it: no preflight. */
function prismaDirect(args: string[], schemaPath: string, url: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [PRISMA_CLI, ...args, '--schema', schemaPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** The runner's entrypoint, as the image runs it, connected as the APP role. */
function runner(args: string[], env: Record<string, string> = {}): { status: number; output: string } {
  try {
    const output = execFileSync('sh', [ENTRYPOINT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: appUrl,
        DIRECT_URL: appUrl,
        EXPECT_DATABASE: DB_NAME,
        MIGRATE_PRISMA: prismaWrapper,
        MIGRATE_SCHEMA: full.schemaPath.replace(/\\/g, '/'),
        MIGRATE_CHECKS: CHECKS,
        ...env,
      },
    })
    return { status: 0, output }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

async function ledger(): Promise<Array<{ finished: boolean; rolledBack: boolean }>> {
  const r = await su.query<{ finished_at: Date | null; rolled_back_at: Date | null }>(
    `SELECT finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [PAUSE],
  )
  return r.rows.map(x => ({ finished: x.finished_at !== null, rolledBack: x.rolled_back_at !== null }))
}

async function enumOwners(): Promise<Record<string, string>> {
  const r = await su.query<{ typname: string; owner: string }>(
    `SELECT t.typname, pg_get_userbyid(t.typowner) AS owner
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1`,
  )
  return Object.fromEntries(r.rows.map(x => [x.typname, x.owner]))
}

async function runRepair(
  apply: boolean,
  overrides: Partial<{ database: string; appRole: string }> = {},
): Promise<{ notices: string[]; error: string | null }> {
  const sql = readFileSync(join(ROOT, ENUM_REPAIR_SQL_PATH), 'utf8')
  const script = buildEnumRepairScript(sql, { apply, database: DB_NAME, appRole: APP_ROLE, ...overrides })
  const c = await connect(adminUrl)
  const notices: string[] = []
  c.on('notice', n => notices.push(String(n.message)))
  let error: string | null = null
  try {
    await c.query(script)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    await c.end()
  }
  return { notices, error }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  const base = process.env.TEST_DATABASE_URL
  if (!base) throw new Error('Refusing: TEST_DATABASE_URL is not set')

  superOnPostgres = urlFor(base, 'postgres')
  superOnTarget = urlFor(base, DB_NAME)
  adminUrl = urlFor(base, DB_NAME, { name: ADMIN_ROLE, password: ADMIN_PW })
  appUrl = urlFor(base, DB_NAME, { name: APP_ROLE, password: APP_PW })

  const s = await connect(superOnPostgres)
  await s.query(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await s.query(`DROP ROLE IF EXISTS ${APP_ROLE}`)
  await s.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`)
  // The admin is NOT a superuser, like the RDS master. It owns the database,
  // so it can build the schema, and it is a member of the application role,
  // as the master is of the role it created, so it can hand objects over.
  await s.query(`CREATE ROLE ${ADMIN_ROLE} LOGIN NOSUPERUSER PASSWORD '${ADMIN_PW}'`)
  await s.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_PW}'`)
  await s.query(`GRANT ${APP_ROLE} TO ${ADMIN_ROLE}`)
  await s.query(`CREATE DATABASE ${DB_NAME} OWNER ${ADMIN_ROLE}`)
  await s.end()

  // `public` exactly as RDS has it (measured on staging): owned by
  // pg_database_owner, no CREATE for PUBLIC. Stated here rather than inherited
  // from template1, which on a cluster that began before PostgreSQL 15 still
  // has the old superuser-owned, world-writable schema.
  const t = await connect(urlFor(base, DB_NAME))
  await t.query(`ALTER SCHEMA public OWNER TO pg_database_owner`)
  await t.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
  await t.end()

  scratch = mkdtempSync(join(tmpdir(), 'migown-')).replace(/\\/g, '/')
  prismaWrapper = `${scratch}/prisma`
  writeFileSync(
    prismaWrapper,
    `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${PRISMA_CLI.replace(/\\/g, '/')}" "$@"\n`,
    { mode: 0o755 },
  )

  // Everything up to, and NOT including, the pause migration, applied by the
  // admin role. That is the state staging was in before v8.
  const ids = readdirSync(join(ROOT, CANONICAL_DIR), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
  expect(ids).toContain(PAUSE)
  before = assembleMigrationWorkspace(ROOT, [], { only: ids.filter(id => id !== PAUSE) })
  full = assembleMigrationWorkspace(ROOT)
  const built = prismaDirect(['migrate', 'deploy'], before.schemaPath, adminUrl)
  if (built.status !== 0) throw new Error(`building the pre-v8 schema failed:\n${built.output}`)

  // The FIRST cutover, as it ran: schema privileges (a new owner must be able
  // to CREATE in the schema), then relations to the application role, enums
  // left with the admin. Tables first, so the sequences they own follow them.
  const admin = await connect(adminUrl)
  await admin.query(`
    GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE};
    GRANT CONNECT, TEMPORARY ON DATABASE ${DB_NAME} TO ${APP_ROLE};
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT c.oid::regclass::text AS ident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relowner = current_user::regrole
      LOOP EXECUTE format('ALTER TABLE %s OWNER TO ${APP_ROLE}', r.ident); END LOOP;
      FOR r IN SELECT c.oid::regclass::text AS ident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relowner = current_user::regrole
      LOOP EXECUTE format('ALTER SEQUENCE %s OWNER TO ${APP_ROLE}', r.ident); END LOOP;
    END $$;
    -- The seam the platform resolves its application role through.
    CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT '${APP_ROLE}'::text $f$;
  `)
  await admin.end()

  su = await connect(superOnTarget)
  const owners = await enumOwners()
  expect(Object.keys(owners).sort()).toEqual(ENUMS)
  for (const e of ENUMS) expect(owners[e]).toBe(ADMIN_ROLE)
}, 900_000)

afterAll(async () => {
  await su?.end().catch(() => {})
  before?.dispose()
  full?.dispose()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  const s = await connect(superOnPostgres).catch(() => null)
  if (s) {
    await s.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB_NAME]).catch(() => {})
    await s.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
    await s.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {})
    await s.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`).catch(() => {})
    await s.end().catch(() => {})
  }
}, 300_000)

describe('A — an admin-owned enum refuses the deploy before Prisma writes anything', () => {
  it('deploy is refused by the preflight, naming every enum and its owner', () => {
    const r = runner(['deploy'])
    expect(r.status).toBe(3)
    expect(r.output).toMatch(/refusing: ownership preflight failed; nothing was applied and no migration history was written/)
    for (const e of ENUMS) expect(r.output).toContain(`type public."${e}" is owned by ${ADMIN_ROLE}`)
    expect(r.output).not.toMatch(/Applying migration/)
  }, 180_000)

  it('left no history row and no effect behind', async () => {
    expect(await ledger()).toEqual([])
    const cols = await su.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'pausedAt'`)
    expect(cols.rowCount).toBe(0)
  })

  it('preflight on its own reaches the same verdict', () => {
    const r = runner(['preflight'])
    expect(r.status).toBe(3)
    expect(r.output).not.toMatch(/PREFLIGHT PASSED/)
  }, 180_000)
})

describe('B — rollback cannot fabricate history for a migration that never ran', () => {
  it('passes the absence proof, then Prisma refuses: there is no failed row to resolve', async () => {
    const r = runner(['rollback', PAUSE], { MIGRATE_ROLLBACK_CONFIRM: PAUSE })
    expect(r.output).toMatch(/ABSENT: /)
    expect(r.status).not.toBe(0)
    expect(r.output).not.toMatch(/marked as rolled back\./)
    expect(await ledger()).toEqual([])
  }, 180_000)
})

describe('C — without the preflight, the incident reproduces exactly', () => {
  it('prisma migrate deploy as the app role fails with 42501 and writes a failed row', async () => {
    const r = prismaDirect(['migrate', 'deploy'], full.schemaPath, appUrl)
    expect(r.status).not.toBe(0)
    expect(r.output).toMatch(/must be owner of type "?WebhookDeliveryStatus"?/)
    expect(await ledger()).toEqual([{ finished: false, rolledBack: false }])
  }, 180_000)

  it('and applied nothing: the transaction rolled back', async () => {
    const e = await su.query(
      `SELECT 1 FROM pg_enum WHERE enumtypid = 'public."WebhookDeliveryStatus"'::regtype AND enumlabel = 'CANCELLED'`,
    )
    expect(e.rowCount).toBe(0)
  })

  it('and the failed row now refuses a retry, which is why rollback exists', () => {
    const r = prismaDirect(['migrate', 'deploy'], full.schemaPath, appUrl)
    expect(r.status).not.toBe(0)
    expect(r.output).toMatch(/P3009|failed migrations/)
  }, 180_000)
})

describe('D — rollback refuses what it must refuse', () => {
  it('without a confirmation', async () => {
    const r = runner(['rollback', PAUSE])
    expect(r.status).toBe(2)
    expect(await ledger()).toEqual([{ finished: false, rolledBack: false }])
  }, 60_000)

  it('with a confirmation naming a different migration', async () => {
    const r = runner(['rollback', PAUSE], { MIGRATE_ROLLBACK_CONFIRM: '20260922120000_auth_email_codes' })
    expect(r.status).toBe(2)
    expect(await ledger()).toEqual([{ finished: false, rolledBack: false }])
  }, 60_000)

  it('while any single declared effect is present, and it names that effect', async () => {
    // One column of seven, added by the table's owner. The half-applied case.
    const app = await connect(appUrl)
    await app.query(`ALTER TABLE public.projects ADD COLUMN "pauseReason" TEXT`)
    try {
      const r = runner(['rollback', PAUSE], { MIGRATE_ROLLBACK_CONFIRM: PAUSE })
      expect(r.status).toBe(3)
      expect(r.output).toContain('column projects.pauseReason')
      expect(r.output).toMatch(/left effects of 20260924120000_project_pause behind/)
      expect(r.output).not.toMatch(/marked as rolled back\./)
      expect(await ledger()).toEqual([{ finished: false, rolledBack: false }])
    } finally {
      await app.query(`ALTER TABLE public.projects DROP COLUMN "pauseReason"`)
      await app.end()
    }
  }, 180_000)
})

describe('E — rollback resolves the genuinely absent state', () => {
  it('proves absence, then marks the failed row rolled back', async () => {
    const r = runner(['rollback', PAUSE], { MIGRATE_ROLLBACK_CONFIRM: PAUSE })
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/ABSENT: 20260924120000_project_pause left none of its declared effects behind/)
    expect(r.output).toMatch(/marked as rolled back\./)
    expect(await ledger()).toEqual([{ finished: false, rolledBack: true }])
  }, 180_000)

  it('status is NOT evidence after a rollback: Prisma reports up to date while the migration is unapplied', () => {
    // Measured, Prisma 5.22: once the failed row is marked rolled back,
    // `migrate status` prints "Database schema is up to date!" and exits 0,
    // although nothing of the migration exists and `deploy` will apply it.
    // Pinned so no release reads this line as proof of anything. What IS
    // evidence: the presence proof failing (below) and, later, the deploy's own
    // "Applying migration" line.
    const r = runner(['status'])
    expect(r.output).toMatch(/Database schema is up to date/)
    expect(r.output).not.toMatch(/have failed|P3009/)

    const v = runner(['verify', PAUSE])
    expect(v.status).not.toBe(0)
    expect(v.output).toMatch(/declared objects that are absent or different/)
    expect(v.output).not.toMatch(/VERIFIED/)
  }, 180_000)
})

describe('F — the enum ownership repair', () => {
  it('reports current owner -> desired owner and changes nothing', async () => {
    const r = await runRepair(false)
    expect(r.error).toBeNull()
    for (const e of ENUMS) {
      expect(r.notices).toContain(`before  public."${e}"  owner ${ADMIN_ROLE} -> ${APP_ROLE} (will move)`)
    }
    expect(parseRepairResult(r.notices.join('\n'))).toEqual({ mode: 'report', wouldMove: 5, moved: 0, notOwnedByAppRole: 5 })
    for (const owner of Object.values(await enumOwners())) expect(owner).toBe(ADMIN_ROLE)
  }, 60_000)

  it('refuses a different database', async () => {
    const r = await runRepair(true, { database: 'backenly_somewhere_else' })
    expect(r.error).toMatch(/refusing: connected to database/)
    for (const owner of Object.values(await enumOwners())) expect(owner).toBe(ADMIN_ROLE)
  }, 60_000)

  it('refuses when the configured application role is not the expected one', async () => {
    const r = await runRepair(true, { appRole: 'backenly_app' })
    expect(r.error).toMatch(/resolves to .*, but backenly_app was expected/)
    for (const owner of Object.values(await enumOwners())) expect(owner).toBe(ADMIN_ROLE)
  }, 60_000)

  it('converges every enum onto the application role, with before and after evidence', async () => {
    const r = await runRepair(true)
    expect(r.error).toBeNull()
    for (const e of ENUMS) expect(r.notices).toContain(`after   public."${e}"  owner ${APP_ROLE}`)
    expect(parseRepairResult(r.notices.join('\n'))).toEqual({ mode: 'apply', wouldMove: 5, moved: 5, notOwnedByAppRole: 0 })
    for (const owner of Object.values(await enumOwners())) expect(owner).toBe(APP_ROLE)
  }, 60_000)

  it('is a no-op the second time', async () => {
    const r = await runRepair(true)
    expect(r.error).toBeNull()
    expect(parseRepairResult(r.notices.join('\n'))).toEqual({ mode: 'apply', wouldMove: 0, moved: 0, notOwnedByAppRole: 0 })
  }, 60_000)

  it('touched nothing but enum owners: every table still belongs to the app role', async () => {
    const r = await su.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner <> $1::regrole`,
      [APP_ROLE],
    )
    expect(r.rows[0].n).toBe(0)
  })
})

describe('G — with ownership repaired, the release path completes', () => {
  it('preflight passes', () => {
    const r = runner(['preflight'])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/PREFLIGHT PASSED/)
  }, 180_000)

  it('deploy applies the pause migration', async () => {
    const r = runner(['deploy'])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/PREFLIGHT PASSED/)
    expect(r.output).toContain(`Applying migration \`${PAUSE}\``)
    expect(r.output).toMatch(/have been successfully applied|migration\(s\) have been applied/)
    expect(await ledger()).toEqual([
      { finished: false, rolledBack: true },
      { finished: true, rolledBack: false },
    ])
  }, 180_000)

  it('status is up to date', () => {
    const r = runner(['status'])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/Database schema is up to date/)
  }, 180_000)

  it('the presence proof finds every declared object', () => {
    const r = runner(['verify', PAUSE])
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/VERIFIED: 20260924120000_project_pause declared objects are all present/)
  }, 180_000)
})

describe('H — rollback refuses a migration that is applied', () => {
  it('the absence proof fails on the applied effects, so nothing is resolved', async () => {
    const r = runner(['rollback', PAUSE], { MIGRATE_ROLLBACK_CONFIRM: PAUSE })
    expect(r.status).toBe(3)
    expect(r.output).toContain('enum value WebhookDeliveryStatus.CANCELLED')
    expect(await ledger()).toEqual([
      { finished: false, rolledBack: true },
      { finished: true, rolledBack: false },
    ])
  }, 180_000)
})
