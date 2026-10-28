/**
 * REGIONAL JOBS: WORK ONE REGION ASKS OF ANOTHER
 * ==============================================
 * The console, MCP and the agent run in the home region; a project kept
 * elsewhere has its snapshots taken and restored there (lib/queue/index.ts,
 * regional jobs). These pin the queue those requests travel through, against a
 * real database:
 *
 *   - no generic worker can claim one, so a released build can never complete
 *     it without a handler or run it in the wrong region;
 *   - each region claims its own, chosen in the query;
 *   - a run past its timeout counts as an attempt, so a slow restore is never
 *     started twice without anyone deciding to;
 *   - what a failure records is the platform's own sentence, never the
 *     database's, which can quote the project's rows.
 *
 * The snapshot functions are stubbed: what they do in a region is pinned in
 * tests/integration/project-region.spec.ts.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

const mockBackup = jest.fn()
const mockRestore = jest.fn()
const mockServing = jest.fn()

jest.mock('@/lib/services/workspace-backup', () => ({
  backupWorkspace: (...args: unknown[]) => mockBackup(...args),
  restoreWorkspace: (...args: unknown[]) => mockRestore(...args),
}))
jest.mock('@/lib/projects/serving-state', () => ({
  getProjectServingState: (...args: unknown[]) => mockServing(...args),
}))

const { REGIONAL_STATUS, claimNextJobs, claimRegionalJobs, enqueueRegionalJob, failRegionalJob, regionalJobsOf } =
  require('@/lib/queue')
const { processRegionalJobs } = require('@/lib/queue/worker')

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const created: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/** A queued job for a project that need not exist: the queue has no foreign key to projects. */
async function job(type: 'workspace_backup' | 'workspace_restore', region: string, maxAttempts?: number): Promise<{ id: string; projectId: string }> {
  const projectId = randomUUID()
  const { id } = await enqueueRegionalJob(type, projectId, region, type === 'workspace_restore' ? { backupId: 'b1', requestedBy: 'u_owner' } : {}, { maxAttempts })
  created.push(id)
  return { id, projectId }
}
const row = (id: string) => prisma.backgroundJob.findUnique({ where: { id } })

beforeAll(() => assertSafeTestDatabase())

beforeEach(() => {
  mockBackup.mockReset()
  mockRestore.mockReset()
  mockServing.mockReset().mockResolvedValue({ kind: 'active' })
})

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { id: { in: created } } }).catch(() => {})
})

describe('a regional job', () => {
  it('is out of every generic worker’s reach', async () => {
    const { id } = await job('workspace_backup', 'eu-central-1')
    expect((await row(id))?.status).toBe(REGIONAL_STATUS.pending)

    // The generic claim, this build's and every released one: status 'queued'.
    const generic = await claimNextJobs(10)
    expect(generic.map((j: { id: string }) => j.id)).not.toContain(id)
    expect((await row(id))?.status).toBe(REGIONAL_STATUS.pending)
  })

  it('is claimed by its own region and by no other', async () => {
    const { id } = await job('workspace_backup', 'eu-central-1')
    expect((await claimRegionalJobs(5, 'ap-southeast-1')).map((j: { id: string }) => j.id)).not.toContain(id)
    expect((await claimRegionalJobs(5, 'eu-central-1')).map((j: { id: string }) => j.id)).toContain(id)
    expect((await row(id))?.status).toBe(REGIONAL_STATUS.running)
  })

  it('counts a run past its timeout as an attempt, and fails once none are left', async () => {
    const twice = await job('workspace_backup', 'us-west-2', 2)
    const once = await job('workspace_restore', 'us-west-2', 1)
    const past = new Date(Date.now() - 60_000)
    await prisma.backgroundJob.updateMany({
      where: { id: { in: [twice.id, once.id] } },
      data: { status: REGIONAL_STATUS.running, startedAt: past, timeoutAt: past },
    })

    await claimRegionalJobs(0, 'us-west-2')

    expect(await row(twice.id)).toMatchObject({ status: REGIONAL_STATUS.pending, attempts: 1 })
    expect(await row(once.id)).toMatchObject({ status: REGIONAL_STATUS.failed, attempts: 1, error: 'Timed out in its region.' })
  })

  it('backs off after a failed attempt and fails for good after the last', async () => {
    const { id } = await job('workspace_backup', 'us-west-2', 2)
    await failRegionalJob(id, 'first')
    const retried = await row(id)
    expect(retried).toMatchObject({ status: REGIONAL_STATUS.pending, attempts: 1, error: 'first' })
    expect(retried!.runAt.getTime()).toBeGreaterThan(Date.now())
    await failRegionalJob(id, 'second')
    expect(await row(id)).toMatchObject({ status: REGIONAL_STATUS.failed, attempts: 2, error: 'second' })
  })
})

describe('processing a region’s jobs', () => {
  it('takes the snapshot asked for, and records what it took', async () => {
    const { id, projectId } = await job('workspace_backup', 'ap-southeast-1')
    mockBackup.mockResolvedValue({ success: true, filename: 'snap.sql.gz', sizeBytes: BigInt(2048), projectId, createdAt: 'now' })

    expect(await processRegionalJobs('ap-southeast-1')).toMatchObject({ processed: 1, succeeded: 1 })

    expect(mockBackup).toHaveBeenCalledWith(projectId)
    expect(await row(id)).toMatchObject({ status: 'completed', result: { filename: 'snap.sql.gz', sizeBytes: 2048 } })
  })

  it('restores from the snapshot named, once, for the person who asked', async () => {
    const { id, projectId } = await job('workspace_restore', 'ap-southeast-1', 1)
    mockRestore.mockResolvedValue({ success: true, restoredFrom: 'snap.sql.gz' })

    await processRegionalJobs('ap-southeast-1')

    // The person rides along, so the restore is theirs in the project's history.
    expect(mockRestore).toHaveBeenCalledWith(projectId, 'b1', 'u_owner')
    expect(await row(id)).toMatchObject({ status: 'completed', result: { restoredFrom: 'snap.sql.gz' } })
  })

  it('records its own sentence for a failure, never what the database said', async () => {
    const { id } = await job('workspace_restore', 'ap-southeast-1', 1)
    mockRestore.mockResolvedValue({ success: false, error: 'psql: ERROR: Key (email)=(alice@example.com) already exists' })

    expect(await processRegionalJobs('ap-southeast-1')).toMatchObject({ processed: 1, failed: 1 })

    const failed = await row(id)
    expect(failed).toMatchObject({ status: REGIONAL_STATUS.failed })
    expect(failed!.error).toBe("The restore did not complete in ap-southeast-1. The reason is in that region's logs.")
    expect(JSON.stringify(await regionalJobsOf(failed!.projectId!))).not.toContain('alice@example.com')
  })

  it('does not restore a project paused since it was asked, and says why', async () => {
    const { id } = await job('workspace_restore', 'ap-southeast-1', 1)
    mockServing.mockResolvedValue({ kind: 'paused' })

    await processRegionalJobs('ap-southeast-1')

    expect(mockRestore).not.toHaveBeenCalled()
    expect(await row(id)).toMatchObject({
      status: REGIONAL_STATUS.failed,
      error: 'This project is paused. Resume it before restoring a snapshot.',
    })
  })

  it('lists a project’s jobs with their region and not their payload', async () => {
    const { projectId } = await job('workspace_backup', 'us-west-2')
    const [listed] = await regionalJobsOf(projectId)
    expect(listed).toMatchObject({ type: 'workspace_backup', status: REGIONAL_STATUS.pending, region: 'us-west-2' })
    expect(listed).not.toHaveProperty('payload')
  })
})
