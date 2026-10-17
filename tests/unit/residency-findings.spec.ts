/**
 * A REGIONAL PROJECT'S HEALTH FINDINGS AND HELD ACTIONS QUOTE NONE OF ITS DATA
 * ============================================================================
 * Health findings and the timeline are platform rows, in the home region. For
 * a project kept in another region (founders' residency table, 2026-10-16):
 *   - a broken contract probe keeps what failed and how (surface, request,
 *     status, size of the answer), never the answer's body or the handler's
 *     message, which can echo a row;
 *   - a failed repair keeps its message only when it is an error code, and the
 *     full message goes only to the log of a process serving that region;
 *   - an action held for approval keeps its target and arguments on the
 *     finding, which is what the approver reads (as an approval request does),
 *     while its timeline event names the action only.
 * A home project's rows are unchanged.
 *
 * Database-free: the platform clients are recorders, and each project's region
 * is whatever the test says it is.
 */

const mockRegions = new Map<string, string | null>()
const mockEvents: any[] = []
const mockFindings: any[] = []

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(async ({ where }: any) => (mockRegions.has(where.id) ? { region: mockRegions.get(where.id) } : null)),
    },
  },
}))

jest.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(async ({ where }: any) => (mockRegions.has(where.id) ? { region: mockRegions.get(where.id) } : null)),
    },
    backendEvent: {
      create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e${mockEvents.length}`, ...data } }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    healthFinding: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => { mockFindings.push(data); return { id: `f${mockFindings.length}`, ...data } }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    backendPattern: { upsert: jest.fn(async () => ({})) },
  },
}))

import { randomBytes } from 'crypto'
import { NOT_QUOTED, findingDetailsKeptHere, quotedError } from '@/lib/data-plane/residency'
import { settleTenantContract, withoutHandlerMessage } from '@/lib/services/contract-verifier'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'

const ROW_ECHO = 'invalid input syntax for type uuid: "alice@example.com"'

function brokenDbProbe() {
  return {
    surface: 'db' as const,
    ok: false,
    critical: true,
    detail: `GET /db/orders returned 500 — ${ROW_ECHO}`,
    status: 500,
    response: JSON.stringify({ message: ROW_ECHO, rows: [{ email: 'alice@example.com' }] }),
    durationMs: 12,
  }
}

describe('error messages', () => {
  it('keep a home project\'s message, and only an error code for a regional one', () => {
    expect(quotedError(ROW_ECHO, true)).toBe(ROW_ECHO)
    expect(quotedError(ROW_ECHO, false)).toBe(NOT_QUOTED)
    expect(quotedError('MIGRATION_FAILED', false)).toBe('MIGRATION_FAILED')
  })

  it('separate a probe\'s status line from the handler\'s message', () => {
    expect(withoutHandlerMessage(`GET /db/orders returned 500 — ${ROW_ECHO}`)).toBe('GET /db/orders returned 500')
    expect(withoutHandlerMessage('GET /db/orders returned 502')).toBe('GET /db/orders returned 502')
  })
})

describe('a broken contract probe', () => {
  it('keeps the body and the handler message for a home project', async () => {
    mockRegions.set('p-home-contract', null)
    const [finding] = await settleTenantContract('p-home-contract', [], [brokenDbProbe()])
    expect(finding.details.detail).toContain(ROW_ECHO)
    expect(String(finding.details.response)).toContain('alice@example.com')
  })

  it('keeps only the request, status and size for a regional project', async () => {
    mockRegions.set('p-use1-contract', 'us-east-1')
    const probe = brokenDbProbe()
    const [finding] = await settleTenantContract('p-use1-contract', [], [probe])
    expect(finding.details).toMatchObject({
      surface: 'db', detail: 'GET /db/orders returned 500', response: null, responseBytes: probe.response.length, httpStatus: 500,
    })
    expect(JSON.stringify(finding.details)).not.toContain('alice@example.com')
  })
})

describe('a failed repair on a finding', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => warn.mockClear())
  afterAll(() => warn.mockRestore())

  it('is kept as written for a home project', async () => {
    mockRegions.set('p-home-fix', null)
    const details = await findingDetailsKeptHere('p-home-fix', 'missing_index', { location: 'orders', fixError: ROW_ECHO })
    expect(details.fixError).toBe(ROW_ECHO)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps only an error code for a regional project, logging the message only where the region is served', async () => {
    mockRegions.set('p-use1-fix', 'us-east-1')
    const saved = process.env.BACKENLY_SERVICE_REGION
    try {
      process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
      const inRegion = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { location: 'orders', fixError: ROW_ECHO })
      expect(inRegion).toEqual({ location: 'orders', fixError: NOT_QUOTED })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(ROW_ECHO)

      warn.mockClear()
      delete process.env.BACKENLY_SERVICE_REGION // the home region's process
      const atHome = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { fixError: ROW_ECHO })
      expect(atHome.fixError).toBe(NOT_QUOTED)
      expect(warn).not.toHaveBeenCalled()

      const coded = await findingDetailsKeptHere('p-use1-fix', 'missing_index', { fixError: 'LOCK_TIMEOUT' })
      expect(coded.fixError).toBe('LOCK_TIMEOUT')
    } finally {
      if (saved === undefined) delete process.env.BACKENLY_SERVICE_REGION
      else process.env.BACKENLY_SERVICE_REGION = saved
    }
  })
})

describe('an action held for approval', () => {
  // Sealing the held arguments refuses a short signing secret, as CI's is; a
  // random sealing-grade one for this block only, never a literal.
  const savedSecret = process.env.JWT_SECRET
  beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
  afterAll(() => { process.env.JWT_SECRET = savedSecret })

  const input = (projectId: string) => ({
    projectId,
    action: 'BLOCK_USER',
    params: { userId: 'u_123', email: 'alice@example.com' },
    target: 'alice@example.com',
    riskLevel: 'medium' as const,
    source: 'brain-risk' as const,
    reason: 'Blocking an end user needs the owner',
  })

  it('names its target on the timeline for a home project', async () => {
    mockRegions.set('p-home-held', null)
    mockEvents.length = 0
    await queuePendingActionFinding(input('p-home-held'))
    expect(mockEvents[0].summary).toContain('alice@example.com')
    expect(mockEvents[0].afterState).toEqual({ executorAction: 'BLOCK_USER', target: 'alice@example.com' })
  })

  it('keeps the target for the approver but names only the action on a regional project\'s timeline', async () => {
    mockRegions.set('p-use1-held', 'us-east-1')
    mockEvents.length = 0
    mockFindings.length = 0
    await queuePendingActionFinding(input('p-use1-held'))
    expect(mockEvents[0].summary).toBe('Held for your approval: Block user.')
    expect(mockEvents[0].afterState).toEqual({ executorAction: 'BLOCK_USER' })
    expect(JSON.stringify(mockEvents[0])).not.toContain('alice@example.com')
    // The approver's copy: what the Review Queue shows and what approval replays.
    expect(mockFindings[0].details.location).toBe('alice@example.com')
    expect(mockFindings[0].details.executorAction).toBe('BLOCK_USER')
  })
})
