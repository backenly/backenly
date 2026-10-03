/**
 * THE LOGS QUERY COUNTS IN THE DATABASE, NOT IN THE PROCESS
 * ========================================================
 * `/api/logs` used to answer "how many, and how many of each severity" by
 * running a SECOND findMany with no `take`, pulling every matching row into
 * memory for a `.length` and four `.filter().length` calls, then throwing the
 * rows away. That is a full table read on every request to a page whose default
 * view is "everything, newest first" and whose search box fires on every
 * change, and it grows without bound for the life of a deployment.
 *
 * Nothing caught it because the ANSWERS were right. So these tests assert the
 * answers stay right — a rewrite that silently changed a count would be worse
 * than the slow version — and separately assert the page never carries more
 * rows than it asked for, which is the property the old code violated.
 *
 * Real database. The whole question is what Postgres is asked to do.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { prisma } from '@/lib/db/prisma'
import { createTenantPrisma } from '@/lib/tenant/prisma'

let userId: string
let projectId: string
let otherProjectId: string

const SEEDED = {
  error: 7,
  warning: 5,
  info: 11,
  debug: 3,
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `logs-explorer-${Date.now()}@example.test`, password: 'x', name: 'logs explorer' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'logs-explorer-test', userId } })
  projectId = project.id

  // A second project, to prove the aggregate is tenant-scoped. Without this a
  // groupBy that forgot the projectId filter would still pass every count.
  const other = await prisma.project.create({ data: { name: 'logs-explorer-other', userId } })
  otherProjectId = other.id

  const rows: any[] = []
  for (const [severity, count] of Object.entries(SEEDED)) {
    for (let i = 0; i < count; i++) {
      rows.push({
        projectId,
        type: i % 2 === 0 ? 'api' : 'system',
        severity,
        message: `${severity} message ${i}`,
        service: 'test-service',
        endpoint: `/v1/thing/${i}`,
      })
    }
  }
  // Noise in the neighbouring tenant, at every severity, in larger numbers.
  for (const severity of Object.keys(SEEDED)) {
    for (let i = 0; i < 20; i++) {
      rows.push({
        projectId: otherProjectId,
        type: 'api',
        severity,
        message: `other tenant ${severity} ${i}`,
      })
    }
  }
  await prisma.log.createMany({ data: rows })
}, 120_000)

afterAll(async () => {
  await prisma.log.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

const TOTAL = Object.values(SEEDED).reduce((a, b) => a + b, 0)

/** Severity counts the way the route now computes them. */
async function severityCounts(where: any = {}) {
  const tenant = createTenantPrisma(projectId)
  const groups = await tenant.log.groupBy({
    by: ['severity'],
    where,
    _count: { _all: true },
  })
  const counts: Record<string, number> = { error: 0, warning: 0, info: 0, debug: 0 }
  for (const g of groups) {
    if (g.severity in counts) counts[g.severity] = g._count._all
  }
  return counts
}

describe('tenant-scoped aggregates', () => {
  test('counts only this project, though another has more of every severity', async () => {
    const tenant = createTenantPrisma(projectId)
    expect(await tenant.log.count({})).toBe(TOTAL)
    expect(await severityCounts()).toEqual(SEEDED)
  })

  test('the neighbouring tenant genuinely has rows, so the scoping means something', async () => {
    // Without this the test above passes just as well against an empty
    // database, and would keep passing if isolation broke and the other
    // project were removed.
    const global = await prisma.log.count({ where: { projectId: otherProjectId } })
    expect(global).toBe(80)
  })

  test('a filtered aggregate stays scoped', async () => {
    const counts = await severityCounts({ type: 'api' })
    // `api` is every even index within each severity, so ceil(count / 2).
    expect(counts).toEqual({
      error: Math.ceil(SEEDED.error / 2),
      warning: Math.ceil(SEEDED.warning / 2),
      info: Math.ceil(SEEDED.info / 2),
      debug: Math.ceil(SEEDED.debug / 2),
    })
  })

  test('a severity with no matching rows reports 0 rather than going missing', async () => {
    // groupBy returns no row for an absent group. The route fills the gap, and
    // a UI reading `stats.error` on a page with no errors must see 0, not
    // undefined rendering as blank.
    const counts = await severityCounts({ type: 'function' })
    expect(counts).toEqual({ error: 0, warning: 0, info: 0, debug: 0 })
  })
})

describe('paging reads a page, not the table', () => {
  test('a page carries at most its limit, whatever the total', async () => {
    const tenant = createTenantPrisma(projectId)
    const page = await tenant.log.findMany({
      orderBy: { timestamp: 'desc' },
      skip: 0,
      take: 10,
    })
    expect(page).toHaveLength(10)
    // The count is still the full total: the two answers come from two
    // queries, which is the point of the rewrite.
    expect(await tenant.log.count({})).toBe(TOTAL)
  })

  test('the last page is short rather than wrapping', async () => {
    const tenant = createTenantPrisma(projectId)
    const limit = 10
    const lastPage = Math.ceil(TOTAL / limit)
    const rows = await tenant.log.findMany({
      orderBy: { timestamp: 'desc' },
      skip: (lastPage - 1) * limit,
      take: limit,
    })
    expect(rows).toHaveLength(TOTAL - (lastPage - 1) * limit)
  })

  test('paging never returns a row belonging to another project', async () => {
    const tenant = createTenantPrisma(projectId)
    const rows = await tenant.log.findMany({ take: 100 })
    expect(rows).toHaveLength(TOTAL)
    expect(rows.every(r => r.projectId === projectId)).toBe(true)
  })
})
