/**
 * HEALING A PROJECT'S OWN POSTGREST
 * =================================
 * A project with a database of its own is served by its own PostgREST process
 * on the region's PostgREST host (services/pgrst-host). healDataPlane
 * (lib/postgrest/supervisor.ts) heals that process alone, with the same
 * discipline as the region's shared one (tests/unit/postgrest-supervisor.spec.ts):
 *
 *   verified     its own process is probed; answering, nothing is done
 *   repaired     a wedged cache is pruned in its own database's registry first
 *   restarted    only then, by asking the host (POST /admin/restart/<projectId>)
 *                with a service_role token naming the project and its
 *                database; never with the region's restart command, and never
 *                touching the region's shared PostgREST
 *   unreachable  a region with no host for this process is said, not healed
 *   rate-ceiled  restarted at most once per cooldown
 */

const mockProbeDedicated = jest.fn()
const mockPrune = jest.fn()
const mockDiagnoseAndHeal = jest.fn()
const mockProbePostgrest = jest.fn()
const mockExec = jest.fn()

jest.mock('@/lib/postgrest/health', () => ({
  diagnoseAndHeal: (...a: unknown[]) => mockDiagnoseAndHeal(...a),
  probePostgrest: (...a: unknown[]) => mockProbePostgrest(...a),
  probeDedicatedPostgrest: (...a: unknown[]) => mockProbeDedicated(...a),
  pruneDanglingSchemas: (...a: unknown[]) => mockPrune(...a),
}))

const mockLockQuery = jest.fn()
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: () => Promise.resolve(),
    query: (...a: unknown[]) => mockLockQuery(...a),
    end: () => Promise.resolve(),
  })),
}))

const mockAuditFindFirst = jest.fn()
const mockAuditCreate = jest.fn()
jest.mock('@/lib/db', () => ({
  prisma: {
    auditLog: {
      findFirst: (...a: unknown[]) => mockAuditFindFirst(...a),
      create: (...a: unknown[]) => mockAuditCreate(...a),
    },
  },
}))

const PROJECT = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const DB = `p_${'0123456789abcdef'.repeat(2)}`
const SECRET = 'a-region-postgrest-secret-of-at-least-32-chars'
const HOST = 'http://pgrst-host.virginia.internal.test:3200'

jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  projectDatabase: async () => ({ region: 'us-east-1', tenancy: 'dedicated', database: DB, instance: 'primary', epoch: 0 }),
  projectRegion: async () => 'us-east-1',
  projectPostgrest: async () => ({ url: `${HOST}/p/${PROJECT}`, jwtSecret: SECRET, database: DB }),
}))

jest.mock('node:child_process', () => ({ exec: (...a: unknown[]) => mockExec(...a) }))

import jwt from 'jsonwebtoken'
import { healDataPlane } from '@/lib/postgrest/supervisor'

const HEALTHY = { state: 'healthy', latencyMs: 4 } as const
const WEDGED = { state: 'schema_cache_failed', detail: 'PGRST002' } as const
const DOWN = { state: 'unreachable', detail: 'HTTP 502' } as const

let restarts: Array<{ url: string; method: string; authorization: string }> = []

beforeEach(() => {
  jest.clearAllMocks()
  restarts = []
  process.env.PGRST_HOST_URL_US_EAST_1 = HOST
  // The region's own restart command is set and must never be used for a project's own process.
  process.env.POSTGREST_LOCAL_RESTART_COMMAND_US_EAST_1 = 'restart-the-regions-shared-postgrest'
  mockLockQuery.mockImplementation(async (sql: string) =>
    sql.includes('pg_try_advisory_lock') ? { rows: [{ acquired: true }] } : { rows: [] },
  )
  mockAuditFindFirst.mockResolvedValue(null)
  mockAuditCreate.mockResolvedValue({})
  mockPrune.mockResolvedValue(0)
  global.fetch = jest.fn(async (url: string, init: any) => {
    restarts.push({ url: String(url), method: init?.method, authorization: init?.headers?.authorization })
    return { ok: true, status: 200, text: async () => '{"state":"ready"}' }
  }) as unknown as typeof fetch
})

afterAll(() => {
  delete process.env.PGRST_HOST_URL_US_EAST_1
  delete process.env.POSTGREST_LOCAL_RESTART_COMMAND_US_EAST_1
})

it('does nothing when its own PostgREST answers', async () => {
  mockProbeDedicated.mockResolvedValue(HEALTHY)
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'already_healthy', healthy: true, restarted: false })
  expect(restarts).toEqual([])
  expect(mockDiagnoseAndHeal).not.toHaveBeenCalled()
  expect(mockProbePostgrest).not.toHaveBeenCalled()
})

it('prunes its own database’s registry first, and stops there when that heals it', async () => {
  mockProbeDedicated.mockResolvedValueOnce(WEDGED).mockResolvedValue(HEALTHY)
  mockPrune.mockResolvedValue(1)
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'healed_without_restart', prunedSchemas: 1, restarted: false })
  expect(mockPrune).toHaveBeenCalledWith({ region: 'us-east-1', database: DB })
  expect(restarts).toEqual([])
})

it('restarts its own process on the host, with a service_role token for it alone, and never the region’s', async () => {
  mockProbeDedicated.mockResolvedValueOnce(DOWN).mockResolvedValue(HEALTHY)
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'healed_by_restart', healthy: true, restarted: true })
  expect(restarts).toHaveLength(1)
  expect(restarts[0]).toMatchObject({ url: `${HOST}/admin/restart/${PROJECT}`, method: 'POST' })
  const token = restarts[0].authorization.replace(/^Bearer /, '')
  expect(jwt.verify(token, SECRET, { algorithms: ['HS256'] })).toMatchObject({ role: 'service_role', aud: PROJECT, db: DB, project_id: PROJECT })
  expect(mockExec).not.toHaveBeenCalled()
  expect(mockDiagnoseAndHeal).not.toHaveBeenCalled()
  // Recorded before the call, for the project's own cooldown.
  expect(mockAuditCreate.mock.calls.map((c) => c[0].data.action)).toContain('DATA_PLANE_PROJECT_RESTARTED')
})

it('says the region is not reachable when this process has no host for it', async () => {
  mockProbeDedicated.mockResolvedValue({ state: 'not_configured' })
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'region_not_reachable', healthy: false, restarted: false })
  expect(r.notes.join(' ')).toContain('PGRST_HOST_URL_US_EAST_1')
  expect(restarts).toEqual([])
})

it('does not restart again within the cooldown', async () => {
  mockProbeDedicated.mockResolvedValue(DOWN)
  mockAuditFindFirst.mockResolvedValue({ timestamp: new Date(Date.now() - 30_000) })
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'cooling_down', restarted: false })
  expect(restarts).toEqual([])
  expect(mockAuditFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ action: 'DATA_PLANE_PROJECT_RESTARTED', projectId: PROJECT }) }))
})

it('reports a heal already running for the project instead of starting another', async () => {
  mockLockQuery.mockImplementation(async (sql: string) =>
    sql.includes('pg_try_advisory_lock') ? { rows: [{ acquired: false }] } : { rows: [] },
  )
  mockProbeDedicated.mockResolvedValue(DOWN)
  const r = await healDataPlane(PROJECT)
  expect(r).toMatchObject({ outcome: 'in_progress', restarted: false })
  expect(restarts).toEqual([])
})
