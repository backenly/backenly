/**
 * A REAL BUNDLE, WRITTEN FROM A REAL DATABASE
 * ===========================================
 * The unit tests pin the arguments. This runs the exporter against Postgres and
 * reads what actually landed on disk, because the two things most likely to be
 * wrong cannot be seen from the arguments:
 *
 *   1. whether the encryption protects anything, and
 *   2. whether the tables the contract drops are actually empty in the dump.
 *
 * The central assertion is a matched pair. A known secret is planted in the
 * database, and then:
 *
 *   - it must appear NOWHERE in the bundle's raw bytes, and
 *   - it must appear once the bundle is opened with the credential.
 *
 * Either half alone proves nothing. A search that finds the secret nowhere
 * might be a search that never worked - wrong needle, wrong encoding, wrong
 * files. Only the second half establishes that the first half would have
 * noticed.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { prisma } from '@/lib/db/prisma'
import { exportDeploymentBundle, BUNDLE_FILES, MANIFEST_FILE } from '@/lib/recovery/export'
import { openBuffer, sha256, unwrapDataKey, RecoveryKeyError } from '@/lib/recovery/crypto'
import type { RecoveryManifest } from '@/lib/recovery/contract'

jest.setTimeout(600_000)

/**
 * Canaries, generated per run rather than written down.
 *
 * Fresh each time for two reasons. A literal in the source would be a
 * long constant assignment in a public repo, which the pre-commit secret
 * scanner is right to refuse on sight. And a fixed needle can be found in data
 * an earlier run left behind - a per-run value can only match what THIS run
 * planted, so a passing search is a search that really looked.
 */
const SUFFIX = randomBytes(6).toString('hex')
const PLANTED_JWT_SECRET = `planted-recovery-canary-${randomBytes(16).toString('hex')}`
const PLANTED_JTI = `planted-revoked-jti-${SUFFIX}`
const PLANTED_SESSION_TOKEN = `planted-session-token-${SUFFIX}`

let bundleDir = ''
let credential = ''
let manifest: RecoveryManifest
let projectId = ''
let userId = ''
let schemaName = ''

function assertSafeTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? ''
  const dbName = url.split('/').pop()?.split('?')[0] ?? ''
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

beforeAll(async () => {
  assertSafeTestDatabase()

  const user = await prisma.user.create({
    data: {
      email: `recovery-export-${SUFFIX}@example.test`,
      name: 'Recovery Export Fixture',
    },
  })
  userId = user.id

  const project = await prisma.project.create({
    data: {
      name: `recovery-export-${SUFFIX}`,
      userId,
      jwtSecret: PLANTED_JWT_SECRET,
      anonKey: `anon-${SUFFIX}`,
    },
  })
  projectId = project.id
  schemaName = `workspace_${projectId}`

  // A workspace schema with a revoked token in it. The denylist is the table
  // this tranche turned on, so the fixture has to actually contain one.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_token_blacklist" (
      jti TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."_token_blacklist" (jti, expires_at)
     VALUES ($1, NOW() + INTERVAL '7 days') ON CONFLICT (jti) DO NOTHING`,
    PLANTED_JTI,
  )

  // And a one-time credential that must NOT survive.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_magic_links" (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."_magic_links" (token, email, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour') ON CONFLICT (token) DO NOTHING`,
    `magic-${SUFFIX}`,
    `recovery-export-${SUFFIX}@example.test`,
  )

  // The grants scripts/setup-postgrest-roles.ts applies to a real workspace.
  //
  // Added after CI failed where a developer machine passed. Locally this
  // database holds dozens of workspace schemas from other work, some of them
  // properly granted, so a dump-wide search for GRANT found one belonging to a
  // DIFFERENT schema and the assertion passed for the wrong reason. On a fresh
  // CI database there was nothing to find. The fixture now creates what it
  // intends to assert, and the assertion names this schema.
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
    `GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon, authenticated, service_role`,
  )

  // A live session row. Without one, "the dump carries no session rows" would
  // pass against a database that simply had none - the shape of test that
  // passes while the thing it guards is broken.
  await prisma.session.create({
    data: {
      userId,
      token: PLANTED_SESSION_TOKEN,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  })

  bundleDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-recovery-'))
  const result = await exportDeploymentBundle({
    outDir: bundleDir,
    // No storage fixture; the component should record present-and-empty.
    storageDir: path.join(bundleDir, 'no-such-storage'),
  })
  credential = result.credential
  manifest = result.manifest
})

afterAll(async () => {
  if (schemaName) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  }
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  if (bundleDir) await fs.promises.rm(bundleDir, { recursive: true, force: true }).catch(() => {})
  await prisma.$disconnect().catch(() => {})
})

async function bundleFiles(): Promise<Array<{ name: string; bytes: Buffer }>> {
  const names = await fs.promises.readdir(bundleDir)
  return Promise.all(
    names.map(async name => ({
      name,
      bytes: await fs.promises.readFile(path.join(bundleDir, name)),
    })),
  )
}

async function openComponent(component: keyof typeof BUNDLE_FILES): Promise<string> {
  const dataKey = unwrapDataKey(manifest.wrappedDataKey!, credential)
  const sealed = await fs.promises.readFile(path.join(bundleDir, BUNDLE_FILES[component]))
  return openBuffer(sealed, dataKey).toString('utf8')
}

describe('the bundle that lands on disk', () => {
  test('writes a manifest and one file per component', async () => {
    const names = (await bundleFiles()).map(f => f.name).sort()
    expect(names).toContain(MANIFEST_FILE)
    for (const file of Object.values(BUNDLE_FILES)) {
      expect(names).toContain(file)
    }
  })

  test('every checksum matches the file as written', async () => {
    // This is what `validate-checksums` will rely on, and it runs before the
    // credential is needed - so it has to be over the sealed bytes.
    for (const entry of manifest.components) {
      const bytes = await fs.promises.readFile(path.join(bundleDir, entry.path))
      expect(sha256(bytes)).toBe(entry.sha256)
      expect(bytes.length).toBe(entry.bytes)
    }
  })

  test('records the deployment it came from', () => {
    expect(manifest.postgresVersion).toMatch(/^\d+/)
    expect(manifest.requiredExtensions.length).toBeGreaterThan(0)
    expect(manifest.formatVersion).toBe(1)
  })

  test('records present-and-empty for storage rather than omitting it', () => {
    // The distinction the ComponentEntry exists for: this deployment has no
    // files, which is different from a bundle that predates storage support.
    const storage = manifest.components.find(c => c.component === 'storage-objects')
    expect(storage).toBeDefined()
    expect(storage!.items).toBe(0)
  })
})

describe('the bundle is useless without the credential', () => {
  test('the planted secret appears NOWHERE in the raw bytes', async () => {
    // Every file, including the manifest. Checked as raw bytes rather than as
    // decoded text, so an accidental base64 or hex copy is caught too.
    const needles = [
      Buffer.from(PLANTED_JWT_SECRET, 'utf8'),
      Buffer.from(PLANTED_JWT_SECRET, 'utf8').toString('base64'),
      Buffer.from(PLANTED_JWT_SECRET, 'utf8').toString('hex'),
    ]
    for (const file of await bundleFiles()) {
      for (const needle of needles) {
        expect({ file: file.name, found: file.bytes.includes(needle as never) })
          .toEqual({ file: file.name, found: false })
      }
    }
  })

  test('and the credential itself is not in the bundle', async () => {
    for (const file of await bundleFiles()) {
      expect(file.bytes.includes(credential as never)).toBe(false)
    }
  })

  test('but IS there once opened, so the search above was real', async () => {
    // The half that makes the previous test mean something. Without it, a
    // broken search would read as a passing security property.
    const secrets = await openComponent('project-secrets')
    expect(secrets).toContain(PLANTED_JWT_SECRET)
  })

  test('the wrong credential opens nothing', async () => {
    expect(() => unwrapDataKey(manifest.wrappedDataKey!, 'WRONG-CREDENTIAL-ENTIRELY'))
      .toThrow(RecoveryKeyError)
  })
})

describe('what the dumps contain', () => {
  test('the platform dump carries the users table', async () => {
    const sql = await openComponent('platform-database')
    expect(sql).toMatch(/CREATE TABLE public\.users/)
  })

  test('it defines sessions but carries no session rows', async () => {
    // --exclude-table-data, not --exclude-table. The table must exist or a
    // restored deployment cannot sign anybody in; the rows must not.
    //
    // A live session is planted in beforeAll precisely so this cannot pass
    // against a database that happened to have none.
    const sql = await openComponent('platform-database')
    expect(sql).toMatch(/CREATE TABLE public\.sessions/)
    expect(sql).not.toContain(PLANTED_SESSION_TOKEN)
  })

  test('the planted session really was there to be excluded', async () => {
    // Proves the assertion above is about the exclusion working, not about an
    // empty table. If the fixture ever stops inserting, this fails rather than
    // letting the security assertion go quietly vacuous.
    const live = await prisma.session.count({ where: { token: PLANTED_SESSION_TOKEN } })
    expect(live).toBe(1)
  })

  test('the workspace dump keeps the revoked token', async () => {
    // Dropping this would silently un-revoke every revoked end-user JWT.
    const sql = await openComponent('workspace-schemas')
    expect(sql).toContain('_token_blacklist')
    expect(sql).toContain(PLANTED_JTI)
  })

  test('the workspace dump drops the magic link', async () => {
    const sql = await openComponent('workspace-schemas')
    expect(sql).toContain('_magic_links')
    expect(sql).not.toContain(`magic-${SUFFIX}`)
  })

  test('the workspace dump keeps the PostgREST grants', async () => {
    // Without these the restore looks complete and the data plane returns
    // nothing. The default privileges matter just as much: tables created after
    // the restore would otherwise be invisible to PostgREST too.
    //
    // Scoped to THIS schema. A dump-wide search for GRANT passes on any machine
    // that happens to hold another properly granted workspace, which is how
    // this assertion passed locally and failed in CI.
    const sql = await openComponent('workspace-schemas')
    const grants = sql
      .split('\n')
      .filter(line => line.startsWith('GRANT') && line.includes(schemaName))
    expect(grants.join('\n')).toMatch(/anon|authenticated|service_role/)
  })
})
