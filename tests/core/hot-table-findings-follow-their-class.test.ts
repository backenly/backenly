/**
 * HOT-TABLE FINDINGS FOLLOW THEIR CURRENT CLASS
 * ---------------------------------------------
 * A hot table's index waits for a person since #679 (lib/core/fix-classifier.ts),
 * but the infrastructure scan filed every hot-table finding `open`, with
 * `requiresApproval: false`, and refreshed only its details. No loop repairs an
 * open hot-table finding on its own, so a row raised before #679 stayed open,
 * listed as queued for Backenly's next pass, six days later (production QA,
 * 2026-11-16). Each scan now files and refreshes a hot-table row with the
 * status of its class: waiting for a person when its column was measured, open
 * for the coding agent when it was not.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { runAndStoreInfraIntelligence } from '@/lib/ai/infra-intelligence'

let userId: string
let projectId: string
let schema: string
let pool: Pool

const rows = (type: string) => prisma.healthFinding.findMany({ where: { projectId, type, status: { in: ['open', 'pending_approval'] } } })

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `hot-class-${Date.now()}@example.test`, password: 'x', name: 'hot' } })).id
  projectId = (await prisma.project.create({ data: { name: 'hot-class', userId } })).id
  schema = `workspace_${projectId}`
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

  await pool.query(`CREATE SCHEMA "${schema}"`)
  // Hot, with a measured filter column: read 160 times by `kind = $1`.
  await pool.query(`CREATE TABLE "${schema}".events (id serial PRIMARY KEY, kind text)`)
  await pool.query(`INSERT INTO "${schema}".events (kind) SELECT 'k' || (i % 50) FROM generate_series(1, 2000) i`)
  // Hot, with nothing to measure: read 160 times with no filter.
  await pool.query(`CREATE TABLE "${schema}".visits (id serial PRIMARY KEY, page text)`)
  await pool.query(`INSERT INTO "${schema}".visits (page) SELECT '/p/' || i FROM generate_series(1, 2000) i`)
  await pool.query(`ANALYZE "${schema}".events, "${schema}".visits`)
  const client = await pool.connect()
  try {
    for (let i = 0; i < 160; i++) {
      await client.query(`SELECT count(*) FROM "${schema}".events WHERE kind = $1`, [`k${i % 50}`])
      await client.query(`SELECT count(*) FROM "${schema}".visits`)
    }
    await client.query('SELECT pg_stat_force_next_flush()')
    await client.query('SELECT 1')
  } finally {
    client.release()
  }

  // A row raised while hot tables were repaired on their own: open, no approval.
  await prisma.healthFinding.create({
    data: {
      projectId, type: 'infra_hot_table_events', severity: 'warning', status: 'open', autoFixed: false,
      details: { title: 'Hot table: events', table: 'events', tableName: 'events', columnName: 'kind', requiresApproval: false },
    },
  })
}, 120_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.platformNotification.deleteMany({ where: { projectId } }).catch(() => {})
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool.end()
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('a scan of hot tables', () => {
  test('moves an existing open row whose index waits for a person to Waiting on you', async () => {
    await runAndStoreInfraIntelligence(projectId, userId)
    const events = await rows('infra_hot_table_events')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('pending_approval')
    expect((events[0].details as Record<string, unknown>).requiresApproval).toBe(true)
  }, 60_000)

  test('files a hot table with nothing measured open, for the coding agent', async () => {
    const visits = await rows('infra_hot_table_visits')
    expect(visits).toHaveLength(1)
    expect(visits[0].status).toBe('open')
    expect((visits[0].details as Record<string, unknown>).columnName).toBeNull()
  })

  test('files a new hot table with a measured column waiting for a person', async () => {
    await prisma.healthFinding.deleteMany({ where: { projectId, type: 'infra_hot_table_events' } })
    await runAndStoreInfraIntelligence(projectId, userId)
    const events = await rows('infra_hot_table_events')
    expect(events.map((e) => e.status)).toEqual(['pending_approval'])
  }, 60_000)

  test('never files a second row for a table already waiting for a person', async () => {
    await runAndStoreInfraIntelligence(projectId, userId)
    expect(await rows('infra_hot_table_events')).toHaveLength(1)
  }, 60_000)
})
