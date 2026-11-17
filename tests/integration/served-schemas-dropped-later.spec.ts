/**
 * A SCHEMA POSTGREST SERVES IS DROPPED ONLY AFTER POSTGREST STOPS READING IT
 * =========================================================================
 * Production QA (2026-11-16): ten requests a second through three merges. In
 * one, every request in 1.2 s answered 503 "The data plane is temporarily
 * unavailable." (PostgREST's PGRST002), starting as the merge ended; in
 * another, the builder's seed got the same 503 as the merge landed.
 *
 * A merge ends by dropping its branch's schema, right after unregistering it
 * from PostgREST. PostgREST 14.15 rebuilds its schema cache from the list it
 * read before the rebuild's catalog query, and a listed schema that no longer
 * exists fails the whole rebuild; it then answers 503 to every request until a
 * retry a second later (src/PostgREST/AppState.hs, retryingSchemaCacheLoad).
 * Deleting a project dropped its served schema the same way.
 *
 * Now a served schema stops being served at once and is dropped at least two
 * minutes later, by the pass every region runs each minute
 * (lib/postgrest/retire-schema.ts); a schema nothing serves goes at once. A
 * deleted project's logins cannot go before its schema (lib/projects/logins.ts):
 * they are retired with the deletion, unable to log in, and dropped by the pass.
 *
 * Which schemas PostgREST serves is the registry's answer (scripts/sql/
 * postgrest-schema-registry.sql), which the test database does not install:
 * here it is a set the registration seam reads and the unregister removes
 * from. retired-schemas-registry.spec.ts holds the step to the real registry.
 */

const mockServed = new Set<string>()
const mockUnregistered: string[] = []

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async (schema: string) => { mockServed.delete(schema); mockUnregistered.push(schema) },
    servedAmong: async (_db: unknown, schemas: string[]) => schemas.filter((s) => mockServed.has(s)),
    unregisterSchemaOn: async (_db: unknown, schema: string) => { mockServed.delete(schema); mockUnregistered.push(schema) },
  }
})

import crypto from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { HOME_REGION } from '@/lib/regions'
import { createProvisionedProject } from '@/lib/projects/provision'
import { deleteProjectCompletely } from '@/lib/projects/delete'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { createBranch, discardBranch, mergeBranch } from '@/lib/branches/engine'
import { applyBranchMigration } from '@/lib/branches/migrate'
import { DROP_AFTER_MS, RETIRED_SCHEMAS_JOB_TYPE, dropRetiredSchemas } from '@/lib/postgrest/retire-schema'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const run = crypto.randomBytes(4).toString('hex')
/** Another database on the cluster that names one of the deleted project's logins, as a restored copy would. */
const elsewhere = `backenly_named_${run}`
const urlOf = (database: string) => {
  const u = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '')
  u.pathname = `/${database}`
  return u.toString()
}

let ownerId = ''
let projectId = ''
let schema = ''

const exists = async (name: string) =>
  (await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, name))[0].n === 1

const loginStates = (logins: string[]) =>
  prisma.$queryRawUnsafe<Array<{ rolname: string; login: boolean; no_password: boolean }>>(
    `SELECT rolname::text AS rolname, rolcanlogin AS login, rolpassword IS NULL AS no_password
       FROM pg_authid WHERE rolname = ANY($1::text[]) ORDER BY rolname::text COLLATE "C"`,
    logins,
  )

async function waitingRows(name: string) {
  const rows = await prisma.backgroundJob.findMany({ where: { type: RETIRED_SCHEMAS_JOB_TYPE } })
  return rows.filter((r) => ((r.payload as any)?.schemas ?? []).includes(name))
}

/** A branch with one migration on it, served by PostgREST as a branch is once created. */
async function servedBranch(name: string) {
  const made: any = await createBranch(projectId, ownerId, name)
  if (!made.ok) throw new Error(`createBranch: ${made.error}`)
  const applied: any = await applyBranchMigration(projectId, made.branch.id, `CREATE TABLE ${name.replace(/-/g, '_')} (label text)`, ownerId)
  if (!applied.ok) throw new Error(`branch migration: ${JSON.stringify(applied)}`)
  mockServed.add(made.branch.schemaName)
  return made.branch as { id: string; schemaName: string }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `retire-${run}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'served-schemas-dropped-later', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  mockServed.add(schema)
}, 180_000)

afterAll(async () => {
  const left = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname = $1 OR nspname LIKE $2`, schema, `${schema}\\_%`,
  ).catch(() => [])
  for (const s of left) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.nspname}" CASCADE`).catch(() => {})
  if (projectId) {
    const { ro, rw } = directAccessRoleNames(projectId)
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${elsewhere} WITH (FORCE)`).catch(() => {})
    for (const login of [ro, rw, functionRoleName(schema)]) {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${login}"`).catch(() => {})
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${login}"`).catch(() => {})
    }
    await prisma.auditLog.deleteMany({ where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: projectId } } }).catch(() => {})
  }
  await prisma.backgroundJob
    .deleteMany({ where: { type: RETIRED_SCHEMAS_JOB_TYPE, payload: { path: ['projectId'], equals: projectId } } })
    .catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
}, 120_000)

describe('a merged branch', () => {
  let branch: { id: string; schemaName: string }
  let mergedAt = new Date()

  beforeAll(async () => {
    branch = await servedBranch('drops-later')
    mergedAt = new Date()
    const merged: any = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      mergeBranch(projectId, ownerId, branch.id))
    if (!merged.ok) throw new Error(`merge: ${JSON.stringify(merged)}`)
  }, 180_000)

  it('stops being served when the merge ends, and its schema stays for now', async () => {
    expect(mockUnregistered).toContain(branch.schemaName)
    expect(await exists(branch.schemaName)).toBe(true)
  })

  it('is dropped by the pass no sooner than two minutes after', async () => {
    const rows = await waitingRows(branch.schemaName)
    expect(rows).toHaveLength(1)
    expect((rows[0].payload as any).region).toBe(HOME_REGION)
    expect(rows[0].runAt.getTime()).toBeGreaterThanOrEqual(mergedAt.getTime() + DROP_AFTER_MS - 1_000)

    await dropRetiredSchemas(HOME_REGION, new Date())
    expect(await exists(branch.schemaName)).toBe(true)

    const out = await dropRetiredSchemas(HOME_REGION, new Date(Date.now() + DROP_AFTER_MS + 1_000))
    expect(out.dropped).toContain(branch.schemaName)
    expect(await exists(branch.schemaName)).toBe(false)
    expect((await prisma.backgroundJob.findUnique({ where: { id: rows[0].id } }))?.status).toBe('completed')
  })
})

describe('a discarded branch', () => {
  it('stops being served at once and is dropped by the later pass', async () => {
    const branch = await servedBranch('discarded-later')
    const out: any = await discardBranch(projectId, ownerId, branch.id)
    expect(out.ok).toBe(true)
    expect(mockServed.has(branch.schemaName)).toBe(false)
    expect(await exists(branch.schemaName)).toBe(true)

    await dropRetiredSchemas(HOME_REGION, new Date(Date.now() + DROP_AFTER_MS + 1_000))
    expect(await exists(branch.schemaName)).toBe(false)
  }, 180_000)

  it('is never dropped while it is served again, and goes once it is not', async () => {
    const branch = await servedBranch('served-again')
    await discardBranch(projectId, ownerId, branch.id)
    mockServed.add(branch.schemaName)

    const first = await dropRetiredSchemas(HOME_REGION, new Date(Date.now() + DROP_AFTER_MS + 1_000))
    expect(first.deferred).toContain(branch.schemaName)
    expect(await exists(branch.schemaName)).toBe(true)
    expect(mockServed.has(branch.schemaName)).toBe(false)

    await dropRetiredSchemas(HOME_REGION, new Date(Date.now() + 2 * DROP_AFTER_MS + 2_000))
    expect(await exists(branch.schemaName)).toBe(false)
  }, 180_000)
})

describe('a deleted project', () => {
  const vault = () => `${schema}_r1`
  let logins: string[] = []
  let ro = ''
  let deleted: Awaited<ReturnType<typeof deleteProjectCompletely>>

  beforeAll(async () => {
    // A change's vault, which PostgREST never serves.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${vault()}"`)
    // Its logins, each granted on its schema: direct access, and its functions'.
    ro = directAccessRoleNames(projectId).ro
    logins = [ro, directAccessRoleNames(projectId).rw, functionRoleName(schema)].sort()
    for (const login of logins) {
      await prisma.$executeRawUnsafe(`CREATE ROLE "${login}" LOGIN PASSWORD '${crypto.randomBytes(18).toString('hex')}'`)
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${login}"`)
    }
    // Named outside this database too, by a grant in another database.
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${elsewhere}`)
    const other = new Client({ connectionString: urlOf(elsewhere) })
    await other.connect()
    try {
      await other.query(`CREATE TABLE kept (id int)`)
      await other.query(`GRANT SELECT ON kept TO "${ro}"`)
    } finally {
      await other.end()
    }
    deleted = await deleteProjectCompletely(projectId)
  }, 180_000)

  it('stops serving its schema with the deletion, keeps it for now, and drops what nothing served', async () => {
    expect(mockUnregistered).toContain(schema)
    expect(await exists(schema)).toBe(true)
    expect(await exists(vault())).toBe(false)
    expect(deleted.schemasRetired).toEqual([schema])
    expect(deleted.schemasDropped).toEqual([vault()])
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
  })

  it('retires its logins with the deletion, unable to log in, for the pass to drop with the schema', async () => {
    expect([...deleted.loginsDroppedLater].sort()).toEqual(logins)
    expect(deleted.retiredLogins).toEqual([])
    expect(await loginStates(logins)).toEqual(logins.map((rolname) => ({ rolname, login: false, no_password: true })))
    const [row] = await waitingRows(schema)
    expect([...(row.payload as any).logins].sort()).toEqual(logins)
    expect((row.payload as any).via).toBe('project deletion')
  })

  it('drops the schema in the later pass, and the logins with it, retiring the one named outside its database', async () => {
    expect(await waitingRows(schema)).toHaveLength(1)
    const out = await dropRetiredSchemas(HOME_REGION, new Date(Date.now() + DROP_AFTER_MS + 1_000))

    expect(await exists(schema)).toBe(false)
    expect(out.loginsRetired).toEqual([ro])
    expect([...out.loginsDropped].sort()).toEqual(logins.filter((login) => login !== ro))
    expect(await loginStates(logins)).toEqual([{ rolname: ro, login: false, no_password: true }])
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: projectId } },
      select: { projectId: true, details: true },
    })
    expect(audit?.projectId).toBeNull()
    expect(JSON.parse(String(audit?.details))).toEqual({ projectId, region: HOME_REGION, logins: [ro], via: 'project deletion' })
  })
})
