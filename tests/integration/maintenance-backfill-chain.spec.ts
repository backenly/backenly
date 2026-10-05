/**
 * A MAINTENANCE BACKFILL LONGER THAN ONE BATCH, ON A REAL ENGINE
 * ==============================================================
 *
 * `handleBackfillJob` runs one batch per job and queues the next batch as a new
 * job. The executor recorded only the first job of that chain and read only it,
 * and the first job completes with `done: false` as soon as a second batch
 * exists — so on any table longer than one batch (2,000 rows by default) the
 * ladder reported "awaiting background work" on every pass, forever, with the
 * backfill long finished.
 *
 * This drives the real handler through real BackgroundJob rows over 4,500 rows
 * and pins both halves: the first job alone still says "pending" (that is what
 * it truthfully says, and the defect was trusting it), and the chain, followed
 * by the rung's idempotency key, says "done" and names its last job.
 */

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/queue'
import { handleBackfillJob, type BackfillJobPayload } from '@/lib/autonomy/maintenance/primitives/backfill-job'
import { inspectBackfillChain, inspectBackgroundJob } from '@/lib/autonomy/maintenance/execute'

jest.setTimeout(300_000)

const PROJECT_ID = randomUUID()
const SCHEMA = `workspace_${PROJECT_ID}`
const ROWS = 4_500
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

beforeAll(async () => {
  await q(`CREATE SCHEMA "${SCHEMA}"`)
  await q(`CREATE TABLE "${SCHEMA}"."sessions" (id integer PRIMARY KEY, status text, state text)`)
  await q(`INSERT INTO "${SCHEMA}"."sessions" (id, status)
           SELECT i, CASE WHEN i % 3 = 0 THEN 'active' ELSE 'expired' END FROM generate_series(1, ${ROWS}) i`)
})

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { projectId: PROJECT_ID } }).catch(() => {})
  await q(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
})

/** The worker's loop, for this project's backfill jobs only. */
async function drain(): Promise<string[]> {
  const ran: string[] = []
  for (let i = 0; i < 20; i++) {
    const job = await prisma.backgroundJob.findFirst({
      where: { projectId: PROJECT_ID, type: 'maintenance_backfill', status: 'queued' },
      orderBy: { createdAt: 'asc' },
    })
    if (!job) break
    const result = await handleBackfillJob(job.payload as unknown as BackfillJobPayload)
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'completed', result: result as object, completedAt: new Date() },
    })
    ran.push(job.id)
  }
  return ran
}

const payload = (idempotencyKey: string): BackfillJobPayload => ({
  projectId: PROJECT_ID,
  planVersion: 'v1',
  idempotencyKey,
  table: 'sessions',
  sourceColumn: 'status',
  targetColumn: 'state',
  transform: { kind: 'identity' },
  cursor: null,
})

describe('a backfill chain longer than one batch', () => {
  const KEY = `chain-${randomUUID()}`
  let first = ''
  let jobs: string[] = []

  it('runs as three jobs over 4,500 rows', async () => {
    first = (await enqueue('maintenance_backfill', payload(KEY) as unknown as Record<string, unknown>, { projectId: PROJECT_ID })).id
    jobs = await drain()
    expect(jobs).toHaveLength(3)
    expect(jobs[0]).toBe(first)
    const missing = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${SCHEMA}"."sessions" WHERE state IS DISTINCT FROM status`,
    )
    expect(Number(missing[0].n)).toBe(0)
  })

  it('reads as pending from its first job alone — the defect was trusting that', async () => {
    expect((await inspectBackgroundJob(first)).state).toBe('pending')
  })

  it('reads as done from the chain, and names its last job', async () => {
    const r = await inspectBackfillChain(PROJECT_ID, KEY, first)
    expect(r.jobId).toBe(jobs[2])
    expect(r.progress.state).toBe('done')
    expect(r.progress.detail).toMatch(/backfill complete/)
  })

  it('is not confused by another rung\'s chain on the same project', async () => {
    const other = `other-${randomUUID()}`
    await enqueue('maintenance_backfill', payload(other) as unknown as Record<string, unknown>, { projectId: PROJECT_ID })
    // Queued and not yet run: the other chain is pending, this one is still done.
    expect((await inspectBackfillChain(PROJECT_ID, other, 'unused')).progress.state).toBe('pending')
    expect((await inspectBackfillChain(PROJECT_ID, KEY, first)).progress.state).toBe('done')
    await drain()
  })

  it('still reads a single-batch chain from its only job', async () => {
    const single = `single-${randomUUID()}`
    const job = await enqueue(
      'maintenance_backfill',
      { ...payload(single), batchRows: 10_000 } as unknown as Record<string, unknown>,
      { projectId: PROJECT_ID },
    )
    await drain()
    const r = await inspectBackfillChain(PROJECT_ID, single, job.id)
    expect(r).toMatchObject({ jobId: job.id, progress: { state: 'done' } })
  })
})
