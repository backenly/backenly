/**
 * CONNECTION HEALTH — attributable to one tenant, or not reported at all
 * -----------------------------------------------------------------------
 * The previous check counted every connection to the database, compared it to
 * max_connections, and filed the result as a per-PROJECT finding. On a shared
 * cluster that is one platform fact told to every tenant at once, about a
 * resource none of them control.
 *
 * What IS attributable is a session opened with the project's own direct-access
 * roles (bkn_ro_<hex> / bkn_rw_<hex> / bkn_own_<hex>, derived from the project
 * id). These pin two things:
 *
 *   1. the query only ever sees this project's roles — a neighbouring tenant's
 *      forgotten psql window must never appear in this project's queue
 *   2. the finding is gated on DURATION, because every transaction is briefly
 *      idle-in-transaction between statements and this probe runs every minute
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Client, Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import {
  detectIdleInTransaction,
  IDLE_TX_QUERY,
  IDLE_TX_MIN_SECONDS,
} from '@/lib/autonomy/connection-health'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { classifyFix } from '@/lib/core/fix-classifier'
import { deriveTier } from '@/lib/autonomy/desired-state'
import { getManualRemediationHint, hasExecutableFix, buildFixAction } from '@/lib/core/fix-actions'

let userId: string
let projectId: string
let neighbourId: string
let roles: ReturnType<typeof directAccessRoleNames>
let neighbourRoles: ReturnType<typeof directAccessRoleNames>
let leaker: Client | null = null
let neighbourLeaker: Client | null = null
let pool: Pool

const PASSWORD = 'conn_health_test_pw'

const clientFor = (role: string) => {
  const url = new URL(process.env.DATABASE_URL!)
  return new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: role,
    password: PASSWORD,
  })
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `conn-health-${Date.now()}@example.test`, password: 'x', name: 'conn' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'conn-health-test', userId } })
  projectId = project.id
  roles = directAccessRoleNames(projectId)

  const neighbour = await prisma.project.create({ data: { name: 'conn-health-neighbour', userId } })
  neighbourId = neighbour.id
  neighbourRoles = directAccessRoleNames(neighbourId)

  for (const r of [roles.rw, neighbourRoles.rw]) {
    await prisma.$executeRawUnsafe(`CREATE ROLE "${r}" LOGIN PASSWORD '${PASSWORD}'`)
  }

  // Two sessions that ran BEGIN and stopped: one for this project, one for a
  // different project on the same cluster.
  leaker = clientFor(roles.rw)
  await leaker.connect()
  await leaker.query('BEGIN')
  await leaker.query('SELECT 1')

  neighbourLeaker = clientFor(neighbourRoles.rw)
  await neighbourLeaker.connect()
  await neighbourLeaker.query('BEGIN')
  await neighbourLeaker.query('SELECT 1')

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
}, 60_000)

afterAll(async () => {
  for (const c of [leaker, neighbourLeaker]) {
    if (c) {
      await c.query('ROLLBACK').catch(() => {})
      await c.end().catch(() => {})
    }
  }
  await pool?.end().catch(() => {})
  for (const r of [roles?.rw, neighbourRoles?.rw].filter(Boolean)) {
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${r}"`).catch(() => {})
  }
  await prisma.project.deleteMany({ where: { id: { in: [projectId, neighbourId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('tenant attribution', () => {
  test('sees this project’s own idle-in-transaction session', async () => {
    // Threshold 0 so the duration gate is not what is under test here.
    const { rows } = await pool.query(IDLE_TX_QUERY, [[roles.ro, roles.rw, roles.owner], 0])
    expect(rows).toHaveLength(1)
    expect(rows[0].usename).toBe(roles.rw)
    expect(Number(rows[0].sessions)).toBe(1)
  })

  test('never sees a different project’s session', async () => {
    // The failure this replaced: one cluster-wide number filed against every
    // tenant. A neighbour's forgotten psql window is not this owner's problem
    // and must not appear in their queue.
    const { rows } = await pool.query(IDLE_TX_QUERY, [[roles.ro, roles.rw, roles.owner], 0])
    expect(rows.map((r: any) => r.usename)).not.toContain(neighbourRoles.rw)
  })

  test('never sees the platform’s own pooled connections', async () => {
    const { rows } = await pool.query(IDLE_TX_QUERY, [['postgres', 'backenly_user'], 0])
    // The platform's work is request-scoped and commits in milliseconds; if this
    // ever returns rows, something in the app is leaking a transaction.
    expect(rows).toEqual([])
  })
})

describe('duration gate', () => {
  test('a transaction that just started is not a finding', async () => {
    // Every transaction is briefly idle-in-transaction between statements, and
    // this probe runs every minute. Without the gate that is a permanent
    // flapping finding on every healthy project using direct access.
    expect(await detectIdleInTransaction(projectId)).toEqual([])
  })

  test('the gate is minutes, not seconds', () => {
    expect(IDLE_TX_MIN_SECONDS).toBeGreaterThanOrEqual(60)
  })
})

describe('routing', () => {
  const details = {
    sessions: 2,
    maxIdleSeconds: 1800,
    location: 'direct-connection',
  }

  test('is notify_only — the remedy is in a session Backenly does not own', () => {
    expect(classifyFix('idle_in_transaction', details).decision).toBe('notify_only')
    expect(deriveTier('idle_in_transaction', details)).toBe(3)
  })

  test('offers no button, because terminating a backend discards unseen work', () => {
    expect(buildFixAction('idle_in_transaction', details)).toBeNull()
    expect(hasExecutableFix('idle_in_transaction', details)).toBe(false)
  })

  test('the hint hands over the query that finds the session', () => {
    const hint = getManualRemediationHint('idle_in_transaction', details)!
    expect(hint).toMatch(/pg_stat_activity/)
    expect(hint).toMatch(/30 minutes/)
    expect(hint).toMatch(/will not terminate it for you/i)
  })
})
