/**
 * Two reads behind the Functions page (project console rebuild, Logic 1-2):
 *
 * 1. GET /ai-functions/logs?success=false filters runs by outcome on the
 *    server. The route returns at most 200 runs, so filtering failures in the
 *    browser hid yesterday's failure behind a busy endpoint's successes.
 * 2. GET /ai-functions answers `capture`: whether each active row-event
 *    function's table carries the capture trigger it fires from, read from
 *    the catalog. A function whose table lost its trigger never fires, and the
 *    list used to show it green.
 *
 * Database-free: the project wrapper, prisma and the catalog read are stubbed;
 * the subject is the query each route asks and the answer it builds.
 */

const validationOptions: unknown[] = []
jest.mock('@/lib/middleware/projectValidation', () => ({
  withProjectValidation: async (_req: unknown, handler: (v: { projectId: string }) => unknown, options?: unknown) => {
    validationOptions.push(options)
    return handler({ projectId: 'p1' })
  },
}))

const findLogs = jest.fn(async (_args: unknown) => [] as unknown[])
const findFunctions = jest.fn(async (_args: unknown) => [] as unknown[])
jest.mock('@/lib/db', () => ({
  prisma: {
    aiFunctionLog: { findMany: (args: unknown) => findLogs(args) },
    aiFunction: { findMany: (args: unknown) => findFunctions(args), updateMany: jest.fn() },
  },
}))
jest.mock('@/lib/services/ai-functions/run-records', () => ({
  withRunBodies: async (_p: string, rows: unknown) => rows,
  withLastErrors: async (_p: string, rows: unknown) => rows,
  rowLastError: jest.fn(),
  deleteFunctionRuns: jest.fn(),
}))
jest.mock('@/lib/auth/middleware', () => ({ authenticateRequest: async () => ({ userId: 'u1' }) }))
jest.mock('@/lib/edition/guard', () => ({ canAccessProject: async () => true, canWriteProject: async () => true }))
jest.mock('@/lib/changes/ledger', () => ({ governedChange: jest.fn(), withChangeAttribution: jest.fn() }))
jest.mock('@/lib/services/domain-endpoints', () => ({ projectGeneratedRoutes: async () => [], isGeneratedEndpoint: () => false }))
jest.mock('@/lib/services/ai-functions/generator', () => ({ generateFunctionCode: jest.fn() }))
const listCapturedTables = jest.fn(async (_p: string) => ['reviews'])
jest.mock('@/lib/webhooks/capture', () => ({
  listCapturedTables: (p: string) => listCapturedTables(p),
  syncWebhookCapture: jest.fn(),
  syncCaptureForFunctionChange: jest.fn(),
}))

import { GET as getRuns } from '@/app/api/projects/[id]/ai-functions/logs/route'
import { GET as getFunctions } from '@/app/api/projects/[id]/ai-functions/route'
import { functionCaptureHealth } from '@/lib/webhooks/function-capture'

function request(path: string): any {
  const url = new URL(`http://localhost${path}`)
  return { url: url.href, nextUrl: url, headers: new Headers(), method: 'GET', json: async () => ({}) }
}
const params = { params: Promise.resolve({ id: 'p1' }) }
const whereOf = (call: number) => (findLogs.mock.calls[call][0] as { where: Record<string, unknown> }).where

beforeEach(() => {
  findLogs.mockClear()
  findFunctions.mockClear()
  listCapturedTables.mockClear()
  validationOptions.length = 0
})

describe('runs: ?success= filters on the server', () => {
  it('asks only for failed runs with success=false, and only for successful ones with true', async () => {
    await getRuns(request('/api/projects/p1/ai-functions/logs?success=false&functionId=f1'), params)
    await getRuns(request('/api/projects/p1/ai-functions/logs?success=true'), params)
    // Records of runs that did not happen, and notices, are neither (record-kinds.ts).
    expect(whereOf(0)).toEqual({ projectId: 'p1', functionId: 'f1', success: false, triggerType: { notIn: ['not_run', 'notice'] } })
    expect(whereOf(1)).toEqual({ projectId: 'p1', success: true, triggerType: { notIn: ['not_run', 'notice'] } })
  })

  it('leaves the outcome unfiltered when the parameter is absent or anything else', async () => {
    await getRuns(request('/api/projects/p1/ai-functions/logs'), params)
    await getRuns(request('/api/projects/p1/ai-functions/logs?success=maybe'), params)
    expect(whereOf(0)).toEqual({ projectId: 'p1' })
    expect(whereOf(1)).toEqual({ projectId: 'p1' })
  })

  it('keeps the read floor: the read passes no stricter floor, and the 200 cap holds', async () => {
    await getRuns(request('/api/projects/p1/ai-functions/logs?success=false&limit=5000'), params)
    expect(validationOptions).toEqual([undefined])
    expect((findLogs.mock.calls[0][0] as { take: number }).take).toBe(200)
  })
})

const fn = (name: string, triggerType: string, triggerTable: string | null, status = 'active') => ({
  id: `id-${name}`, name, description: `${name} does a real thing for the app`, triggerType, triggerTable, status,
  lastError: null, runCount: 1, createdAt: new Date(), projectId: 'p1',
})

describe('functions: capture health for row-event functions', () => {
  it('names the active row-event functions whose table carries no capture trigger', () => {
    const health = functionCaptureHealth(
      [fn('on-review-created', 'on_db_insert', 'reviews'), fn('on-follow', 'on_db_insert', 'follows'), fn('off-one', 'on_db_delete', 'likes', 'inactive'), fn('daily', 'cron', '0 2 * * *')],
      ['reviews'],
    )
    expect(health.required).toBe(true)
    expect(health.healthy).toBe(false)
    expect(health.uncaptured).toEqual([{ id: 'id-on-follow', name: 'on-follow', table: 'follows' }])
  })

  it('needs nothing when no active function fires on rows', () => {
    expect(functionCaptureHealth([fn('daily', 'cron', '0 2 * * *'), fn('x', 'on_db_update', 't', 'inactive')], [])).toEqual({
      required: false,
      healthy: true,
      tables: [],
      uncaptured: [],
    })
  })

  it('answers it on the list, and reads the catalog only when a row-event function is active', async () => {
    findFunctions.mockResolvedValueOnce([fn('on-review-created', 'on_db_insert', 'reviews'), fn('on-follow', 'on_db_insert', 'follows')])
    const body = await (await getFunctions(request('/api/projects/p1/ai-functions'), params)).json()
    expect(listCapturedTables).toHaveBeenCalledWith('p1')
    expect(body.capture).toMatchObject({ required: true, healthy: false, tables: ['reviews'] })
    expect(body.capture.uncaptured.map((u: { name: string }) => u.name)).toEqual(['on-follow'])

    findFunctions.mockResolvedValueOnce([fn('daily', 'cron', '0 2 * * *')])
    const quiet = await (await getFunctions(request('/api/projects/p1/ai-functions'), params)).json()
    expect(listCapturedTables).toHaveBeenCalledTimes(1)
    expect(quiet.capture).toMatchObject({ required: false, healthy: true })
  })
})
