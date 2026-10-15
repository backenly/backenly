/**
 * The dashboard's resource cards: the true table count, a card-sized list
 * ============================================================================
 * GET /api/projects/[id]/dashboard-stats answers the workspace home's cards.
 * An edit meant to report the real table count (the card once said "12
 * Tables" for a 15-table backend) attached the list's `.map(...)` to
 * `.length`, so the handler threw on every request, and `tables` carried the
 * kernel's raw rows. The typecheck let it through because the kernel call's
 * `.catch(() => null)` widened the result to `any`; the fallbacks are typed
 * now. Real route handler, real workspace tables. The project-access check is
 * delegated: its decision is pinned by the access suites, and the payload is
 * what is under test here.
 */

let currentProjectId = ''
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: (_req: any, handler: any) =>
    handler({ projectId: currentProjectId, userId: 'test-user' }),
}))

import '../helpers/real-web-standard'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { invalidateTableStats } from '@/lib/services/workspace-table-stats'
import { GET } from '@/app/api/projects/[id]/dashboard-stats/route'

let ownerId = ''
let projectId = ''
let schema = ''

async function stats() {
  const res = await GET(new NextRequest(`http://localhost:3000/api/projects/${projectId}/dashboard-stats`), {
    params: Promise.resolve({ id: projectId }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: { email: `dash-${randomUUID()}@test.invalid`, name: 'Dashboard Stats Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({ data: { name: `dash-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })
  ).id
  currentProjectId = projectId
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  for (let i = 1; i <= 15; i++) {
    const table = `t${String(i).padStart(2, '0')}`
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (id serial PRIMARY KEY, label text)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${table}" (label) SELECT 'row-' || g FROM generate_series(1, ${i}) g`)
  }
  invalidateTableStats(projectId)
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

it('answers the real table count with a list of twelve in the card’s shape', async () => {
  const { status, body } = await stats()
  expect(status).toBe(200)
  expect(body.success).toBe(true)
  expect(body.data.tableCount).toBe(15)
  expect(body.data.tables).toHaveLength(12)
  for (const t of body.data.tables) {
    expect(Object.keys(t).sort()).toEqual(['estimated', 'name', 'rowCount'])
    expect(typeof t.rowCount).toBe('number')
  }
  // Exact counts, read from the tables themselves.
  const byName = Object.fromEntries(body.data.tables.map((t: any) => [t.name, t.rowCount]))
  for (const [name, rows] of Object.entries(byName)) expect(rows).toBe(Number(String(name).slice(1)))
  expect(body.data.summary.dbBytes).toBeGreaterThan(0)
}, 60_000)

it('the route’s fallbacks are typed, so a slip like `.length.map` cannot typecheck again', () => {
  const fs = require('fs') as typeof import('fs')
  const source = fs.readFileSync(require('path').join(process.cwd(), 'app/api/projects/[id]/dashboard-stats/route.ts'), 'utf8')
  expect(source).toContain('listTableStats(projectId).catch((): KernelTableStat[] | null => null)')
  expect(source).toContain('countEndUsers(projectId).catch((): number | null => null)')
  expect(source).toMatch(/const tableCount = \(tableStats \?\? \[\]\)\.length\n/)
})
