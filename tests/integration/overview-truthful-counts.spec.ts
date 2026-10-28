/**
 * THE OVERVIEW AND THE AGENT'S GROUNDING TELL THE SAME TRUTH
 * ==========================================================
 * Three honesty gaps on the project's front page:
 *
 *   - OV-4: read_backend_state's proof reported "Auth: email/password" on
 *     every FRESH project, because it keyed auth off the seeded jwtSecret —
 *     infrastructure every project gets at creation — while the console
 *     (lib/services/auth-status.ts) deliberately keys off the backend graph.
 *     The agent skipped auth { action: "enable" } and told the developer
 *     sign-up was configured.
 *   - OV-3: the Database card counted the dashboard-stats `tables` array,
 *     which the route slices to 12 for the card — a 15-table backend rendered
 *     "12 Tables". The route now sends the real `tableCount` alongside.
 *   - OV-2 is a component-lifecycle fix (focus refresh in MainWorkspace,
 *     which hosts the empty state) — pinned at the source level below.
 */

import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { collectProof } from '@/lib/ai/proof-system'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''

// jest.setup forces ENGINE_MODE=integration, which reroutes graph READS to an
// in-memory store the agent never wrote. This suite performs no DDL — it only
// reads proof — so it runs the production read path.
const savedEngineMode = process.env.ENGINE_MODE
beforeAll(async () => {
  delete process.env.ENGINE_MODE
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `ov-${randomUUID()}@test.invalid`, name: 'Overview Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      // The seeded signing secret every project gets — the exact signal the
      // old proof misread as "auth is enabled".
      data: { name: `ov-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: `seeded-${'s'.repeat(40)}` },
      select: { id: true },
    })
  ).id
}, 120_000)

afterAll(async () => {
  if (savedEngineMode !== undefined) process.env.ENGINE_MODE = savedEngineMode
  await prisma.backendGraph.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('OV-4: the proof agrees with the console about auth', () => {
  it('a fresh project with only the seeded jwtSecret is NOT auth-enabled', async () => {
    const proof = await collectProof(projectId)
    expect(proof.authEnabled).toBe(false)
    expect(proof.authProviders).toEqual([])
  }, 60_000)

  it('enabling email in the backend graph is what flips it', async () => {
    const graph = await prisma.backendGraph.create({
      data: {
        projectId,
        graphData: { auth: { providers: { email: { enabled: true } } } },
      },
      select: { id: true },
    })
    await prisma.project.update({ where: { id: projectId }, data: { activeGraphId: graph.id } })

    const proof = await collectProof(projectId)
    expect(proof.authEnabled).toBe(true)
    expect(proof.authProviders).toContain('email/password')
  }, 60_000)
})

describe('OV-3: the card count survives the 12-row card slice', () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), 'app', 'api', 'projects', '[id]', 'dashboard-stats', 'route.ts'),
    'utf8',
  )
  const card = fs.readFileSync(path.join(process.cwd(), 'components', 'workspace', 'WorkspaceHome.tsx'), 'utf8')

  it('the route reports the pre-slice total alongside the sliced list', () => {
    expect(route).toMatch(/const tableCount = \(tableStats \?\? \[\]\)\.length/)
    expect(route).toContain('data: { tables, tableCount, buckets, summary }')
  })

  it('the card prefers the real total over the sliced length', () => {
    expect(card).toMatch(/stats\?\.tableCount \?\?/)
  })
})

describe('OV-2: the page that hosts the empty state refreshes on return', () => {
  it('MainWorkspace re-reads /state on focus and visibility', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'components', 'workspace', 'MainWorkspace.tsx'), 'utf8')
    expect(src).toContain("document.addEventListener('visibilitychange'")
    expect(src).toContain("window.addEventListener('focus'")
  })
})
