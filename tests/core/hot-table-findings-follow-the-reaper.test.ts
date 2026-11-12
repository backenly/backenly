/**
 * HOT-TABLE FINDINGS FOLLOW THE REAPER'S RULES
 * --------------------------------------------
 * lib/core/finding-reaper.ts holds the rules for findings Backenly withdraws:
 * a withdrawal is `dismissed` with `withdrawnBy`, read as a condition that
 * cleared and never as a repair (lib/autonomy/resolution.ts), and a finding a
 * person dismissed is never raised again. The infrastructure scan's hot-table
 * findings followed none of them:
 *   - a table that cooled down was marked `resolved`, a status no surface
 *     classifies, so it vanished from what Backenly says happened;
 *   - findings were deduplicated against open rows only, so one a person
 *     dismissed was raised again on the next pass, a minute later;
 *   - a hot-table read that failed returned [], read as "no hot tables", and
 *     withdrew every hot-table finding the project had.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { detectHotTables, runAndStoreInfraIntelligence } from '@/lib/ai/infra-intelligence'
import { closureOf } from '@/lib/autonomy/resolution'

let userId: string
let projectId: string
let schema: string
let pool: Pool

const openRows = (type: string) => prisma.healthFinding.findMany({ where: { projectId, type, status: 'open' } })

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `hot-reaper-${Date.now()}@example.test`, password: 'x', name: 'hot' } })).id
  projectId = (await prisma.project.create({ data: { name: 'hot-reaper', userId } })).id
  schema = `workspace_${projectId}`
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

  await pool.query(`CREATE SCHEMA "${schema}"`)
  // Hot: 2,000 rows read 160 times by a filter no index serves.
  await pool.query(`CREATE TABLE "${schema}".events (id serial PRIMARY KEY, kind text)`)
  await pool.query(`INSERT INTO "${schema}".events (kind) SELECT 'k' || (i % 50) FROM generate_series(1, 2000) i`)
  await pool.query(`CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text)`)
  await pool.query(`ANALYZE "${schema}".events, "${schema}".notes`)
  const client = await pool.connect()
  try {
    for (let i = 0; i < 160; i++) await client.query(`SELECT count(*) FROM "${schema}".events WHERE kind = $1`, [`k${i % 50}`])
    // Statistics reach shared memory when the backend flushes them; ask for it now.
    await client.query('SELECT pg_stat_force_next_flush()')
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}, 120_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.platformNotification.deleteMany({ where: { projectId } }).catch(() => {})
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool.end()
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('a hot table', () => {
  test('is raised while it is hot', async () => {
    await runAndStoreInfraIntelligence(projectId, userId)
    expect(await openRows('infra_hot_table_events')).toHaveLength(1)
  }, 60_000)

  test('a person dismissed is not raised again while it is still hot', async () => {
    const [row] = await openRows('infra_hot_table_events')
    // As the health route records a dismissal.
    await prisma.healthFinding.update({
      where: { id: row.id },
      data: { status: 'dismissed', details: { ...(row.details as object), dismissedAt: new Date().toISOString() } },
    })
    await runAndStoreInfraIntelligence(projectId, userId)
    expect(await openRows('infra_hot_table_events')).toHaveLength(0)
  }, 60_000)

  test('Backenly withdrew may come back while it is hot again', async () => {
    const dismissed = await prisma.healthFinding.findFirstOrThrow({ where: { projectId, type: 'infra_hot_table_events', status: 'dismissed' } })
    await prisma.healthFinding.update({
      where: { id: dismissed.id },
      data: { details: { ...(dismissed.details as object), dismissedAt: undefined, withdrawnBy: 'infra_reaper' } },
    })
    await runAndStoreInfraIntelligence(projectId, userId)
    expect(await openRows('infra_hot_table_events')).toHaveLength(1)
  }, 60_000)

  test('that has cooled down is withdrawn as a condition that cleared, never as resolved', async () => {
    const stale = await prisma.healthFinding.create({
      data: {
        projectId, type: 'infra_hot_table_notes', severity: 'warning', status: 'open', autoFixed: false,
        details: { title: 'Hot table: notes', table: 'notes', tableName: 'notes' },
      },
    })
    await runAndStoreInfraIntelligence(projectId, userId)
    const after = await prisma.healthFinding.findUniqueOrThrow({ where: { id: stale.id } })
    expect(after.status).toBe('dismissed')
    expect(closureOf(after)).toBe('condition_cleared')
  }, 60_000)
})

describe('a hot-table read that fails', () => {
  test('rejects, rather than reading as "no hot tables"', async () => {
    const broken = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: '-c statement_timeout=not-a-number' })
    await expect(detectHotTables(broken, schema)).rejects.toBeTruthy()
    await broken.end()
  })
})
