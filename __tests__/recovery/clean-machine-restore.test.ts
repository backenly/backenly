/**
 * RECOVERY ONTO A MACHINE THAT HAS NEVER SEEN THIS DEPLOYMENT
 * ==========================================================
 * The case the whole product exists for: the original server is gone, and all
 * that is left is a bundle and a credential.
 *
 * So the target here is a database created empty seconds earlier. Nothing about
 * the source deployment exists in it - no roles, no schema, no extensions, no
 * rows. If the bundle does not carry something, this test cannot silently
 * borrow it from the environment, which is precisely what makes a restore test
 * run on the source machine worthless.
 *
 * The assertions are about the two semantics locked before any of this was
 * built:
 *
 *   durable credentials come back with their value intact, because clients
 *   outside the deployment are configured against them, and
 *
 *   ephemeral ones do not come back at all - their tables exist and are empty,
 *   so the deployment can sign people in without resurrecting a session
 *   somebody revoked.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { exportDeploymentBundle } from '@/lib/recovery/export'
import { restoreDeployment, runnableSubsystems } from '@/lib/recovery/restore'
import type { RestoreProgress } from '@/lib/recovery/restore'

jest.setTimeout(900_000)

const SUFFIX = randomBytes(6).toString('hex')
const PLANTED_JWT_SECRET = `planted-durable-secret-${randomBytes(16).toString('hex')}`
const PLANTED_ANON_KEY = `planted-anon-${SUFFIX}`
const PLANTED_JTI = `planted-revoked-jti-${SUFFIX}`
const PLANTED_SESSION_TOKEN = `planted-session-${SUFFIX}`
const PLANTED_MAGIC_TOKEN = `planted-magic-${SUFFIX}`
const TARGET_DB = `backenly_recovery_target_${SUFFIX}`
const STORAGE_TEXT = `stored-before-the-bundle-${SUFFIX}`
const STORAGE_BYTES = Buffer.from([0, 1, 2, 253, 254, 255])

let sourceUrl = ''
let targetUrl = ''
let adminUrl = ''
/** The application role the restore replays as. Cluster-wide, so suffixed. */
const APP_ROLE = `recovery_app_${SUFFIX}`
const APP_PASSWORD = randomBytes(12).toString('hex')
let bundleDir = ''
let credential = ''
let progress: RestoreProgress
let projectId = ''
let userId = ''
let schemaName = ''
let sourceUserCount = 0
let sourceStorage = ''
let targetStorage = ''

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

async function onTarget<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: targetUrl })
  await client.connect()
  try {
    const result = await client.query(sql, params as never[])
    return result.rows as T[]
  } finally {
    await client.end()
  }
}

async function onAdmin(sql: string): Promise<void> {
  const client = new Client({ connectionString: sourceUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  sourceUrl = process.env.DATABASE_URL ?? ''
  const dbName = sourceUrl.split('/').pop()?.split('?')[0] ?? ''
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)

  const user = await prisma.user.create({
    data: { email: `recovery-restore-${SUFFIX}@example.test`, name: 'Recovery Restore Fixture' },
  })
  userId = user.id

  const project = await prisma.project.create({
    data: {
      name: `recovery-restore-${SUFFIX}`,
      userId,
      jwtSecret: PLANTED_JWT_SECRET,
      anonKey: PLANTED_ANON_KEY,
    },
  })
  projectId = project.id
  schemaName = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  // An ORDINARY table. Every table in this fixture used to be `_`-prefixed,
  // which made the grant assertion below meaningless once the restore started
  // reconciling: `_`-prefixed tables and `users` hold end-user credentials, and
  // backenly_pgrst_revoke_internal exists to strip anon/authenticated/
  // service_role from exactly those. So there was nothing left that SHOULD keep
  // its grants, and nothing to distinguish "grants survived" from "grants were
  // correctly removed".
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schemaName}"."notes" (id serial PRIMARY KEY, body text)`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."notes" (body) VALUES ('a row the data plane should serve')`,
  )
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_token_blacklist" (
      jti TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."_token_blacklist" (jti, expires_at)
     VALUES ($1, NOW() + INTERVAL '7 days')`,
    PLANTED_JTI,
  )
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_magic_links" (
      token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."_magic_links" (token, email, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    PLANTED_MAGIC_TOKEN,
    `recovery-restore-${SUFFIX}@example.test`,
  )
  // The grants scripts/setup-postgrest-roles.ts applies to a real workspace.
  // Without them the fixture would have no grants to lose, and "the grants
  // survived the trip" would pass against a schema that never had any.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE "${role}" NOLOGIN;
        END IF;
      END $$;`)
  }
  await prisma.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA "${schemaName}" TO anon, authenticated, service_role`,
  )
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schemaName}"
     TO authenticated, service_role`,
  )
  await prisma.$executeRawUnsafe(
    `GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon`,
  )

  await prisma.session.create({
    data: {
      userId,
      token: PLANTED_SESSION_TOKEN,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  })

  sourceUserCount = await prisma.user.count()

  bundleDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-restore-'))

  // Real files, so storage is proven rather than reported. An empty storage
  // directory would let the restore claim success while doing nothing.
  sourceStorage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-storage-src-'))
  await fs.promises.mkdir(path.join(sourceStorage, 'avatars'), { recursive: true })
  await fs.promises.writeFile(path.join(sourceStorage, 'readme.txt'), STORAGE_TEXT)
  await fs.promises.writeFile(path.join(sourceStorage, 'avatars', 'one.bin'), STORAGE_BYTES)

  const exported = await exportDeploymentBundle({
    outDir: bundleDir,
    storageDir: sourceStorage,
  })
  credential = exported.credential

  // The clean machine. Created empty, immediately before the restore.
  await onAdmin(`CREATE DATABASE "${TARGET_DB}"`)
  adminUrl = urlForDatabase(sourceUrl, TARGET_DB)

  // ── TWO connections, because a restore has two jobs ─────────────────────
  //
  // Admin provisions: dropping schemas, creating the PostgREST roles and
  // installing extensions are all elevation the application role must not have.
  // The application role REPLAYS, because pg_dump runs with --no-owner and psql
  // creates whatever it replays as the role it connected with - so ownership
  // follows this connection, and FORCE ROW LEVEL SECURITY keys on the owner.
  //
  // This used to hand the superuser to both jobs, which is why nobody noticed
  // that a real deployment's application role cannot drop `public` and that a
  // superuser replay leaves every table owned by the wrong role.
  await onAdmin(
    `CREATE ROLE "${APP_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ` +
      `PASSWORD '${APP_PASSWORD}'`,
  )
  await onAdmin(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${TARGET_DB}" TO "${APP_ROLE}"`)
  targetUrl = urlForDatabase(sourceUrl, TARGET_DB).replace(
    /\/\/[^@]+@/,
    `//${APP_ROLE}:${APP_PASSWORD}@`,
  )

  // A separate destination, so files cannot appear to restore by having been
  // there all along.
  targetStorage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-storage-dst-'))
  progress = await restoreDeployment({
    bundleDir,
    credential,
    adminUrl,
    targetUrl,
    appRole: APP_ROLE,
    storageDir: targetStorage,
  })
})

afterAll(async () => {
  if (schemaName) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  }
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  await onAdmin(`DROP OWNED BY "${APP_ROLE}" CASCADE`).catch(() => {})
  await onAdmin(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => {})
  if (targetUrl) {
    await onAdmin(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}'`,
    ).catch(() => {})
    await onAdmin(`DROP DATABASE IF EXISTS "${TARGET_DB}"`).catch(() => {})
  }
  for (const dir of [bundleDir, sourceStorage, targetStorage]) {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  await prisma.$disconnect().catch(() => {})
})

describe('the restore runs to completion', () => {
  test('every step in the contract order succeeded', () => {
    expect(progress.results.every(r => r.status === 'ok')).toBe(true)
    expect(progress.completed).toContain('verify-health-and-integrity')
  })

  test('verification is the last thing that happened', () => {
    // Success has to be a claim about the restored system, not about a process
    // exiting zero somewhere in the middle.
    expect(progress.completed[progress.completed.length - 1]).toBe('verify-health-and-integrity')
  })

  test('background systems were held off until then', () => {
    // Walked cumulatively over the steps that actually ran.
    const seen: typeof progress.completed = []
    for (const step of progress.completed) {
      if (step === 'verify-health-and-integrity') break
      seen.push(step)
      expect(runnableSubsystems(seen)).toEqual([])
    }
    expect(runnableSubsystems(progress.completed).length).toBeGreaterThan(0)
  })
})

describe('the clean machine now holds the deployment', () => {
  test('the platform schema is there', async () => {
    const rows = await onTarget<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public'`,
    )
    expect(Number(rows[0].count)).toBeGreaterThan(20)
  })

  test('every account came back', async () => {
    const rows = await onTarget<{ count: string }>('SELECT count(*)::text AS count FROM public.users')
    expect(Number(rows[0].count)).toBe(sourceUserCount)
  })

  test('the workspace schema came back', async () => {
    const rows = await onTarget<{ nspname: string }>(
      'SELECT nspname FROM pg_namespace WHERE nspname = $1',
      [schemaName],
    )
    expect(rows).toHaveLength(1)
  })
})

describe('durable credentials kept their value', () => {
  test('the project signing secret is byte-for-byte what it was', async () => {
    // The property that makes recovery worth doing. A deployment that came back
    // with a NEW signing secret would be technically restored and would reject
    // every token every client already holds.
    const rows = await onTarget<{ jwtSecret: string; anonKey: string }>(
      'SELECT "jwtSecret", "anonKey" FROM public.projects WHERE id = $1',
      [projectId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].jwtSecret).toBe(PLANTED_JWT_SECRET)
    expect(rows[0].anonKey).toBe(PLANTED_ANON_KEY)
  })

  test('the revoked token is still revoked', async () => {
    // Stateless JWTs are signed with the secret restored above, so without the
    // denylist every revoked token would verify again on the recovered machine.
    // This is the assertion that the fail-open hole is really closed.
    const rows = await onTarget<{ jti: string }>(
      `SELECT jti FROM "${schemaName}"."_token_blacklist" WHERE jti = $1`,
      [PLANTED_JTI],
    )
    expect(rows).toHaveLength(1)
  })
})

describe('ephemeral credentials did not come back', () => {
  test('the sessions table exists', async () => {
    // It has to. A deployment missing it cannot sign anybody in, which is why
    // the export drops the DATA and never the table.
    const rows = await onTarget<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sessions'`,
    )
    expect(Number(rows[0].count)).toBe(1)
  })

  test('and it is empty', async () => {
    const rows = await onTarget<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.sessions',
    )
    expect(Number(rows[0].count)).toBe(0)
  })

  test('the planted session is specifically gone', async () => {
    // Named, so this cannot pass by the table having been empty all along -
    // the source had this exact row when the bundle was written.
    const rows = await onTarget(
      'SELECT 1 FROM public.sessions WHERE token = $1',
      [PLANTED_SESSION_TOKEN],
    )
    expect(rows).toHaveLength(0)
  })

  test('the magic link table came back empty too', async () => {
    const exists = await onTarget<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = '_magic_links'`,
      [schemaName],
    )
    expect(Number(exists[0].count)).toBe(1)

    const rows = await onTarget(
      `SELECT 1 FROM "${schemaName}"."_magic_links" WHERE token = $1`,
      [PLANTED_MAGIC_TOKEN],
    )
    expect(rows).toHaveLength(0)
  })

  test('the source really held those rows when the bundle was written', async () => {
    // Without this the two assertions above would pass against a source that
    // never had them, which is the vacuous shape worth guarding against.
    expect(await prisma.session.count({ where: { token: PLANTED_SESSION_TOKEN } })).toBe(1)
    const magic = await prisma.$queryRawUnsafe<{ token: string }[]>(
      `SELECT token FROM "${schemaName}"."_magic_links" WHERE token = $1`,
      PLANTED_MAGIC_TOKEN,
    )
    expect(magic).toHaveLength(1)
  })
})

describe('the data plane can work on the recovered machine', () => {
  test('the PostgREST roles exist', async () => {
    // provision-database-roles-and-extensions runs first for this reason: the
    // workspace dump carries GRANTs naming these, and replaying them against a
    // database without them fails on the first GRANT.
    const rows = await onTarget<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,
    )
    expect(rows.map(r => r.rolname).sort()).toEqual(['anon', 'authenticated', 'service_role'])
  })

  test('the restored deployment remembers which role it is', async () => {
    // `public.backenly_app_role()` reads the database-level setting
    // `backenly.app_role`, and every ownership and grant decision in the
    // privileged SQL routes through it. pg_dump does NOT carry
    // `ALTER DATABASE ... SET`, so a restored deployment came back with the
    // setting absent and the function falling back to a role name that may not
    // exist on the target at all - CI restores onto a cluster whose superuser
    // is `postgres`, and reconciliation failed there with
    // `role "backenly_user" does not exist`.
    //
    // The silent case is worse than the error: where the fallback role happens
    // to exist, every future grant is aimed at the wrong one.
    const rows = await onTarget<{ role: string }>(`SELECT public.backenly_app_role() AS role`)
    expect(rows[0].role).toBe(APP_ROLE)
  })

  test('the workspace grants survived the trip', async () => {
    // Without these the restore looks complete and the data plane returns
    // nothing at all. Asserted on an ORDINARY table: the internal ones are
    // supposed to lose their grants, which the next test covers.
    const rows = await onTarget<{ grantee: string }>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND table_name = 'notes'
         AND grantee IN ('anon','authenticated','service_role')`,
      [schemaName],
    )
    expect(rows.map(r => r.grantee).sort()).toEqual(['anon', 'authenticated', 'service_role'])
  })

  test('the end-user credential tables did NOT keep theirs', async () => {
    // The half the old restore got wrong, and it got it wrong silently.
    //
    // The workspace dump carries the source's ACLs, and replaying them put
    // anon/authenticated/service_role back on `_token_blacklist` and
    // `_magic_links` - tables holding revoked JTIs and live magic links. A
    // fresh install revokes those through backenly_pgrst_revoke_internal, so
    // a restored deployment was strictly more exposed than an installed one.
    //
    // reconcile-derived-state now re-runs that revocation under the admin
    // connection, which is what closes it.
    const rows = await onTarget<{ table_name: string; grantee: string }>(
      `SELECT table_name, grantee FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND table_name LIKE '\\_%'
         AND grantee IN ('anon','authenticated','service_role')`,
      [schemaName],
    )
    expect(rows).toEqual([])
  })

  test('the source really had those grants, so the revocation is a change', async () => {
    // Paired, because "no grants on the internal tables" would be equally true
    // of a fixture that never granted any.
    const rows = await prisma.$queryRawUnsafe<{ grantee: string }[]>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND table_name = '_token_blacklist'
         AND grantee IN ('anon','authenticated','service_role')`,
      schemaName,
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  test('the source really had those grants to lose', async () => {
    // The other half. A grant assertion that passes because the source had none
    // either is the vacuous shape this whole suite keeps guarding against.
    const rows = await prisma.$queryRawUnsafe<{ grantee: string }[]>(
      `SELECT DISTINCT grantee FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND grantee IN ('anon','authenticated','service_role')`,
      schemaName,
    )
    expect(rows.map(r => r.grantee).sort()).toEqual(['anon', 'authenticated', 'service_role'])
  })
})

describe('storage objects made the trip', () => {
  test('the bundle recorded the files it carried', () => {
    const storage = progress.results.find(r => r.step === 'restore-storage-objects')
    expect(storage?.status).toBe('ok')
    expect(storage?.detail).toMatch(/2 objects/)
  })

  test('the files are on the recovered machine, byte for byte', async () => {
    // Into a destination created empty, so they cannot appear to have restored
    // by having been there all along.
    const text = await fs.promises.readFile(path.join(targetStorage, 'readme.txt'), 'utf8')
    expect(text).toBe(STORAGE_TEXT)

    const binary = await fs.promises.readFile(path.join(targetStorage, 'avatars', 'one.bin'))
    expect(binary.equals(STORAGE_BYTES)).toBe(true)
  })

  test('the restore would have refused to claim success without them', async () => {
    // The step used to return a cheerful string and do nothing, which is the
    // exact failure this tranche exists to rule out: a bundle carrying files
    // reporting a successful restore, with the files found missing much later.
    const entry = progress.results.find(r => r.step === 'restore-storage-objects')
    expect(entry?.detail).not.toMatch(/not implemented/i)
  })
})
