/**
 * The outbox: what happens after the database transaction commits.
 *
 * Once the commit lands, the schemas and rows are gone and cannot come back.
 * Everything from that instant on is about making sure the files follow, even
 * if this process dies. That responsibility sits in a BackgroundJob row written
 * inside the transaction, so it commits atomically with the deletion.
 *
 * These tests use a real database for the deletion and the job row, and stub
 * only the filesystem-facing purge, because the behaviour under test is the
 * retry contract rather than the file removal (covered in purge-safety).
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

const mockPurge = jest.fn()

jest.mock('@/lib/projects/purge', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/projects/purge'),
  purgeProjectExternals: (projectId: string, options?: unknown) => mockPurge(projectId, options),
}))

// Required after the mock so the module under test picks it up.
const { deleteProjectCompletely, deleteAccountCompletely, PURGE_JOB_TYPE } = require('@/lib/projects/delete')
const { processBackgroundJobs, processPurgeJobs } = require('@/lib/queue/worker')
const { PURGE_STATUS, claimNextJobs } = require('@/lib/queue')

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const createdUserIds: string[] = []
const createdSchemas: string[] = []
// See the note in deletion-transaction.test.ts: cleanup is scoped to this
// file's own projects because the suites run in parallel against one database.
const createdProjectIds: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function makeProjectWithSchema(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `outbox-${randomUUID()}@test.invalid`, name: 'Outbox Test' },
    select: { id: true },
  })
  createdUserIds.push(user.id)

  const project = await prisma.project.create({
    data: { name: `outbox-${randomUUID().slice(0, 8)}`, userId: user.id },
    select: { id: true },
  })
  createdProjectIds.push(project.id)
  const schema = `workspace_${project.id}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  createdSchemas.push(schema)
  return project.id
}

async function purgeJobFor(projectId: string) {
  const jobs = await prisma.backgroundJob.findMany({ where: { type: PURGE_JOB_TYPE } })
  return jobs.find((j) => (j.payload as any)?.projectId === projectId) ?? null
}

beforeAll(() => {
  assertSafeTestDatabase()
})

beforeEach(() => {
  mockPurge.mockReset()
})

afterAll(async () => {
  for (const schema of createdSchemas) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  }
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
  const jobs = await prisma.backgroundJob.findMany({ where: { type: PURGE_JOB_TYPE } }).catch(() => [])
  const mine = jobs
    .filter((j: any) => createdProjectIds.includes(j.payload?.projectId))
    .map((j: any) => j.id)
  if (mine.length > 0) {
    await prisma.backgroundJob.deleteMany({ where: { id: { in: mine } } }).catch(() => {})
  }
})

// ─── G. External purge fails after the commit ────────────────────────────────

describe('G. external purge failure after commit', () => {
  it('keeps the deletion committed and leaves the job retryable', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('EACCES: permission denied'))

    const result = await deleteProjectCompletely(projectId)

    // The database half committed and must not be undone by a file failure.
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_namespace WHERE nspname = ${`workspace_${projectId}`}
    `
    expect(Number(rows[0].n)).toBe(0)

    // The caller is told, and the work survives as a queued job.
    expect(result.externalPurgeCompleted).toBe(false)
    const job = await purgeJobFor(projectId)
    expect(job).not.toBeNull()
    expect(job!.status).toBe(PURGE_STATUS.pending)
    expect(job!.attempts).toBe(0)
  })

  it('records a sanitized failure and backs off when the worker also fails', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('EACCES: permission denied'))
    await deleteProjectCompletely(projectId)

    await processPurgeJobs()

    const job = await purgeJobFor(projectId)
    expect(job!.attempts).toBe(1)
    // Requeued rather than abandoned, with a later runAt from the backoff table.
    expect(job!.status).toBe(PURGE_STATUS.pending)
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now())
    expect(job!.error).toContain('EACCES')
  })
})

// ─── H. Retry succeeds ───────────────────────────────────────────────────────

describe('H. retry', () => {
  it('completes the job when a later attempt succeeds', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValueOnce(new Error('transient'))
    await deleteProjectCompletely(projectId)

    let job = await purgeJobFor(projectId)
    expect(job!.status).toBe(PURGE_STATUS.pending)

    // The worker only claims jobs whose runAt has passed; the immediate attempt
    // failed before any backoff was applied, so this one is already due.
    mockPurge.mockResolvedValue({
      projectId,
      backups: 'purged',
      storage: 'purged',
      objectsDeleted: 0,
    })
    await processPurgeJobs()

    job = await purgeJobFor(projectId)
    expect(job!.status).toBe('completed')
    expect(job!.completedAt).not.toBeNull()
    expect((job!.result as any).backups).toBe('purged')
  })

  it('is safe to run the worker again after completion', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockResolvedValue({
      projectId,
      backups: 'alreadyAbsent',
      storage: 'alreadyAbsent',
      objectsDeleted: 0,
    })
    await deleteProjectCompletely(projectId)

    const before = await purgeJobFor(projectId)
    expect(before!.status).toBe('completed')

    // A completed job is not claimable, so a second sweep must not touch it.
    const callsBefore = mockPurge.mock.calls.length
    await processPurgeJobs()

    const after = await purgeJobFor(projectId)
    expect(after!.status).toBe('completed')
    expect(after!.attempts).toBe(before!.attempts)
    expect(mockPurge.mock.calls.length).toBe(callsBefore)
  })
})

// ─── Outbox record shape ─────────────────────────────────────────────────────

describe('outbox record', () => {
  it('carries only the project id, and no user or path data', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockResolvedValue({ projectId, backups: 'alreadyAbsent', storage: 'alreadyAbsent', objectsDeleted: 0 })
    await deleteProjectCompletely(projectId)

    const job = await purgeJobFor(projectId)
    const payload = job!.payload as any

    // The project id names the target; storageDriver names which backend held
    // the files. Nothing else: no email, no absolute path, no credentials.
    expect(Object.keys(payload).sort()).toEqual(['projectId', 'storageDriver'])
    expect(payload.projectId).toBe(projectId)
    expect(['local', 's3']).toContain(payload.storageDriver)
    const serialized = JSON.stringify(payload).toLowerCase()
    for (const forbidden of ['@', '/', '\\', 'password', 'secret', 'token', 'bucket']) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(job!.projectId).toBeNull()
  })

  it('does not survive a rolled-back deletion', async () => {
    // Belt and braces alongside the transaction suite: the job row is written
    // inside the same transaction as the drops, so it cannot outlive a failure.
    const projectId = await makeProjectWithSchema()
    mockPurge.mockResolvedValue({ projectId, backups: 'alreadyAbsent', storage: 'alreadyAbsent', objectsDeleted: 0 })

    // Scoped to this project: an unconditional trigger on `projects` would
    // block deletes in the suite running in parallel against this database.
    const tag = `o_${projectId.replace(/-/g, '').slice(0, 16)}`
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${tag}_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test: blocked'; END $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${tag} BEFORE DELETE ON projects
      FOR EACH ROW WHEN (OLD.id = '${projectId}') EXECUTE FUNCTION ${tag}_fn()
    `)
    try {
      await expect(deleteProjectCompletely(projectId)).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${tag} ON projects`).catch(() => {})
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${tag}_fn()`).catch(() => {})
    }

    expect(await purgeJobFor(projectId)).toBeNull()
    expect(mockPurge).not.toHaveBeenCalled()
  })
})

// ─── Rollback to a released worker that has no purge handler ─────────────────

describe('rollback safety — a worker without a purge handler', () => {
  /**
   * Simulates the deployed worker exactly: it claims by status='queued' and its
   * switch has no purge_project case, so it completes unknown types with
   * { skipped: true }. If a purge job were ever visible to it, the instruction
   * to delete a customer's backups would be marked done with the files still
   * on disk, and nothing would ever look at them again.
   */
  async function releasedWorkerSweep(): Promise<string[]> {
    const claimed = await claimNextJobs(10)
    const consumed: string[] = []
    for (const job of claimed) {
      // The released switch: email / webhook_delivery / cleanup, then default.
      if (!['email', 'webhook_delivery', 'cleanup'].includes(job.type)) {
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            result: { skipped: true, reason: `No handler for job type '${job.type}'` },
          },
        })
        consumed.push(job.id)
      }
    }
    return consumed
  }

  it('cannot see, claim, or consume a pending purge job', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('immediate attempt failed'))
    await deleteProjectCompletely(projectId)

    const before = await purgeJobFor(projectId)
    expect(before!.status).toBe(PURGE_STATUS.pending)

    // Roll back: the old worker runs, repeatedly.
    const consumed = await releasedWorkerSweep()
    await releasedWorkerSweep()
    await releasedWorkerSweep()

    expect(consumed).not.toContain(before!.id)

    const after = await purgeJobFor(projectId)
    expect(after).not.toBeNull()
    expect(after!.status).toBe(PURGE_STATUS.pending)
    expect(after!.completedAt).toBeNull()
    expect(after!.attempts).toBe(0)
  })

  it('survives the released timeout sweep and the released pruner', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('immediate attempt failed'))
    await deleteProjectCompletely(projectId)
    const job = await purgeJobFor(projectId)

    // detectAndTimeoutStuckJobs: status='running' AND timeoutAt <= now
    const timedOut = await prisma.backgroundJob.findMany({
      where: { status: 'running', timeoutAt: { lte: new Date() } },
      select: { id: true },
    })
    expect(timedOut.map((j) => j.id)).not.toContain(job!.id)

    // prune-background-jobs: status IN ('completed','failed')
    const prunable = await prisma.backgroundJob.findMany({
      where: { status: { in: ['completed', 'failed'] } },
      select: { id: true },
    })
    expect(prunable.map((j) => j.id)).not.toContain(job!.id)

    // handleCleanupJob dead-letter sweep: status='dead_letter'
    const deadLettered = await prisma.backgroundJob.findMany({
      where: { status: 'dead_letter' },
      select: { id: true },
    })
    expect(deadLettered.map((j) => j.id)).not.toContain(job!.id)
  })

  it('is still completable by the new worker after the rollback ends', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('immediate attempt failed'))
    await deleteProjectCompletely(projectId)

    // Time passes under the old release.
    await releasedWorkerSweep()
    await releasedWorkerSweep()

    // Upgrade again: the new worker finds the instruction intact and finishes it.
    mockPurge.mockReset()
    mockPurge.mockResolvedValue({
      projectId,
      backups: 'purged',
      storage: 'purged',
      objectsDeleted: 3,
    })
    await processPurgeJobs()

    const done = await purgeJobFor(projectId)
    expect(done!.status).toBe('completed')
    expect((done!.result as any).backups).toBe('purged')
    expect(mockPurge).toHaveBeenCalledWith(projectId, expect.objectContaining({ storageDriver: expect.any(String) }))
  })

  it('parks an exhausted purge outside every auto-pruned status', async () => {
    const projectId = await makeProjectWithSchema()
    mockPurge.mockRejectedValue(new Error('EACCES'))
    await deleteProjectCompletely(projectId)

    // Burn every attempt.
    for (let i = 0; i < 6; i++) {
      await prisma.backgroundJob.updateMany({
        where: { type: PURGE_JOB_TYPE, status: PURGE_STATUS.pending },
        data: { runAt: new Date(Date.now() - 1000) },
      })
      await processPurgeJobs()
    }

    const job = await purgeJobFor(projectId)
    // Not dead_letter and not failed: both are swept on a timer, and the files
    // are still on disk, so the row has to outlive the sweepers.
    expect(job!.status).toBe(PURGE_STATUS.failed)
    expect(['dead_letter', 'failed', 'completed']).not.toContain(job!.status)
  })
})

// ─── Cascade immunity ────────────────────────────────────────────────────────

describe('purge jobs survive every cascade', () => {
  it('has no foreign key to project, user, or organization', async () => {
    const fks = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM information_schema.table_constraints
      WHERE table_name = 'background_jobs' AND constraint_type = 'FOREIGN KEY'
    `
    // Structural proof: nothing can cascade into this table from anywhere.
    expect(Number(fks[0].n)).toBe(0)
  })

  it('outlives account deletion, which cascades projects and the user', async () => {
    const user = await prisma.user.create({
      data: { email: `cascade-${randomUUID()}@test.invalid`, name: 'Cascade Test' },
      select: { id: true },
    })
    createdUserIds.push(user.id)

    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const project = await prisma.project.create({
        data: { name: `cascade-${randomUUID().slice(0, 8)}`, userId: user.id },
        select: { id: true },
      })
      createdProjectIds.push(project.id)
      ids.push(project.id)
      const schema = `workspace_${project.id}`
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
      createdSchemas.push(schema)
    }

    mockPurge.mockRejectedValue(new Error('deferred so the jobs stay pending'))
    await deleteAccountCompletely(user.id)

    // The user row and both project rows are gone.
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull()
    expect(await prisma.project.findMany({ where: { id: { in: ids } } })).toHaveLength(0)

    // The instructions to delete their files are not.
    for (const projectId of ids) {
      const job = await purgeJobFor(projectId)
      expect(job).not.toBeNull()
      expect(job!.status).toBe(PURGE_STATUS.pending)
    }
  })
})
