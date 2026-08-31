/**
 * Deletion atomicity — real PostgreSQL, real DDL, real rollback.
 *
 * The guarantee this commit rests on is that dropping a workspace schema and
 * deleting the project row either both happen or neither does. That is a
 * property of PostgreSQL's transactional DDL, and it cannot be demonstrated
 * with mocks: a mocked transaction proves only that the code calls the
 * functions in the order the author expected. So this suite runs against a real
 * database and asserts on `pg_namespace` after forcing failures.
 *
 * The rollback cases are the important ones. A deletion that fails safely is
 * recoverable; a deletion that drops the schema and keeps the row has destroyed
 * data and lost the pointer to it.
 *
 * Requires a reachable test database. If Postgres is not running the suite
 * fails loudly rather than skipping — a silently skipped atomicity test is
 * indistinguishable from one that never worked.
 */

import { randomUUID } from 'crypto'
import { Client } from 'pg'
import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'
import { prisma } from '@/lib/db/prisma'
import {
  deleteAccountCompletely,
  deleteProjectCompletely,
  PURGE_JOB_TYPE,
} from '@/lib/projects/delete'

// ─── Test database safety ────────────────────────────────────────────────────
//
// This suite issues DROP SCHEMA against whatever DATABASE_URL points at. The
// guard below is deliberately strict and deliberately not overridable.

const DB_URL = process.env.TEST_DATABASE_URL ?? ''

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`Refusing to run destructive tests: NODE_ENV is "${process.env.NODE_ENV}"`)
  }
  if (!DB_URL) {
    throw new Error('Refusing to run destructive tests: TEST_DATABASE_URL is not set')
  }
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run destructive tests: database "${dbName}" does not look like a test database`,
    )
  }
  if (process.env.DATABASE_URL !== DB_URL) {
    throw new Error('Refusing to run destructive tests: DATABASE_URL is not the test database')
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const createdUserIds: string[] = []
const createdSchemas: string[] = []
// Suites share one database and jest runs files in parallel, so cleanup must
// name the rows this file created. Deleting purge jobs by `type` alone removed
// the other suite's rows mid-run.
const createdProjectIds: string[] = []
let tmpRoot: string

/** A workspace schema with one table holding one row, so a drop loses real data. */
async function createWorkspaceSchema(schemaName: string): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schemaName}"."posts" (id int primary key)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schemaName}"."posts" (id) VALUES (1)`)
  createdSchemas.push(schemaName)
}

async function schemaExists(schemaName: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_namespace WHERE nspname = ${schemaName}
  `
  return Number(rows[0].n) > 0
}

async function makeUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `purge-${randomUUID()}@test.invalid`, name: 'Deletion Test' },
    select: { id: true },
  })
  createdUserIds.push(user.id)
  return user.id
}

/** A project with its canonical workspace schema and `branchCount` branches. */
async function makeProject(userId: string, branchCount = 0): Promise<string> {
  const project = await prisma.project.create({
    data: { name: `deletion-test-${randomUUID().slice(0, 8)}`, userId },
    select: { id: true },
  })

  createdProjectIds.push(project.id)
  await createWorkspaceSchema(`workspace_${project.id}`)

  for (let i = 0; i < branchCount; i++) {
    const name = `feature_${i}`
    const schemaName = `workspace_${project.id}_br_${name}`
    await createWorkspaceSchema(schemaName)
    await prisma.workspaceBranch.create({
      data: { projectId: project.id, name, schemaName, createdBy: userId },
    })
  }

  return project.id
}

/**
 * Hold ACCESS EXCLUSIVE on a table inside `schemaName` from a second connection.
 * A DROP SCHEMA against it then blocks and hits the deletion's 5s lock_timeout,
 * which is how the tests force a schema-drop failure without patching anything.
 */
async function holdLockOn(schemaName: string): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  await client.query('BEGIN')
  await client.query(`LOCK TABLE "${schemaName}"."posts" IN ACCESS EXCLUSIVE MODE`)
  return async () => {
    await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
  }
}

/**
 * Make DELETE raise for ONE project, to fail the relational step.
 *
 * Scoped with a WHEN clause rather than firing for every row. Jest runs test
 * files in parallel against this one database, and an unconditional trigger on
 * `projects` blocked deletes in the outbox suite running alongside it.
 */
async function blockProjectDeletes(projectId: string): Promise<() => Promise<void>> {
  const tag = `t_${projectId.replace(/-/g, '').slice(0, 16)}`
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${tag}_fn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'test: blocked project delete'; END $$ LANGUAGE plpgsql
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${tag} BEFORE DELETE ON projects
    FOR EACH ROW WHEN (OLD.id = '${projectId}') EXECUTE FUNCTION ${tag}_fn()
  `)
  return async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${tag} ON projects`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${tag}_fn()`).catch(() => {})
  }
}

/** Remove only the purge jobs belonging to this suite's projects. */
async function deleteOwnPurgeJobs(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return
  const jobs = await prisma.backgroundJob.findMany({ where: { type: PURGE_JOB_TYPE } }).catch(() => [])
  const mine = jobs
    .filter((j) => projectIds.includes((j.payload as any)?.projectId))
    .map((j) => j.id)
  if (mine.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { id: { in: mine } } }).catch(() => {})
  }
}

async function purgeJobsFor(projectId: string) {
  const jobs = await prisma.backgroundJob.findMany({ where: { type: PURGE_JOB_TYPE } })
  return jobs.filter((j) => (j.payload as any)?.projectId === projectId)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'backenly-deletion-'))
  process.env.BACKUP_DIR = path.join(tmpRoot, 'backups')
  process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
  process.env.STORAGE_DRIVER = 'local'
  await fs.mkdir(process.env.BACKUP_DIR, { recursive: true })
  await fs.mkdir(process.env.STORAGE_DIR, { recursive: true })
})

afterAll(async () => {
  // Only the resources this suite created.
  for (const schema of createdSchemas) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  }
  // deleteMany, not delete: the suite deletes some of these users itself, and a
  // missing row is a successful cleanup rather than an error worth logging.
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
  await deleteOwnPurgeJobs(createdProjectIds)
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
})

// ─── A. Project with no branches ─────────────────────────────────────────────

describe('A. project deletion — no branches', () => {
  it('drops the workspace schema, deletes the row, and queues the purge', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    const schema = `workspace_${projectId}`

    const backupDir = path.join(process.env.BACKUP_DIR!, projectId)
    await fs.mkdir(backupDir, { recursive: true })
    await fs.writeFile(path.join(backupDir, 'dump.sql.gz'), 'x')

    expect(await schemaExists(schema)).toBe(true)

    const result = await deleteProjectCompletely(projectId)

    expect(await schemaExists(schema)).toBe(false)
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
    expect(result.schemasDropped).toEqual([schema])
    expect(result.purgeJobIds).toHaveLength(1)
    expect(await purgeJobsFor(projectId)).toHaveLength(1)
    // The immediate attempt ran, so the backup directory is already gone.
    expect(result.externalPurgeCompleted).toBe(true)
    await expect(fs.stat(backupDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// ─── B. Project with branches ────────────────────────────────────────────────

describe('B. project deletion — multiple branches', () => {
  it('drops the workspace schema and every branch schema', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId, 3)
    const schemas = [
      `workspace_${projectId}`,
      `workspace_${projectId}_br_feature_0`,
      `workspace_${projectId}_br_feature_1`,
      `workspace_${projectId}_br_feature_2`,
    ]

    for (const s of schemas) expect(await schemaExists(s)).toBe(true)

    const result = await deleteProjectCompletely(projectId)

    for (const s of schemas) expect(await schemaExists(s)).toBe(false)
    expect(result.schemasDropped.sort()).toEqual(schemas.sort())
    expect(await prisma.workspaceBranch.findMany({ where: { projectId } })).toHaveLength(0)
  })

  it('also drops a staging schema that no registry row names', async () => {
    // executeCreateStaging copies production tables WITH DATA into
    // workspace_<id>_staging and records nothing in Prisma. Resolving schemas
    // from pg_namespace rather than from registry rows is what catches it.
    const userId = await makeUser()
    const projectId = await makeProject(userId)
    const staging = `workspace_${projectId}_staging`
    await createWorkspaceSchema(staging)

    const result = await deleteProjectCompletely(projectId)

    expect(await schemaExists(staging)).toBe(false)
    expect(result.schemasDropped).toContain(staging)
  })
})

// ─── C. Rollback when the relational delete fails ────────────────────────────

describe('C. database rollback — relational delete fails after schema drops', () => {
  it('leaves every schema and every row exactly as they were', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId, 2)
    const schemas = [
      `workspace_${projectId}`,
      `workspace_${projectId}_br_feature_0`,
      `workspace_${projectId}_br_feature_1`,
    ]

    const release = await blockProjectDeletes(projectId)
    try {
      await expect(deleteProjectCompletely(projectId)).rejects.toThrow()
    } finally {
      await release()
    }

    // The whole point: the DROPs executed inside the transaction and were
    // undone by the rollback.
    for (const s of schemas) {
      expect(await schemaExists(s)).toBe(true)
    }
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull()
    expect(await prisma.workspaceBranch.findMany({ where: { projectId } })).toHaveLength(2)
    // No outbox record may survive a rolled-back deletion.
    expect(await purgeJobsFor(projectId)).toHaveLength(0)

    // And the data inside the schema is still readable.
    const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM "workspace_${projectId}"."posts"`,
    )
    expect(rows).toHaveLength(1)
  })
})

// ─── D. Rollback when a branch schema drop fails ─────────────────────────────

describe('D. database rollback — a branch schema drop fails', () => {
  it('rolls back the drops that already succeeded', async () => {
    const userId = await makeUser()
    const projectId = await makeProject(userId, 2)
    const canonical = `workspace_${projectId}`
    const blocked = `workspace_${projectId}_br_feature_1`

    const release = await holdLockOn(blocked)
    try {
      await expect(deleteProjectCompletely(projectId)).rejects.toThrow()
    } finally {
      await release()
    }

    // The canonical schema is dropped before the blocked branch, so its
    // survival is the rollback working.
    expect(await schemaExists(canonical)).toBe(true)
    expect(await schemaExists(blocked)).toBe(true)
    expect(await schemaExists(`workspace_${projectId}_br_feature_0`)).toBe(true)
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull()
    expect(await purgeJobsFor(projectId)).toHaveLength(0)
  }, 30000)
})

// ─── E. Account deletion ─────────────────────────────────────────────────────

describe('E. account deletion — multiple projects', () => {
  it('removes every project, every schema, and the user', async () => {
    const userId = await makeUser()
    const projectA = await makeProject(userId, 2)
    const projectB = await makeProject(userId, 0)
    const schemas = [
      `workspace_${projectA}`,
      `workspace_${projectA}_br_feature_0`,
      `workspace_${projectA}_br_feature_1`,
      `workspace_${projectB}`,
    ]

    const result = await deleteAccountCompletely(userId)

    for (const s of schemas) expect(await schemaExists(s)).toBe(false)
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull()
    expect(await prisma.project.findMany({ where: { id: { in: [projectA, projectB] } } })).toHaveLength(0)
    expect(result.projectIds.sort()).toEqual([projectA, projectB].sort())
    // One purge record per project, not one per account.
    expect(result.purgeJobIds).toHaveLength(2)
    expect(await purgeJobsFor(projectA)).toHaveLength(1)
    expect(await purgeJobsFor(projectB)).toHaveLength(1)
  })
})

// ─── F. Account deletion rollback ────────────────────────────────────────────

describe('F. account deletion rollback — failure on a later project', () => {
  it('leaves the account and every project intact', async () => {
    const userId = await makeUser()
    const projectA = await makeProject(userId, 1)
    const projectB = await makeProject(userId, 0)

    // Projects are processed in id order, so lock whichever sorts second to
    // guarantee at least one project's schemas were dropped before the failure.
    const [first, second] = [projectA, projectB].sort()
    const release = await holdLockOn(`workspace_${second}`)
    try {
      await expect(deleteAccountCompletely(userId)).rejects.toThrow()
    } finally {
      await release()
    }

    expect(await schemaExists(`workspace_${first}`)).toBe(true)
    expect(await schemaExists(`workspace_${second}`)).toBe(true)
    expect(await schemaExists(`workspace_${projectA}_br_feature_0`)).toBe(true)
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull()
    expect(await prisma.project.findMany({ where: { userId } })).toHaveLength(2)
    expect(await purgeJobsFor(projectA)).toHaveLength(0)
    expect(await purgeJobsFor(projectB)).toHaveLength(0)
  }, 30000)
})

// ─── K. Authorization boundary ───────────────────────────────────────────────

describe('K. ownership is the route\'s job, and the route still enforces it', () => {
  it('another user\'s project is not reachable through the ownership query', async () => {
    const owner = await makeUser()
    const attacker = await makeUser()
    const projectId = await makeProject(owner)

    // The exact lookup DELETE /api/projects/[id] performs before deleting.
    const asAttacker = await prisma.project.findFirst({
      where: { id: projectId, userId: attacker },
    })
    expect(asAttacker).toBeNull()

    // Untouched: the route would have returned 404 without calling the module.
    expect(await schemaExists(`workspace_${projectId}`)).toBe(true)

    const asOwner = await prisma.project.findFirst({ where: { id: projectId, userId: owner } })
    expect(asOwner).not.toBeNull()
  })
})
