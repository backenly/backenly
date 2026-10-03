/**
 * RESTORING OVER A DEPLOYMENT THAT IS ALREADY RUNNING
 * ===================================================
 * The clean-machine case is the one the product is FOR. This is the one that
 * can do damage, and it is where a backup product earns or loses its claim.
 *
 * Two properties, and the first matters more than the second:
 *
 *   A BAD ARCHIVE MUST LEAVE A LIVE DEPLOYMENT EXACTLY AS IT FOUND IT.
 *   lib/services/workspace-backup.ts restored by dropping the target schema and
 *   then reading the dump, so an unreadable dump destroyed a working schema and
 *   left nothing to go back to. The operator reached for a backup and lost the
 *   thing they still had. Everything below is arranged so that failure cannot
 *   be repeated quietly: a marker row is written into the live target, a
 *   deliberately broken bundle is offered, and the marker must still be there
 *   afterwards.
 *
 *   A GOOD ARCHIVE MUST REPLACE, NOT MERGE.
 *   A restore that left newer rows in place would produce a deployment that
 *   matches no point in time - not the bundle's and not the one before it - and
 *   nobody could say what state it was in.
 *
 * The tests run in declaration order, and that order is the scenario: diverge,
 * refuse, refuse again, then replace.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { exportDeploymentBundle } from '@/lib/recovery/export'
import { restoreDeployment, RestoreAbortedError } from '@/lib/recovery/restore'
import { RESTORE_ORDER } from '@/lib/recovery/contract'
import { MANIFEST_FILE } from '@/lib/recovery/export'

jest.setTimeout(900_000)

const SUFFIX = randomBytes(6).toString('hex')
const PLANTED_JWT_SECRET = `planted-durable-${randomBytes(16).toString('hex')}`
const DIVERGENT_PROJECT = `divergence-marker-${SUFFIX}`
const TARGET_DB = `backenly_destructive_${SUFFIX}`
const WEAK_ROLE = `recovery_weak_${SUFFIX}`
const WEAK_PASSWORD = randomBytes(12).toString('hex')

let sourceUrl = ''
let targetUrl = ''
let adminUrl = ''
/** The application role the restore replays as. Cluster-wide, so suffixed. */
const APP_ROLE = `recovery_app_${SUFFIX}`
const APP_PASSWORD = randomBytes(12).toString('hex')
let bundleDir = ''
let corruptDir = ''
let credential = ''
let projectId = ''
let userId = ''
let schemaName = ''

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

async function onTarget<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: targetUrl })
  await client.connect()
  try {
    return (await client.query(sql, params as never[])).rows as T[]
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

/** Is the marker written into the live target still there? */
async function divergenceSurvives(): Promise<boolean> {
  const rows = await onTarget('SELECT 1 FROM public.projects WHERE name = $1', [DIVERGENT_PROJECT])
  return rows.length === 1
}

beforeAll(async () => {
  sourceUrl = process.env.DATABASE_URL ?? ''
  const dbName = sourceUrl.split('/').pop()?.split('?')[0] ?? ''
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)

  const user = await prisma.user.create({
    data: { email: `recovery-destructive-${SUFFIX}@example.test`, name: 'Destructive Fixture' },
  })
  userId = user.id
  const project = await prisma.project.create({
    data: {
      name: `recovery-destructive-${SUFFIX}`,
      userId,
      jwtSecret: PLANTED_JWT_SECRET,
      anonKey: `anon-${SUFFIX}`,
    },
  })
  projectId = project.id
  schemaName = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schemaName}"."notes" (id serial primary key, body text)`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schemaName}"."notes" (body) VALUES ('from the bundle')`,
  )

  bundleDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-destructive-'))
  credential = (await exportDeploymentBundle({
    outDir: bundleDir,
    storageDir: path.join(bundleDir, 'no-such-storage'),
  })).credential

  // A copy of the same bundle with one byte flipped in a component file. Same
  // manifest, same checksums recorded, so only verification can catch it.
  corruptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-corrupt-'))
  for (const name of await fs.promises.readdir(bundleDir)) {
    await fs.promises.copyFile(path.join(bundleDir, name), path.join(corruptDir, name))
  }
  const victim = path.join(corruptDir, 'platform.sql.enc')
  const bytes = await fs.promises.readFile(victim)
  bytes[Math.floor(bytes.length / 2)] ^= 0xff
  await fs.promises.writeFile(victim, bytes)

  // Stand up a live deployment from the bundle, then let it diverge.
  await onAdmin(`CREATE DATABASE "${TARGET_DB}"`)
  adminUrl = urlForDatabase(sourceUrl, TARGET_DB)

  // TWO connections. Admin provisions - dropping schemas, creating roles and
  // installing extensions are elevation the application role must not have -
  // and the application role REPLAYS, because pg_dump runs with --no-owner so
  // ownership follows the connection, and FORCE RLS keys on the owner.
  await onAdmin(
    `CREATE ROLE "${APP_ROLE}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ` +
      `PASSWORD '${APP_PASSWORD}'`,
  )
  await onAdmin(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${TARGET_DB}" TO "${APP_ROLE}"`)
  targetUrl = urlForDatabase(sourceUrl, TARGET_DB).replace(
    /\/\/[^@]+@/,
    `//${APP_ROLE}:${APP_PASSWORD}@`,
  )

  await restoreDeployment({ bundleDir, credential, adminUrl, targetUrl, appRole: APP_ROLE })

  await onTarget(
    `INSERT INTO public.projects (id, name, "userId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, NOW(), NOW())`,
    [randomBytes(12).toString('hex'), DIVERGENT_PROJECT, userId],
  )
  await onTarget(`INSERT INTO "${schemaName}"."notes" (body) VALUES ('written after the bundle')`)

  // A role that can reach the database and do nothing else. Stands in for the
  // operator who ran the restore as the read-only backup credential.
  await onAdmin(`CREATE ROLE "${WEAK_ROLE}" LOGIN PASSWORD '${WEAK_PASSWORD}'`)
  await onAdmin(`GRANT CONNECT ON DATABASE "${TARGET_DB}" TO "${WEAK_ROLE}"`)
})

afterAll(async () => {
  if (schemaName) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  }
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
  if (targetUrl) {
    await onAdmin(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TARGET_DB}'`,
    ).catch(() => {})
    await onAdmin(`DROP DATABASE IF EXISTS "${TARGET_DB}"`).catch(() => {})
  }
  await onAdmin(`DROP ROLE IF EXISTS "${WEAK_ROLE}"`).catch(() => {})
  await onAdmin(`DROP OWNED BY "${APP_ROLE}" CASCADE`).catch(() => {})
  await onAdmin(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => {})
  for (const dir of [bundleDir, corruptDir]) {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  await prisma.$disconnect().catch(() => {})
})

describe('the live deployment has diverged from the bundle', () => {
  test('it holds state the bundle does not', async () => {
    // The setup for everything below. If this fails, the refusal tests would be
    // asserting the survival of something that was never there.
    expect(await divergenceSurvives()).toBe(true)
    const notes = await onTarget<{ body: string }>(`SELECT body FROM "${schemaName}"."notes"`)
    expect(notes.map(n => n.body).sort()).toEqual(['from the bundle', 'written after the bundle'])
  })
})

describe('a damaged archive does not get to touch it', () => {
  test('the restore refuses', async () => {
    await expect(restoreDeployment({ bundleDir: corruptDir, credential, adminUrl, targetUrl, appRole: APP_ROLE }))
      .rejects.toThrow(RestoreAbortedError)
  })

  test('and says the target was untouched', async () => {
    // Not a detail. This is what tells an operator whether they still have a
    // deployment or a problem.
    try {
      await restoreDeployment({ bundleDir: corruptDir, credential, adminUrl, targetUrl, appRole: APP_ROLE })
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreAbortedError)
      expect((err as RestoreAbortedError).targetUntouched).toBe(true)
    }
  })

  test('and the live deployment is exactly as it was', async () => {
    // The assertion this whole file exists for. A restore that had begun
    // dropping schemas before discovering the archive was unreadable would fail
    // here, and would have destroyed a working deployment in the process.
    expect(await divergenceSurvives()).toBe(true)
    const notes = await onTarget<{ body: string }>(`SELECT body FROM "${schemaName}"."notes"`)
    expect(notes).toHaveLength(2)
  })
})

describe('a wrong credential does not get to touch it either', () => {
  test('the restore refuses', async () => {
    await expect(
      restoreDeployment({
        bundleDir,
        credential: 'WRONG-CREDENTIAL-ENTIRELY',
        adminUrl,
        targetUrl,
        appRole: APP_ROLE,
      }),
    ).rejects.toThrow(RestoreAbortedError)
  })

  test('and the live deployment is still intact', async () => {
    // A credential is checked during validation rather than when the first
    // encrypted component is needed, precisely so this holds.
    expect(await divergenceSurvives()).toBe(true)
  })
})

describe('a credential without the privileges to restore', () => {
  test('the restore fails rather than half-finishing', async () => {
    // The operator ran it as the wrong role - the backup role, say, which is
    // deliberately read-only. That has to fail, and it has to fail in a way
    // that names the problem rather than surfacing a bare psql exit code.
    const weakUrl = urlForDatabase(sourceUrl, TARGET_DB).replace(
      /\/\/[^@]+@/,
      `//${WEAK_ROLE}:${WEAK_PASSWORD}@`,
    )
    await expect(
      restoreDeployment({ bundleDir, credential, adminUrl, targetUrl: weakUrl }),
    ).rejects.toThrow(RestoreAbortedError)
  })

  test('and the live deployment is still there', async () => {
    // The important half. A restore that lacked permission to finish must not
    // have had permission to start breaking things either.
    expect(await divergenceSurvives()).toBe(true)
  })

  test('the failure names a step, so an operator knows where it stopped', async () => {
    const weakUrl = urlForDatabase(sourceUrl, TARGET_DB).replace(
      /\/\/[^@]+@/,
      `//${WEAK_ROLE}:${WEAK_PASSWORD}@`,
    )
    try {
      await restoreDeployment({ bundleDir, credential, adminUrl, targetUrl: weakUrl })
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(RestoreAbortedError)
      expect(RESTORE_ORDER).toContain((err as RestoreAbortedError).step)

      // It now promises MORE than it used to, and the promise is the point:
      // the credentials are proven before the first destructive statement, so
      // a restore that cannot finish has not started. This assertion was
      // `false` when the check happened mid-restore.
      expect((err as RestoreAbortedError).targetUntouched).toBe(true)
      expect((err as RestoreAbortedError).message).toMatch(/Preflight refused/i)
    }
  })
})

describe('a good archive replaces the deployment rather than merging into it', () => {
  test('the restore succeeds over a live target', async () => {
    const progress = await restoreDeployment({ bundleDir, credential, adminUrl, targetUrl, appRole: APP_ROLE })
    expect(progress.completed).toContain('verify-health-and-integrity')
  })

  test('state written after the bundle is gone', async () => {
    // A restore that left it would produce a deployment matching no point in
    // time at all, and nobody could say what state it was in.
    expect(await divergenceSurvives()).toBe(false)
  })

  test('the workspace row written after the bundle is gone too', async () => {
    const notes = await onTarget<{ body: string }>(`SELECT body FROM "${schemaName}"."notes"`)
    expect(notes.map(n => n.body)).toEqual(['from the bundle'])
  })

  test('and what the bundle carried is back', async () => {
    const rows = await onTarget<{ jwtSecret: string }>(
      'SELECT "jwtSecret" FROM public.projects WHERE id = $1',
      [projectId],
    )
    expect(rows[0].jwtSecret).toBe(PLANTED_JWT_SECRET)
  })

  test('restoring the same bundle twice lands in the same place', async () => {
    // Idempotence is an operational property, not a theoretical one: an
    // interrupted restore gets re-run, and it must not matter how many times.
    await restoreDeployment({ bundleDir, credential, adminUrl, targetUrl, appRole: APP_ROLE })
    expect(await divergenceSurvives()).toBe(false)
    const notes = await onTarget<{ body: string }>(`SELECT body FROM "${schemaName}"."notes"`)
    expect(notes.map(n => n.body)).toEqual(['from the bundle'])
  })
})

describe('the manifest is what makes any of this checkable', () => {
  test('a bundle with no manifest is refused outright', async () => {
    const naked = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'backenly-naked-'))
    try {
      for (const name of await fs.promises.readdir(bundleDir)) {
        if (name === MANIFEST_FILE) continue
        await fs.promises.copyFile(path.join(bundleDir, name), path.join(naked, name))
      }
      await expect(restoreDeployment({ bundleDir: naked, credential, adminUrl, targetUrl, appRole: APP_ROLE }))
        .rejects.toThrow(/manifest/i)
      expect(await divergenceSurvives()).toBe(false)
    } finally {
      await fs.promises.rm(naked, { recursive: true, force: true }).catch(() => {})
    }
  })
})
