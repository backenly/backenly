/**
 * UPGRADING A SELF-HOST DEPLOYMENT THAT ALREADY EXISTS
 * ===================================================
 *
 * Fresh install worked and had its own CI job. Upgrade did not work at all, and
 * nothing looked at it.
 *
 * `scripts/selfhost.ts` returned as soon as `public.projects` existed —
 * correctly, because `prisma db push` is unsafe against an installed deployment:
 * it sees the PostgREST registry and event triggers, which are created by SQL
 * rather than by Prisma, and sets out to drop them. But there was no other
 * branch. A `db push` install also records no `_prisma_migrations`, so
 * `migrate deploy` had no history to work from and the startup check had nothing
 * to compare. Verified against a genuine older release: the schema froze, the
 * data survived, and the first query against a table added later failed with
 * P2021.
 *
 * ── This suite builds a REAL old install ────────────────────────────────────
 *
 * Not a downgraded copy of the current schema. The old release's own
 * `schema.prisma`, from a git worktree at that commit, pushed exactly the way
 * that release's installer pushed it. Anything else would be testing a
 * hand-made artefact rather than what operators actually have on disk.
 *
 * ── And it seeds a deployment, not a table ──────────────────────────────────
 *
 * Operator identity, a project, a workspace schema with a row, an end-user auth
 * identity, an API credential, and the PostgREST support objects. Proving that
 * `project_email_configs` appears would say nothing about whether the operator
 * still has their data.
 */

import { execFileSync } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import crypto from 'crypto'
import { Client } from 'pg'

import { runSelfHostMigrations, MigrationRefused, checkSupportObjects } from '@/lib/selfhost/run-migrations'
import { planMigrations, appliedMigrations } from '@/lib/selfhost/migration-adoption'
import { assembleMigrationWorkspace } from '@/tools/managed-db/migration-workspace'

/**
 * The oldest release this suite upgrades from.
 *
 * `645679e2` is the Recovery/DR tranche (#63) — a CI-green release with the
 * full modern installer, four-role credential split and setup-token claim. The
 * supported floor is measured separately; this is a release an operator
 * plausibly runs.
 */
const OLD_RELEASE = '645679e2'

const ROOT = process.cwd()
const WORKTREE = join(tmpdir(), `backenly-old-${OLD_RELEASE}`)
const DB_NAME = `backenly_upgrade_${crypto.randomBytes(4).toString('hex')}`

let adminUrl: string
let dbUrl: string
let seeded: {
  userId: string
  projectId: string
  schema: string
  apiKeyId: string
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Make sure a commit exists locally, fetching it if the clone is shallow.
 *
 * Failing here must say WHY, and must say what git said. The first version
 * reported only `Command failed: git fetch --depth 1 origin <sha>` — execFileSync
 * puts the actual reason on `err.stderr`, not on `err.message`, so the one fact
 * that would have explained a CI failure was the one fact being discarded.
 *
 * Several fetch shapes are tried because which one works depends on the server
 * and on how the clone was made: fetching a bare SHA needs the remote to allow
 * it, and a shallow clone whose boundary excludes the commit needs deepening.
 * CI also asks for full history (fetch-depth: 0), so none of this should be
 * reached there — it exists for a contributor's shallow clone.
 */
function ensureRefPresent(ref: string): void {
  const present = () => {
    try {
      git(['cat-file', '-e', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  if (present()) return

  const attempts: string[][] = [
    ['fetch', '--depth', '1', 'origin', ref],
    ['fetch', 'origin', ref],
    ['fetch', '--unshallow', 'origin'],
    ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
  ]

  const failures: string[] = []
  for (const args of attempts) {
    try {
      git(args)
      if (present()) return
      failures.push(`${args.join(' ')}: succeeded but the commit is still absent`)
    } catch (err: any) {
      const said = String(err?.stderr ?? err?.message ?? err)
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join(' | ')
      failures.push(`${args.join(' ')}: ${said}`)
    }
  }

  throw new Error(
    `the old release ${ref} is not in this clone and could not be fetched. This suite ` +
      `upgrades from a REAL older release, so without that commit there is nothing to ` +
      `upgrade from. Tried:\n  ` +
      failures.join('\n  '),
  )
}

function prismaPush(schemaPath: string, url: string): void {
  // node + the CLI entrypoint, for the same reason run-migrations.ts does it:
  // no shell to re-parse arguments, and Node will not execFile a .cmd.
  const cli = require.resolve('prisma/build/index.js')
  execFileSync(
    process.execPath,
    [cli, 'db', 'push', '--accept-data-loss', '--skip-generate', '--schema', schemaPath],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    },
  )
}

async function connect(url: string): Promise<Client> {
  const c = new Client({ connectionString: url })
  // A dropped database or a terminated backend surfaces as an 'error' event on
  // the client, and an unhandled one fails the suite from teardown rather than
  // from anything under test.
  c.on('error', () => {})
  await c.connect()
  return c
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

  // A genuine checkout of the old release, not a doctored schema.
  //
  // CI clones shallow (fetch-depth: 1), so the old commit is usually absent and
  // `worktree add` fails with "invalid reference". Fetching it here keeps the
  // suite self-sufficient in any clone — a developer's shallow one too — rather
  // than depending on a workflow setting a future job would forget to copy.
  ensureRefPresent(OLD_RELEASE)
  if (existsSync(WORKTREE)) git(['worktree', 'remove', '--force', WORKTREE])
  git(['worktree', 'add', '--force', WORKTREE, OLD_RELEASE])

  // The old release's installer pushed its own schema. This is that.
  prismaPush(join(WORKTREE, 'prisma', 'schema.prisma'), dbUrl)

  // ── Seed a deployment an operator would recognise ───────────────────────
  const c = await connect(dbUrl)
  const userId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const schema = `workspace_${projectId}`
  const apiKeyId = crypto.randomUUID()

  await c.query(
    `INSERT INTO users (id, email, password, name, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, now(), now())`,
    [userId, 'operator@example.test', '$2b$12$notarealhashbutrightshape', 'Operator'],
  )
  await c.query(
    `INSERT INTO projects (id, name, "userId", "jwtSecret", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, now(), now())`,
    [projectId, 'pre-upgrade-project', userId, crypto.randomBytes(32).toString('hex')],
  )

  // A workspace schema with a real row, plus an end-user auth identity, which is
  // what an operator would actually lose.
  await c.query(`CREATE SCHEMA "${schema}"`)
  await c.query(`CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, label text NOT NULL)`)
  await c.query(`INSERT INTO "${schema}".orders (label) VALUES ('pre-upgrade-row')`)
  await c.query(
    `CREATE TABLE "${schema}".users (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email text UNIQUE NOT NULL,
       password text NOT NULL
     )`,
  )
  await c.query(
    `INSERT INTO "${schema}".users (email, password) VALUES ('enduser@example.test', $1)`,
    ['$2b$12$anotherhashshapedstring'],
  )

  // An API credential: a secret the operator cannot re-derive if it is lost.
  await c.query(
    `INSERT INTO api_keys (id, "userId", "projectId", name, "keyHash", "keyPrefix", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [apiKeyId, userId, projectId, 'pre-upgrade-key', 'hash-of-the-key', 'bk_live_'],
  )

  // The PostgREST support objects, created by SQL rather than Prisma. These are
  // the ones `db push` wanted to drop, and the ones a migration run must not.
  await c.query(
    `CREATE TABLE IF NOT EXISTS public.backenly_pgrst_schema_registry (
       schema_name text PRIMARY KEY,
       added_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await c.query(`INSERT INTO public.backenly_pgrst_schema_registry (schema_name) VALUES ($1)`, [schema])
  await c.query(
    `CREATE OR REPLACE FUNCTION public.backenly_pgrst_noop() RETURNS event_trigger
     LANGUAGE plpgsql AS $$ BEGIN END $$`,
  )
  for (const name of ['backenly_pgrst_ddl_sync', 'backenly_pgrst_schema_create', 'backenly_pgrst_schema_drop']) {
    await c.query(
      `CREATE EVENT TRIGGER ${name} ON ddl_command_end EXECUTE FUNCTION public.backenly_pgrst_noop()`,
    )
  }

  await c.end()
  seeded = { userId, projectId, schema, apiKeyId }
}, 600_000)

afterAll(async () => {
  try {
    const a = new Client({ connectionString: adminUrl })
    // Terminating backends makes any still-open client emit an error event, and
    // an unhandled one fails the whole suite during teardown. Attached before
    // the terminate, not after.
    a.on('error', () => {})
    await a.connect()
    await a
      .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}'`)
      .catch(() => {})
    await a.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
    await a.end().catch(() => {})
  } catch {
    // The database is a throwaway; failing to drop it must not fail the suite.
  }
  try {
    git(['worktree', 'remove', '--force', WORKTREE])
  } catch {
    rmSync(WORKTREE, { recursive: true, force: true })
  }
}, 600_000)

describe('the old install is genuinely old', () => {
  it('has the platform tables and NOT the ones added since', async () => {
    const c = await connect(dbUrl)
    try {
      const { rows } = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public.projects')::text AS t`,
      )
      expect(rows[0].t).toBeTruthy()

      // The control for the whole suite: the feature added after this release
      // must be absent, or "it works after upgrade" proves nothing.
      const after = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public.project_email_configs')::text AS t`,
      )
      expect(after.rows[0].t).toBeNull()

      // And no migration history, which is what made upgrade impossible.
      const hist = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public._prisma_migrations')::text AS t`,
      )
      expect(hist.rows[0].t).toBeNull()
    } finally {
      await c.end()
    }
  }, 120_000)
})

describe('adoption decides before it touches anything', () => {
  it('recognises the prefix this database satisfies', async () => {
    const c = await connect(dbUrl)
    try {
      const plan = await planMigrations(ROOT, c)
      expect(plan.refusal).toBeNull()
      expect(plan.alreadyTracked).toBe(false)

      // Every migration it adopts had its FULL postconditions verified: tables,
      // their columns, indexes, constraints and types. Not one sentinel table.
      expect(plan.adopt.length).toBeGreaterThan(0)
      expect(plan.adopt[0]).toBe('00000000000000_baseline')
      expect(plan.deploy).toContain('20260919120000_project_email_config_and_templates')

      // Planning is read-only. Asserted, because "refuse before mutating" is
      // the guarantee that makes a refusal safe.
      const hist = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public._prisma_migrations')::text AS t`,
      )
      expect(hist.rows[0].t).toBeNull()
    } finally {
      await c.end()
    }
  }, 120_000)

  it('refuses a database that satisfies nothing, without writing', async () => {
    // A database with Backenly-shaped tables that are not Backenly's. Adoption
    // must not decide this is "an old install" and start recording history.
    const name = `backenly_bogus_${crypto.randomBytes(4).toString('hex')}`
    const a = await connect(adminUrl)
    await a.query(`CREATE DATABASE ${name}`)
    await a.end()

    const url = new URL(dbUrl)
    url.pathname = `/${name}`
    const c = await connect(url.toString())
    try {
      await c.query(`CREATE TABLE projects (id text PRIMARY KEY)`)

      const plan = await planMigrations(ROOT, c)
      expect(plan.refusal).toBeTruthy()
      // A partly-present BASELINE is not an interrupted upgrade, it is a
      // database below the supported floor, and the message has to say so.
      expect(plan.refusal).toMatch(/minimum supported source release/i)
      // It names the route out rather than only saying no.
      expect(plan.refusal).toMatch(/recovery bundle/i)
      expect(plan.refusal).toMatch(/EMPTY database/)
      expect(plan.adopt).toEqual([])
    } finally {
      await c.end()
      const admin = await connect(adminUrl)
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
      await admin.end()
    }
  }, 180_000)
})

describe('the upgrade itself', () => {
  it('adopts, deploys, and leaves the deployment intact', async () => {
    const c = await connect(dbUrl)
    try {
      const report = await runSelfHostMigrations({
        root: ROOT,
        client: c,
        databaseUrl: dbUrl,
        assemble: root => assembleMigrationWorkspace(root),
      })

      expect(report.adopted.length).toBeGreaterThan(0)
      expect(report.deployed).toContain('20260919120000_project_email_config_and_templates')

      // ── The feature added after the old release now exists ─────────────
      const added = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public.project_email_configs')::text AS t`,
      )
      expect(added.rows[0].t).toBeTruthy()

      // ── And everything the operator had is still there ─────────────────
      const user = await c.query(`SELECT email FROM users WHERE id = $1`, [seeded.userId])
      expect(user.rows[0].email).toBe('operator@example.test')

      const project = await c.query(`SELECT name, "jwtSecret" FROM projects WHERE id = $1`, [seeded.projectId])
      expect(project.rows[0].name).toBe('pre-upgrade-project')
      // The signing secret in particular: losing it invalidates every end-user
      // token the deployment ever issued.
      expect(project.rows[0].jwtSecret).toHaveLength(64)

      const row = await c.query(`SELECT label FROM "${seeded.schema}".orders`)
      expect(row.rows[0].label).toBe('pre-upgrade-row')

      const endUser = await c.query(`SELECT email, password FROM "${seeded.schema}".users`)
      expect(endUser.rows[0].email).toBe('enduser@example.test')
      expect(endUser.rows[0].password).toMatch(/^\$2b\$12\$/)

      const key = await c.query(`SELECT "keyHash" FROM api_keys WHERE id = $1`, [seeded.apiKeyId])
      expect(key.rows[0].keyHash).toBe('hash-of-the-key')

      // ── The objects Prisma does not model survived ─────────────────────
      const support = await checkSupportObjects(c)
      for (const obj of support) {
        expect(obj.present).toBe(true)
      }
      const registry = await c.query(`SELECT schema_name FROM public.backenly_pgrst_schema_registry`)
      expect(registry.rows[0].schema_name).toBe(seeded.schema)
    } finally {
      await c.end()
    }
  }, 600_000)

  it('is a no-op the second time, changing no schema', async () => {
    const c = await connect(dbUrl)
    try {
      // A fingerprint of every table, column, index, constraint and type, so
      // "no schema changes" is measured rather than asserted from a log line.
      const fingerprint = async () => {
        const { rows } = await c.query<{ f: string }>(
          `SELECT md5(string_agg(entry, '|' ORDER BY entry)) AS f FROM (
             SELECT table_name || '.' || column_name || ':' || data_type AS entry
               FROM information_schema.columns WHERE table_schema = 'public'
             UNION ALL
             SELECT 'idx:' || indexname FROM pg_indexes WHERE schemaname = 'public'
             UNION ALL
             SELECT 'con:' || c.conname FROM pg_constraint c
               JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
           ) AS entries`,
        )
        return rows[0].f
      }

      const before = await fingerprint()

      const report = await runSelfHostMigrations({
        root: ROOT,
        client: c,
        databaseUrl: dbUrl,
        assemble: root => assembleMigrationWorkspace(root),
      })

      // Now tracked, so the legacy path is never entered again.
      expect(report.plan.alreadyTracked).toBe(true)
      expect(report.adopted).toEqual([])
      // Nothing PENDING. The first version of this reported the whole chain
      // here, so a no-op rerun printed "deploying 4" and having nothing to do
      // looked exactly like having done everything.
      expect(report.deployed).toEqual([])

      expect(await fingerprint()).toBe(before)

      // And the history is complete rather than partially recorded.
      const applied = await appliedMigrations(c)
      expect(applied.has('00000000000000_baseline')).toBe(true)
      expect(applied.has('20260919120000_project_email_config_and_templates')).toBe(true)
    } finally {
      await c.end()
    }
  }, 600_000)

  it('refuses a half-applied migration instead of recording it', async () => {
    // The dangerous state: one of a migration's tables present, the rest not.
    // A sentinel check would see the headline table and wave it through; this
    // must refuse, and refuse without writing.
    const name = `backenly_partial_${crypto.randomBytes(4).toString('hex')}`
    const a = await connect(adminUrl)
    await a.query(`CREATE DATABASE ${name}`)
    await a.end()

    const url = new URL(dbUrl)
    url.pathname = `/${name}`
    const c = await connect(url.toString())
    try {
      // A real old install, then half of a later migration applied by hand —
      // which is what an interrupted upgrade leaves behind.
      prismaPush(join(WORKTREE, 'prisma', 'schema.prisma'), url.toString())
      await c.query(
        `CREATE TABLE "project_email_configs" (
           "id" TEXT NOT NULL,
           CONSTRAINT "project_email_configs_pkey" PRIMARY KEY ("id")
         )`,
      )

      const plan = await planMigrations(ROOT, c)
      expect(plan.refusal).toBeTruthy()
      expect(plan.refusal).toMatch(/PARTLY present|out of sequence/i)
      // It names what differs, so an operator can act.
      expect(plan.refusal!.length).toBeGreaterThan(80)

      // Nothing written, which is the whole point.
      const hist = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public._prisma_migrations')::text AS t`,
      )
      expect(hist.rows[0].t).toBeNull()

      // And the executor refuses too, not just the planner.
      await expect(
        runSelfHostMigrations({
          root: ROOT,
          client: c,
          databaseUrl: url.toString(),
          assemble: root => assembleMigrationWorkspace(root),
        }),
      ).rejects.toBeInstanceOf(MigrationRefused)
    } finally {
      await c.end()
      const admin = await connect(adminUrl)
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
      await admin.end()
    }
  }, 600_000)
})

describe('a fresh install is born under migrations', () => {
  it('deploys the whole chain into an empty database and records it', async () => {
    const name = `backenly_fresh_${crypto.randomBytes(4).toString('hex')}`
    const a = await connect(adminUrl)
    await a.query(`CREATE DATABASE ${name}`)
    await a.end()

    const url = new URL(dbUrl)
    url.pathname = `/${name}`
    const c = await connect(url.toString())
    try {
      const report = await runSelfHostMigrations({
        root: ROOT,
        client: c,
        databaseUrl: url.toString(),
        assemble: root => assembleMigrationWorkspace(root),
      })

      // Nothing adopted: an empty database has no history to manufacture.
      expect(report.adopted).toEqual([])
      expect(report.deployed.length).toBeGreaterThan(0)

      // The schema is there AND so is the history, which is what makes the next
      // upgrade an ordinary deploy rather than another adoption.
      const tables = await c.query<{ t: string | null }>(
        `SELECT to_regclass('public.project_email_configs')::text AS t`,
      )
      expect(tables.rows[0].t).toBeTruthy()

      const applied = await appliedMigrations(c)
      expect(applied.size).toBe(report.deployed.length)
    } finally {
      await c.end()
      const admin = await connect(adminUrl)
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
      await admin.end()
    }
  }, 600_000)
})
