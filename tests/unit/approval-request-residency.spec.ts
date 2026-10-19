/**
 * A REGIONAL PROJECT'S APPROVAL REQUESTS STAY IN ITS REGION
 * =========================================================
 * A call an agent parks for a human is a platform row in the home region. For
 * a project kept in another region, the agent's request, the call's target and
 * its exact arguments are kept in the region, written before the row, and the
 * row keeps the tool, a message naming it, a keyed stand-in for the target and
 * the arguments' shape (lib/mcp/approval-request-bodies.ts):
 *   - a request the region cannot keep is not created, and the chat door says
 *     the call was not queued, whatever the model's summary says, as it does
 *     for any project's request it could not create; the rest of the turn
 *     keeps its own answer;
 *   - the Review Queue, check_approval and the briefing tools show the request
 *     read back from the region, and the row as stored, marked unreadable,
 *     when it cannot be read;
 *   - approval runs exactly the call read back from the region, and only for
 *     an approval that carries the digest of what its card showed; while the
 *     region cannot be reached it runs nothing and the request keeps waiting,
 *     and when the region has no such call it runs nothing, never marks the
 *     request approved, and closes it with a note to ask the agent again;
 *   - a home project's request is read from its row, even when its agent's
 *     arguments carry the mark a regional row has;
 *   - the region keeps the request exactly as long as its row: the enforced
 *     daily cleanup deletes the record before the row and keeps a row whose
 *     region cannot be reached, and a record whose row could not be written
 *     is removed again.
 * A home project's requests are unchanged.
 *
 * Database-free: the platform client is a recorder, each project's region is
 * whatever the test says it is, and a region's database is a map.
 */

import '../helpers/next-request-polyfill'

const mockRegions = new Map<string, string | null>()
const mockApprovals = new Map<string, any>()
/** Every status a request was given, in order. */
const mockStatusLog: Array<{ id: string; status: string }> = []
const mockAudits: any[] = []
/** The order a request's record and its row were written in. */
const mockWrites: string[] = []
/** The regional databases' records, by kind and id. */
const mockBodies = new Map<string, { projectId: string; payload: unknown }>()
/** Projects whose region this process cannot reach. */
const mockUnreachable = new Set<string>()
/** Records the region refuses to write: any that contains one of these. */
const mockRefusedWrites = new Set<string>()
/** Projects whose approval rows the platform database refuses to write. */
const mockRefusedRows = new Set<string>()
/** The values of each statement the region's prune ran. */
const mockPrunes: unknown[][] = []
/** What the stubbed brain answers the chat door with, and whose key asks. */
let mockBrainTurn: any = null
let mockKeyProject = ''

jest.mock('@/lib/db/prisma', () => {
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, want]: [string, any]) => {
      if (key === 'AND') return want.every((clause: any) => matches(row, clause))
      if (key === 'OR') return want.some((clause: any) => matches(row, clause))
      if (want && typeof want === 'object' && !(want instanceof Date)) {
        if ('path' in want) return row[key]?.[want.path[0]] === want.equals
        if ('gt' in want) return row[key] !== null && row[key] > want.gt
        if ('lt' in want) return row[key] !== null && row[key] < want.lt
        if ('notIn' in want) return !want.notIn.includes(row[key])
      }
      return row[key] === want
    })
  const none = { deleteMany: jest.fn(async () => ({ count: 0 })), count: jest.fn(async () => 0) }
  const pick = (row: any, select: any) =>
    select ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]])) : row
  // Copies, as a database returns them: a caller's object is never the stored row.
  const approvals = () => [...mockApprovals.values()].map((row) => structuredClone(row))
  const write = (row: any, data: any) => {
    Object.assign(row, structuredClone(data))
    if (data.status) mockStatusLog.push({ id: row.id, status: data.status })
  }
  return {
    prisma: {
      project: {
        findUnique: jest.fn(async ({ where }: any) =>
          mockRegions.has(where.id) ? { region: mockRegions.get(where.id), userId: 'u-owner', name: 'Shop' } : null),
      },
      agentApprovalRequest: {
        create: jest.fn(async ({ data }: any) => {
          if (mockRefusedRows.has(data.projectId)) throw new Error('Can\'t reach database server')
          const row = structuredClone({
            id: data.id ?? `a${mockApprovals.size + 1}`,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            executedAt: null,
            resultSummary: null,
            createdAt: new Date(),
            ...data,
          })
          mockWrites.push(`row:${row.id}`)
          mockApprovals.set(row.id, row)
          return structuredClone(row)
        }),
        findFirst: jest.fn(async ({ where }: any) => approvals().find((row) => matches(row, where)) ?? null),
        findUnique: jest.fn(async ({ where }: any) => approvals().find((row) => row.id === where.id) ?? null),
        findMany: jest.fn(async ({ where, select, take }: any) =>
          approvals()
            .filter((row) => matches(row, where))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take ?? Infinity)
            .map((row) => pick(row, select))),
        update: jest.fn(async ({ where, data }: any) => {
          const row = mockApprovals.get(where.id)
          if (!row) throw new Error('Record to update not found.')
          write(row, data)
          return structuredClone(row)
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = mockApprovals.get(where.id)
          if (!row || !matches(row, where)) return { count: 0 }
          write(row, data)
          return { count: 1 }
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          const doomed = [...mockApprovals.values()].filter((row) => matches(row, where))
          for (const row of doomed) {
            mockWrites.push(`delete:${row.id}`)
            mockApprovals.delete(row.id)
          }
          return { count: doomed.length }
        }),
        count: jest.fn(async ({ where }: any) => [...mockApprovals.values()].filter((row) => matches(row, where)).length),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => { mockAudits.push(data); return data }),
        // The activity feed's read: a project's rows, newest first.
        findMany: jest.fn(async ({ where }: any) =>
          mockAudits
            .map((row, index) => ({ id: `audit-${index}`, metadata: null, ...row }))
            .filter((row) => row.projectId === where.projectId)
            .reverse()),
      },
      correctionEvent: { findMany: jest.fn(async () => []) },
      platformNotification: { findFirst: jest.fn(async () => null) },
      // The daily cleanup's other tables, which this suite does not fill.
      webhookLog: none,
      apiRequestLog: none,
      intentLog: none,
      securityEvent: none,
    },
  }
})
jest.mock('@/lib/db', () => jest.requireMock('@/lib/db/prisma'))

// A region's database: records in a map, refused for a project whose region
// this process cannot reach, as the real regional client refuses it.
jest.mock('@/lib/data-plane/regional-bodies', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional-bodies')
  const { projectRegion, RegionNotConfiguredError } = jest.requireActual('@/lib/data-plane/regional')
  return {
    ...actual,
    regionalBodiesFor: jest.fn(async (projectId: string) => {
      const region = await projectRegion(projectId)
      if (region === 'ap-south-1') return actual.BODIES_ON_THE_ROW
      const reach = () => {
        if (mockUnreachable.has(projectId)) throw new RegionNotConfiguredError(region, 'DATABASE_URL_US_EAST_1', projectId)
      }
      const read = (kind: string, id: string) => {
        const body = mockBodies.get(`${kind}:${id}`)
        return body && body.projectId === projectId ? { payload: structuredClone(body.payload), responseBody: null, error: null } : null
      }
      return {
        region,
        set: async (kind: string, id: string, fields: any) => {
          reach()
          const text = JSON.stringify(fields.payload)
          if ([...mockRefusedWrites].some((term) => text.includes(term))) throw new Error('Connection terminated unexpectedly')
          mockWrites.push(`body:${id}`)
          mockBodies.set(`${kind}:${id}`, { projectId, payload: structuredClone(fields.payload) })
        },
        get: async (kind: string, id: string) => { reach(); return read(kind, id) },
        getMany: async (kind: string, ids: string[]) => {
          reach()
          return new Map(ids.flatMap((id) => { const body = read(kind, id); return body ? [[id, body]] : [] }) as any)
        },
        remove: async (kind: string, ids: string[]) => {
          reach()
          for (const id of ids) {
            if (mockBodies.get(`${kind}:${id}`)?.projectId !== projectId) continue
            mockWrites.push(`forget:${id}`)
            mockBodies.delete(`${kind}:${id}`)
          }
        },
        idsMatching: async () => [],
      }
    }),
  }
})
// The region's own database, for its prune: the statement's values recorded.
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  regionRawClient: jest.fn(() => ({
    $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => { mockPrunes.push(values); return 0 }),
  })),
}))

// The approval module's dispatcher and the owner's notice.
jest.mock('@/lib/ai/brain/tools', () => ({ dispatchTool: jest.fn() }))
jest.mock('@/lib/notifications/platform', () => ({ notifyApprovalRequested: jest.fn(async () => {}) }))

// The chat door's key, gates, credits and brain, which this suite stubs rather than runs.
jest.mock('@/lib/mcp/guard', () => ({
  mcpGuard: jest.fn(async () => ({
    auth: { keyId: 'k1', projectId: mockKeyProject, userId: 'u-agent', scope: 'mcp', readOnly: false },
  })),
  recordMcpCall: jest.fn(),
  refuseIfReadOnly: jest.fn(() => null),
}))
jest.mock('@/lib/ai/brain/agent', () => ({ runBrain: jest.fn(async () => mockBrainTurn) }))
jest.mock('@/lib/platform-controls', () => ({ assertAiAllowed: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/entitlements/policy', () => ({ enforceAiCredits: jest.fn(async () => true) }))
jest.mock('@/lib/entitlements/credit-holds', () => ({ closeCreditTurn: jest.fn(async () => {}) }))
jest.mock('@/lib/usage/account', () => ({ creditAccountOf: jest.fn(async () => 'account-1') }))

// The console's approvals route: the project's administrator, deciding on the
// project the request names.
jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => (req: any) =>
    handler(req, { user: { userId: 'u-owner', email: 'owner@backenly.test' }, project: {}, projectId: req.projectId }),
}))
jest.mock('@/lib/edition/guard', () => ({ canAdministerProject: jest.fn(async () => true) }))

import { randomBytes } from 'crypto'
import { NextRequest } from 'next/server'
import { NOT_QUOTED } from '@/lib/data-plane/residency'
import { pruneRegionalBodies } from '@/lib/data-plane/regional-bodies'
import { ApprovalRequestNotKept, approvalTargetStandIn } from '@/lib/mcp/approval-request-bodies'
import { createApprovalRequest, decideApproval, getApprovalForProject, listApprovals } from '@/lib/mcp/approvals'
import { handleCleanupJob } from '@/lib/queue/worker'
import { buildActivityFeed } from '@/lib/activity/feed'
import { listPendingAgentApprovals } from '@/lib/mcp/pending-approvals'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { notifyApprovalRequested } from '@/lib/notifications/platform'
import { POST as chat } from '@/app/api/mcp/chat/route'
import { GET as listByRoute, POST as decideByRoute } from '@/app/api/projects/[id]/agent-approvals/route'

const EMAIL = 'alice@example.com'
const MESSAGE = `Block ${EMAIL}, she keeps posting spam`
const TARGET = `the end-user ${EMAIL} (they lose access immediately)`
const CALL = { email: EMAIL, reason: 'spam' }

// A random signing secret for this file only, never a literal.
const savedSecret = process.env.JWT_SECRET
beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
afterAll(() => { process.env.JWT_SECRET = savedSecret })

const dispatched = dispatchTool as jest.Mock
const notified = notifyApprovalRequested as jest.Mock
beforeEach(() => dispatched.mockReset())

const blockAlice = (projectId: string) => ({
  projectId,
  userId: 'u-agent',
  apiKeyId: 'k1',
  message: MESSAGE,
  danger: { tool: 'block_end_user', target: TARGET, rowCount: null, reversible: true },
  toolArgs: CALL,
})

const forProject = (rows: any[], projectId: string) => rows.filter((row) => row.projectId === projectId)
const rowsOf = (projectId: string) => forProject([...mockApprovals.values()], projectId)
const statusesOf = (id: string) => mockStatusLog.filter((s) => s.id === id).map((s) => s.status)
const auditOf = (projectId: string, action: string) => {
  const row = mockAudits.find((a) => a.projectId === projectId && a.action === action)
  return row ? JSON.parse(row.details) : undefined
}
const noticesOf = (projectId: string) => notified.mock.calls.filter(([, request]) => request.projectId === projectId)
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
const approve = (projectId: string, approvalId: string, shownDigest?: string) =>
  decideApproval({ projectId, approvalId, approverUserId: 'u-owner', decision: 'approve', shownDigest })
/** The digest the Review Queue's card for a request carries, as listApprovals gives it. */
const shownOf = async (projectId: string, id: string) =>
  (await listApprovals(projectId)).find((r) => r.id === id)?.shownDigest ?? undefined
/** The console's approvals route, as the Review Queue calls it. */
async function viaRoute(projectId: string, body?: Record<string, unknown>) {
  const res: any = body
    ? await decideByRoute({ projectId, json: async () => body } as any)
    : await listByRoute({ projectId } as any)
  return { status: res.status as number, body: await res.json() }
}
const HEX_DIGEST = /^[0-9a-f]{64}$/

/** Run `fn` with the region's, the door's and the cleanup's own notes kept out of the test output. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const notes = (['warn', 'error', 'info'] as const).map((level) => jest.spyOn(console, level).mockImplementation(() => {}))
  try {
    return await fn()
  } finally {
    for (const note of notes) note.mockRestore()
  }
}

describe('creating a request', () => {
  it('keeps a regional project\'s words, target and call in its region, written before the row, which keeps none of them', async () => {
    mockRegions.set('p-use1-create', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-create'))
    const stored = mockApprovals.get(row.id)

    // The platform row: the tool, a message naming it, the target's stand-in and the call's shape.
    expect(stored).toMatchObject({
      projectId: 'p-use1-create',
      tool: 'block_end_user',
      message: 'An agent asked to run block_end_user. Its request and exact call are kept in the project’s region.',
      target: `block_end_user target ${approvalTargetStandIn('p-use1-create', TARGET)}`,
      toolArgs: { keptInRegion: true, shape: { email: '[string]', reason: '[string]' } },
      rowCount: null,
      reversible: true,
      status: 'pending',
    })
    expect(JSON.stringify(stored)).not.toContain(EMAIL)
    expect(JSON.stringify(stored)).not.toContain('spam')

    // The region: what a home project's row keeps, under the row's id, written first.
    expect(mockBodies.get(`approval_request:${row.id}`)).toEqual({
      projectId: 'p-use1-create',
      payload: { message: MESSAGE, target: TARGET, toolArgs: CALL },
    })
    expect(mockWrites.filter((w) => w.endsWith(row.id))).toEqual([`body:${row.id}`, `row:${row.id}`])

    // Neither the audit copy nor the owner's notice names the target.
    await flush()
    expect(auditOf('p-use1-create', 'AGENT_APPROVAL_REQUESTED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-create'))).not.toContain(EMAIL)
    expect(noticesOf('p-use1-create').map(([, request]) => request)).toEqual([
      expect.objectContaining({ approvalId: row.id, tool: 'block_end_user', target: null }),
    ])
  })

  it('writes no row, and says nothing was queued, when the region cannot keep the request', async () => {
    mockRegions.set('p-use1-nowrite', 'us-east-1')
    mockUnreachable.add('p-use1-nowrite')
    let thrown: unknown
    try {
      await quietly(() => createApprovalRequest(blockAlice('p-use1-nowrite')))
    } catch (err) {
      thrown = err
    } finally {
      mockUnreachable.delete('p-use1-nowrite')
    }
    expect(thrown).toBeInstanceOf(ApprovalRequestNotKept)
    expect((thrown as Error).message).toMatch(/not queued for approval and nothing was run/)
    expect((thrown as Error).message).not.toContain(EMAIL)

    await flush()
    expect(rowsOf('p-use1-nowrite')).toEqual([])
    expect(forProject(mockAudits, 'p-use1-nowrite')).toEqual([])
    expect(noticesOf('p-use1-nowrite')).toEqual([])
  })

  it('writes no row when the region refuses the record itself', async () => {
    mockRegions.set('p-use1-refused', 'us-east-1')
    mockRefusedWrites.add(EMAIL)
    try {
      await expect(quietly(() => createApprovalRequest(blockAlice('p-use1-refused')))).rejects.toBeInstanceOf(ApprovalRequestNotKept)
    } finally {
      mockRefusedWrites.delete(EMAIL)
    }
    expect(rowsOf('p-use1-refused')).toEqual([])
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-use1-refused')).toEqual([])
  })
})

describe('showing a request', () => {
  it('reads a regional project\'s words and target back from its region for every surface', async () => {
    mockRegions.set('p-use1-show', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-show'))

    const [listed] = await listApprovals('p-use1-show')
    expect(listed).toMatchObject({
      id: row.id, tool: 'block_end_user', message: MESSAGE, target: TARGET, status: 'pending',
      readable: true, shownDigest: expect.stringMatching(HEX_DIGEST),
    })
    expect(await getApprovalForProject('p-use1-show', row.id)).toMatchObject({ id: row.id, status: 'pending', target: TARGET, readable: true })
    // The console's route lists the same, digest included.
    const { body } = await viaRoute('p-use1-show')
    expect(body.approvals.find((a: any) => a.id === row.id)).toMatchObject({ message: MESSAGE, readable: true, shownDigest: listed.shownDigest })

    // The briefing tools' list: the target, and never the call.
    const { createdAt, expiresAt } = mockApprovals.get(row.id)
    expect(await listPendingAgentApprovals('p-use1-show')).toEqual([
      { id: row.id, tool: 'block_end_user', target: TARGET, createdAt, expiresAt },
    ])
  })

  it('shows the row as stored, marked unreadable and with nothing to approve it by, when the region cannot answer for it', async () => {
    mockRegions.set('p-use1-unread', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-unread'))
    const stored = mockApprovals.get(row.id)
    const asStored = { id: row.id, message: stored.message, target: stored.target, readable: false, shownDigest: null }

    mockUnreachable.add('p-use1-unread')
    try {
      const [listed] = await quietly(() => listApprovals('p-use1-unread'))
      expect(listed).toMatchObject(asStored)
      expect(await quietly(() => getApprovalForProject('p-use1-unread', row.id))).toMatchObject({ target: stored.target, readable: false })
      expect((await quietly(() => listPendingAgentApprovals('p-use1-unread')))[0]).toMatchObject({ id: row.id, target: stored.target })
    } finally {
      mockUnreachable.delete('p-use1-unread')
    }

    // A region that no longer has the request's record answers the same way.
    mockBodies.delete(`approval_request:${row.id}`)
    const [gone] = await listApprovals('p-use1-unread')
    expect(gone).toMatchObject(asStored)
    expect(JSON.stringify(gone)).not.toContain(EMAIL)
  })
})

describe('approving a regional request', () => {
  it('runs exactly the call kept in the region, and stores only the outcome\'s status', async () => {
    mockRegions.set('p-use1-run', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-run'))
    dispatched.mockImplementation(async () => ({ ok: true, summary: `Blocked ${EMAIL}` }))

    // Approved from the card, which carries the digest of what it showed. The
    // approver reads the outcome in full.
    const shown = await shownOf('p-use1-run', row.id)
    expect(await approve('p-use1-run', row.id, shown)).toEqual({ ok: true, status: 'executed', resultSummary: `Blocked ${EMAIL}` })
    expect(dispatched.mock.calls).toEqual([
      ['block_end_user', CALL, expect.objectContaining({ projectId: 'p-use1-run', userId: 'u-owner', destructiveConfirmed: true })],
    ])
    expect(statusesOf(row.id)).toEqual(['approved', 'executed'])

    const stored = mockApprovals.get(row.id)
    expect(stored).toMatchObject({ status: 'executed', resultSummary: NOT_QUOTED, decidedBy: 'u-owner' })
    expect(JSON.stringify(stored)).not.toContain(EMAIL)
    expect(auditOf('p-use1-run', 'AGENT_APPROVAL_GRANTED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-run'))).not.toContain(EMAIL)
  })

  it('runs nothing while its region cannot be reached, keeps the request waiting, and runs it once the region answers', async () => {
    mockRegions.set('p-use1-down', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-down'))
    const shownDigest = await shownOf('p-use1-down', row.id)
    dispatched.mockImplementation(async () => ({ ok: true, summary: 'Blocked' }))

    mockUnreachable.add('p-use1-down')
    let decided: Awaited<ReturnType<typeof approve>>
    let viaConsole: Awaited<ReturnType<typeof viaRoute>>
    try {
      decided = await quietly(() => approve('p-use1-down', row.id, shownDigest))
      viaConsole = await quietly(() => viaRoute('p-use1-down', { approvalId: row.id, decision: 'approve', shownDigest }))
    } finally {
      mockUnreachable.delete('p-use1-down')
    }
    expect(decided).toEqual({
      ok: false,
      status: 'pending',
      error: expect.stringMatching(/could not be reached, so nothing was changed and the request is still waiting\. Approve it again once the region answers\./),
      regionUnavailable: true,
    })
    expect(viaConsole).toMatchObject({ status: 503, body: { success: false, status: 'pending', retryable: true } })
    expect(dispatched).not.toHaveBeenCalled()
    // Nothing was decided: still pending, nothing audited as refused.
    expect(statusesOf(row.id)).toEqual([])
    expect(auditOf('p-use1-down', 'AGENT_APPROVAL_UNREADABLE_REFUSED')).toBeUndefined()
    expect(await getApprovalForProject('p-use1-down', row.id)).toMatchObject({ status: 'pending', resultSummary: null })

    // Once the region answers, the same card's approval runs the call.
    expect(await approve('p-use1-down', row.id, shownDigest)).toMatchObject({ ok: true, status: 'executed' })
    expect(dispatched.mock.calls.map(([tool, args]) => [tool, args])).toEqual([['block_end_user', CALL]])
  })

  it.each([
    ['no longer has it', 'p-use1-gone'],
    ['has no call in it', 'p-use1-bad'],
  ])('runs nothing when the region %s, and closes the request asking for a new one', async (_how, projectId) => {
    mockRegions.set(projectId, 'us-east-1')
    const row = await createApprovalRequest(blockAlice(projectId))
    if (projectId === 'p-use1-gone') mockBodies.delete(`approval_request:${row.id}`)
    if (projectId === 'p-use1-bad') {
      mockBodies.set(`approval_request:${row.id}`, { projectId, payload: { message: MESSAGE, target: TARGET, toolArgs: ['not', 'a', 'call'] } })
    }

    const decided = await quietly(() => approve(projectId, row.id))

    expect(decided).toEqual({
      ok: false,
      status: 'failed',
      resultSummary: expect.stringMatching(/exact call was not found in the project’s region, so nothing was changed\./),
    })
    expect(decided.resultSummary).toMatch(/Ask your agent to make the change again: it will be held again, as a new request, for your approval\.$/)
    // Nothing ran, and the shape on the row was never offered in the call's place.
    expect(dispatched).not.toHaveBeenCalled()
    // Never claimed: pending to failed, never approved or executed.
    expect(statusesOf(row.id)).toEqual(['failed'])
    expect(mockApprovals.get(row.id)).toMatchObject({ status: 'failed', executedAt: null, decidedBy: 'u-owner', resultSummary: decided.resultSummary })
    expect(auditOf(projectId, 'AGENT_APPROVAL_UNREADABLE_REFUSED')).toMatchObject({ approvalId: row.id, tool: 'block_end_user' })
    expect(auditOf(projectId, 'AGENT_APPROVAL_GRANTED')).toBeUndefined()

    // The agent polling it is told the same, and a second approval runs nothing either.
    expect(await getApprovalForProject(projectId, row.id)).toMatchObject({ status: 'failed', resultSummary: decided.resultSummary })
    expect(await approve(projectId, row.id)).toMatchObject({ ok: false, status: 'failed' })
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('runs nothing, and keeps the request waiting, when an approval does not carry the request as its card showed it', async () => {
    mockRegions.set('p-use1-bound', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-bound'))
    const other = await createApprovalRequest({ ...blockAlice('p-use1-bound'), toolArgs: { email: 'bob@example.com', reason: 'spam' } })
    dispatched.mockImplementation(async () => ({ ok: true, summary: 'Blocked' }))
    const refused = {
      ok: false,
      status: 'pending',
      error: expect.stringMatching(/does not match the request as it is kept now, so nothing was changed and the request is still waiting/),
    }

    // A card that showed only stand-ins has no digest to send.
    expect(await approve('p-use1-bound', row.id)).toEqual(refused)
    // Neither another request's digest nor a made-up one approves it.
    expect(await approve('p-use1-bound', row.id, await shownOf('p-use1-bound', other.id))).toEqual(refused)
    expect(await approve('p-use1-bound', row.id, 'f'.repeat(64))).toEqual(refused)
    // A record that changed after its card was shown no longer matches that card.
    const shown = await shownOf('p-use1-bound', row.id)
    mockBodies.set(`approval_request:${row.id}`, {
      projectId: 'p-use1-bound',
      payload: { message: MESSAGE, target: TARGET, toolArgs: { email: 'mallory@example.com', reason: 'spam' } },
    })
    expect(await approve('p-use1-bound', row.id, shown)).toEqual(refused)

    expect(dispatched).not.toHaveBeenCalled()
    expect(statusesOf(row.id)).toEqual([])
    expect(mockApprovals.get(row.id).status).toBe('pending')
    expect(auditOf('p-use1-bound', 'AGENT_APPROVAL_GRANTED')).toBeUndefined()
  })

  it('answers the console with 409 for an approval without the card\'s digest, and runs the call for one with it', async () => {
    mockRegions.set('p-use1-route', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-route'))
    dispatched.mockImplementation(async () => ({ ok: true, summary: 'Blocked' }))

    const blind = await viaRoute('p-use1-route', { approvalId: row.id, decision: 'approve' })
    expect(blind).toMatchObject({ status: 409, body: { success: false, status: 'pending' } })
    expect(dispatched).not.toHaveBeenCalled()

    const shownDigest = await shownOf('p-use1-route', row.id)
    const seen = await viaRoute('p-use1-route', { approvalId: row.id, decision: 'approve', shownDigest })
    expect(seen).toMatchObject({ status: 200, body: { success: true, status: 'executed' } })
    expect(dispatched.mock.calls.map(([tool, args]) => [tool, args])).toEqual([['block_end_user', CALL]])
  })

  it('reads a home project\'s row as stored, and runs its arguments as sent, even when they carry the mark', async () => {
    mockRegions.set('p-home-marked', null)
    const sent = { keptInRegion: true, shape: { email: '[string]' }, email: EMAIL }
    const row = await createApprovalRequest({ ...blockAlice('p-home-marked'), toolArgs: sent })
    expect(mockApprovals.get(row.id)).toMatchObject({ message: MESSAGE, target: TARGET, toolArgs: sent })

    const [listed] = await listApprovals('p-home-marked')
    expect(listed).toMatchObject({ message: MESSAGE, target: TARGET, readable: true, shownDigest: expect.stringMatching(HEX_DIGEST) })
    expect(await getApprovalForProject('p-home-marked', row.id)).toMatchObject({ target: TARGET, readable: true })

    dispatched.mockImplementation(async () => ({ ok: true, summary: 'Blocked' }))
    expect(await approve('p-home-marked', row.id)).toMatchObject({ ok: true, status: 'executed' })
    expect(dispatched.mock.calls.map(([tool, args]) => [tool, args])).toEqual([['block_end_user', sent]])
  })

  it('is rejected without its region', async () => {
    mockRegions.set('p-use1-reject', 'us-east-1')
    const row = await createApprovalRequest(blockAlice('p-use1-reject'))
    mockUnreachable.add('p-use1-reject')
    try {
      expect(await decideApproval({ projectId: 'p-use1-reject', approvalId: row.id, approverUserId: 'u-owner', decision: 'reject' }))
        .toEqual({ ok: true, status: 'rejected' })
    } finally {
      mockUnreachable.delete('p-use1-reject')
    }
    expect(dispatched).not.toHaveBeenCalled()
  })
})

describe('a home project\'s request', () => {
  it('is kept, shown and run from its row as before, and nothing is kept in a region', async () => {
    mockRegions.set('p-home', null)
    const row = await createApprovalRequest(blockAlice('p-home'))

    expect(mockApprovals.get(row.id)).toMatchObject({ message: MESSAGE, target: TARGET, toolArgs: CALL, tool: 'block_end_user' })
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-home')).toEqual([])
    expect(auditOf('p-home', 'AGENT_APPROVAL_REQUESTED').target).toBe(TARGET)
    await flush()
    expect(noticesOf('p-home').map(([, request]) => request.target)).toEqual([TARGET])

    expect((await listApprovals('p-home'))[0]).toMatchObject({ message: MESSAGE, target: TARGET, readable: true })
    expect(await getApprovalForProject('p-home', row.id)).toMatchObject({ target: TARGET, readable: true })
    const { createdAt, expiresAt } = mockApprovals.get(row.id)
    expect(await listPendingAgentApprovals('p-home')).toEqual([
      { id: row.id, tool: 'block_end_user', target: TARGET, createdAt, expiresAt },
    ])

    dispatched.mockImplementation(async () => ({ ok: true, summary: `Blocked ${EMAIL}` }))
    expect(await approve('p-home', row.id)).toEqual({ ok: true, status: 'executed', resultSummary: `Blocked ${EMAIL}` })
    expect(dispatched.mock.calls.map(([tool, args]) => [tool, args])).toEqual([['block_end_user', CALL]])
    expect(mockApprovals.get(row.id).resultSummary).toBe(`Blocked ${EMAIL}`)
  })

  it('checks the digest an approval carries, though it needs none', async () => {
    mockRegions.set('p-home-digest', null)
    const row = await createApprovalRequest(blockAlice('p-home-digest'))
    dispatched.mockImplementation(async () => ({ ok: true, summary: 'Blocked' }))

    expect(await approve('p-home-digest', row.id, 'f'.repeat(64))).toMatchObject({ ok: false, status: 'pending' })
    expect(dispatched).not.toHaveBeenCalled()
    expect(await approve('p-home-digest', row.id, await shownOf('p-home-digest', row.id))).toMatchObject({ ok: true, status: 'executed' })
  })
})

describe('the chat door', () => {
  const blocked = (email: string) => ({
    tool: 'block_end_user',
    args: { email },
    target: `the end-user ${email} (they lose access immediately)`,
    rowCount: null,
    reversible: true,
  })
  async function ask(projectId: string, calls: ReturnType<typeof blocked>[], turn: Record<string, unknown> = {}) {
    mockKeyProject = projectId
    // The model wrote its summary after the gate told it the call would be queued.
    mockBrainTurn = {
      success: true,
      summary: 'I queued the block for your approval.',
      needsUser: false,
      iterations: 2,
      toolsRun: ['finish'],
      classification: { intent: 'DESTRUCTIVE', confidence: 0.9 },
      tokensUsed: 10,
      applied: [],
      blockedCalls: calls,
      ...turn,
    }
    const res = await chat(
      new NextRequest('https://backenly.test/api/mcp/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'mcp_live_test_key' },
        body: JSON.stringify({ message: 'Block the accounts posting spam' }),
      }),
    )
    return { status: res.status, body: await res.json() }
  }

  it('says a stopped call was not queued, and does not report success, when its request could not be created', async () => {
    mockRegions.set('p-use1-chat-down', 'us-east-1')
    mockUnreachable.add('p-use1-chat-down')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() => ask('p-use1-chat-down', [blocked(EMAIL)]))
    } finally {
      mockUnreachable.delete('p-use1-chat-down')
    }
    const { status, body } = answer
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: false,
      code: 'APPROVAL_FAILED',
      retryable: true,
      approval: null,
      notQueued: [{ tool: 'block_end_user', target: blocked(EMAIL).target }],
    })
    expect(body.status).toBeUndefined()
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked(EMAIL).target}.`)
    expect(body.summary).toContain('nothing is waiting in the Review Queue')
    expect(body.summary).not.toContain('⏸')
    expect(rowsOf('p-use1-chat-down')).toEqual([])
  })

  it('names the calls that could not be queued beside the one that was', async () => {
    mockRegions.set('p-use1-chat-some', 'us-east-1')
    mockRefusedWrites.add('bob@example.com')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() => ask('p-use1-chat-some', [blocked('bob@example.com'), blocked(EMAIL)]))
    } finally {
      mockRefusedWrites.delete('bob@example.com')
    }
    const { body } = answer
    expect(body).toMatchObject({
      ok: true,
      status: 'awaiting_approval',
      approval: { status: 'pending' },
      notQueued: [{ tool: 'block_end_user', target: blocked('bob@example.com').target }],
    })
    expect(body.code).toBeUndefined()
    expect(body.summary).toContain('⏸ This operation needs a human')
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked('bob@example.com').target}.`)
    expect(rowsOf('p-use1-chat-some').map((row) => row.id)).toEqual([body.approval.id])
  })

  it('keeps the answer of a turn that applied something, and adds only what was not queued', async () => {
    mockRegions.set('p-use1-chat-applied', 'us-east-1')
    mockUnreachable.add('p-use1-chat-applied')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() =>
        ask('p-use1-chat-applied', [blocked(EMAIL)], { applied: ['Created table `reports`'], toolsRun: ['create_table', 'finish'] }))
    } finally {
      mockUnreachable.delete('p-use1-chat-applied')
    }
    const { body } = answer
    expect(body).toMatchObject({
      ok: true,
      applied: ['Created table `reports`'],
      notQueued: [{ tool: 'block_end_user', target: blocked(EMAIL).target }],
    })
    // Neither a retry nor a failure: the table is in place, and only the block is missing.
    expect(body.code).toBeUndefined()
    expect(body.retryable).toBeUndefined()
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked(EMAIL).target}.`)
  })

  it('keeps the code the brain gave its turn, and adds only what was not queued', async () => {
    mockRegions.set('p-use1-chat-coded', 'us-east-1')
    mockUnreachable.add('p-use1-chat-coded')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() =>
        ask('p-use1-chat-coded', [blocked(EMAIL)], { success: false, failureCode: 'UNVERIFIED', retryable: false }))
    } finally {
      mockUnreachable.delete('p-use1-chat-coded')
    }
    const { body } = answer
    expect(body).toMatchObject({
      ok: false,
      code: 'UNVERIFIED',
      retryable: false,
      notQueued: [{ tool: 'block_end_user', target: blocked(EMAIL).target }],
    })
    expect(body.summary).toContain(`Not queued, and not run: block_end_user on ${blocked(EMAIL).target}.`)
  })

  it('reports a home project\'s calls it could not queue the same way', async () => {
    mockRegions.set('p-home-chat-down', null)
    mockRefusedRows.add('p-home-chat-down')
    let answer: Awaited<ReturnType<typeof ask>>
    try {
      answer = await quietly(() => ask('p-home-chat-down', [blocked(EMAIL)]))
    } finally {
      mockRefusedRows.delete('p-home-chat-down')
    }
    expect(answer.body).toMatchObject({
      ok: false,
      code: 'APPROVAL_FAILED',
      approval: null,
      notQueued: [{ tool: 'block_end_user', target: blocked(EMAIL).target }],
    })
    expect(answer.body.summary).toContain('nothing is waiting in the Review Queue')
  })
})

describe('the activity feed', () => {
  it('says an approved request that ran nothing was not run, never that the agent made a change', async () => {
    mockRegions.set('p-use1-feed', 'us-east-1')
    // Approved, but its region has no record of its call.
    const missing = await createApprovalRequest(blockAlice('p-use1-feed'))
    mockBodies.delete(`approval_request:${missing.id}`)
    expect(await quietly(() => approve('p-use1-feed', missing.id))).toMatchObject({ ok: false, status: 'failed' })
    // Approved, but raised before requests named their exact call.
    mockApprovals.set('unbound-feed', {
      id: 'unbound-feed', projectId: 'p-use1-feed', userId: 'u-agent', apiKeyId: 'k1', tool: 'drop_table',
      message: 'drop the old table', target: 'the `old` table', rowCount: null, reversible: false, toolArgs: null,
      status: 'pending', decidedBy: null, decidedAt: null, executedAt: null, resultSummary: null,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    expect(await approve('p-use1-feed', 'unbound-feed')).toMatchObject({ ok: false, status: 'failed' })

    const labels = (await buildActivityFeed('p-use1-feed', { limit: 20 })).rows.map((row) => row.label)
    expect(labels).toContain('An agent request was not run: its exact call could not be read')
    expect(labels).toContain('An agent request was not run: it named no exact call')
    expect(labels.filter((label) => label.startsWith('Your coding agent made a change'))).toEqual([])
  })
})

describe('how long the region keeps a request', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const savedMode = process.env.BACKENLY_RETENTION_PURGE
  afterEach(() => {
    if (savedMode === undefined) delete process.env.BACKENLY_RETENTION_PURGE
    else process.env.BACKENLY_RETENTION_PURGE = savedMode
  })

  /** A request made in `projectId` and decided `days` ago. */
  async function decided(projectId: string, days: number) {
    const row = await createApprovalRequest(blockAlice(projectId))
    Object.assign(mockApprovals.get(row.id), {
      status: 'rejected',
      decidedAt: new Date(Date.now() - days * DAY_MS),
      expiresAt: new Date(Date.now() - (days - 1) * DAY_MS),
    })
    return row.id
  }
  const kept = (id: string) => ({ row: mockApprovals.has(id), record: mockBodies.has(`approval_request:${id}`) })

  it('is as long as its row: the region does not prune it on a schedule of its own', async () => {
    mockPrunes.length = 0
    await pruneRegionalBodies('us-east-1')
    expect(mockPrunes).toHaveLength(1)
    const [, kinds] = mockPrunes[0]
    expect(kinds).not.toContain('approval_request')
    expect(kinds).toContain('webhook')
  })

  it('ends with its row: the enforced cleanup deletes the record first, and keeps a row whose region cannot be reached', async () => {
    process.env.BACKENLY_RETENTION_PURGE = 'enforce'
    mockRegions.set('p-use1-old', 'us-east-1')
    mockRegions.set('p-use1-old-down', 'us-east-1')
    mockRegions.set('p-home-old', null)
    const gone = await decided('p-use1-old', 91)
    const recent = await decided('p-use1-old', 89)
    const unreachable = await decided('p-use1-old-down', 91)
    const home = await decided('p-home-old', 91)

    mockUnreachable.add('p-use1-old-down')
    let result: Record<string, any>
    try {
      result = await quietly(() => handleCleanupJob({ cleanupType: 'old_logs' }))
    } finally {
      mockUnreachable.delete('p-use1-old-down')
    }

    expect(result).toMatchObject({ retentionMode: 'enforce', approvalRequests: 2 })
    expect(kept(gone)).toEqual({ row: false, record: false })
    expect(mockWrites.filter((w) => w.endsWith(gone)).slice(-2)).toEqual([`forget:${gone}`, `delete:${gone}`])
    expect(kept(home)).toEqual({ row: false, record: false })
    // Its region could not be reached, so its row waits for a later run with its record.
    expect(kept(unreachable)).toEqual({ row: true, record: true })
    expect(kept(recent)).toEqual({ row: true, record: true })

    // The next run, with the region back, finishes the job.
    const again = await handleCleanupJob({ cleanupType: 'old_logs' })
    expect(again).toMatchObject({ approvalRequests: 1 })
    expect(kept(unreachable)).toEqual({ row: false, record: false })
  })

  it('deletes neither a record nor its row until the cleanup is enforced', async () => {
    delete process.env.BACKENLY_RETENTION_PURGE
    mockRegions.set('p-use1-dry', 'us-east-1')
    const old = await decided('p-use1-dry', 91)
    const result = await quietly(() => handleCleanupJob({ cleanupType: 'old_logs' }))
    expect(result).toMatchObject({ retentionMode: 'dry-run', approvalRequests: 0 })
    expect(kept(old)).toEqual({ row: true, record: true })
  })

  it('removes a record again when its row cannot be written', async () => {
    mockRegions.set('p-use1-norow', 'us-east-1')
    mockRefusedRows.add('p-use1-norow')
    try {
      await expect(createApprovalRequest(blockAlice('p-use1-norow'))).rejects.toThrow(/Can't reach database server/)
    } finally {
      mockRefusedRows.delete('p-use1-norow')
    }
    expect(rowsOf('p-use1-norow')).toEqual([])
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-use1-norow')).toEqual([])
  })
})
