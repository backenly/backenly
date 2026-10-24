/**
 * A REGIONAL PROJECT'S HEALTH FINDINGS AND HELD ACTIONS QUOTE NONE OF ITS DATA
 * ============================================================================
 * Health findings and the timeline are platform rows, in the home region. For
 * a project kept in another region (founders' residency table, 2026-10-16):
 *   - a broken contract probe keeps what failed and how (surface, request,
 *     status, size of the answer), never the answer's body or the handler's
 *     message, which can echo a row;
 *   - a repair's error texts (why it failed, why it was escalated, why its
 *     check could not run, why its baseline could not be read) are kept only
 *     when each is an error code, on the finding, in the audit log and in the
 *     reconciler's retry record; the full text goes only to the log of a
 *     process serving that region;
 *   - an action held for approval keeps its target and arguments in the region
 *     (founders: held-action targets move into the region). Its finding keeps
 *     the action, the arguments' shape and the target's stand-in, and its
 *     timeline events name the action only. Approval reads them back and
 *     replays them exactly, runs nothing when the region cannot be read, and
 *     records only their shape and the outcome's status;
 *   - its held actions are not investigated by the model, and an approval
 *     request's notice names the action only.
 * A home project's rows are unchanged, except that no approval records a held
 * action's arguments or result, in any region: the record keeps the arguments'
 * shape and whether it succeeded, since either can carry a secret.
 *
 * Database-free: the platform clients are recorders, each project's region is
 * whatever the test says it is, and a region's database is a map.
 */

const mockRegions = new Map<string, string | null>()
const mockEvents: any[] = []
const mockFindings = new Map<string, any>()
const mockAudits: any[] = []
const mockCorrections: any[] = []
const mockNotifications: any[] = []
/** The order a held action's body and its finding were written in. */
const mockWrites: string[] = []
/** The regional databases' bodies, by kind and id. */
const mockBodies = new Map<string, { projectId: string; payload: unknown }>()
/** Projects whose region this process cannot reach. */
const mockUnreachable = new Set<string>()
const mockExecuted: any[] = []
const mockInvestigated: string[] = []
const mockLoop = {
  executor: (action: any): any => {
    const target = action.params?.email ?? action.params?.key ?? action.params?.tableName
    return { success: true, message: `${action.action} ran on ${target}`, data: { target } }
  },
  baseline: async (): Promise<unknown> => ({}),
  outcome: async (): Promise<unknown> => ({ accepted: true, recheck: 'resolved', regressions: [], regressionCheck: 'ran', reason: '' }),
}

jest.mock('@/lib/db/prisma', () => {
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, want]: [string, any]) => {
      if (key === 'AND') return want.every((clause: any) => matches(row, clause))
      if (key === 'OR') return want.some((clause: any) => matches(row, clause))
      if (key === 'details') return row.details?.[want.path[0]] === want.equals
      if (want && typeof want === 'object' && Array.isArray(want.in)) return want.in.includes(row[key])
      return row[key] === want
    })
  // Copies, as a database returns them: a caller's object is never the stored row.
  const findings = () => [...mockFindings.values()].map((row) => structuredClone(row))
  return {
    prisma: {
      project: {
        findUnique: jest.fn(async ({ where }: any) =>
          mockRegions.has(where.id) ? { region: mockRegions.get(where.id), userId: 'u-owner', name: 'Shop' } : null),
      },
      backendEvent: {
        create: jest.fn(async ({ data }: any) => { mockEvents.push(data); return { id: `e${mockEvents.length}`, ...data } }),
        update: jest.fn(async ({ data }: any) => data),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      healthFinding: {
        findFirst: jest.fn(async ({ where }: any) => findings().find((row) => matches(row, where)) ?? null),
        findUnique: jest.fn(async ({ where }: any) => findings().find((row) => row.id === where.id) ?? null),
        findMany: jest.fn(async ({ where }: any) => findings().filter((row) => matches(row, where))),
        create: jest.fn(async ({ data }: any) => {
          const row = structuredClone({ id: data.id ?? `f${mockFindings.size + 1}`, detectedAt: new Date(), ...data })
          mockWrites.push(`row:${row.id}`)
          mockFindings.set(row.id, row)
          return structuredClone(row)
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = mockFindings.get(where.id)
          if (!row || !matches(row, where)) throw new Error('Record to update not found.')
          return structuredClone(Object.assign(row, structuredClone(data)))
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => { mockAudits.push(data); return data }),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      correctionEvent: { create: jest.fn(async ({ data }: any) => { mockCorrections.push(data); return data }) },
      agentApprovalRequest: { create: jest.fn(async ({ data }: any) => ({ id: 'approval-1', createdAt: new Date(), ...data })) },
      platformNotification: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => { mockNotifications.push(data); return data }),
      },
      notificationPreference: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => null) },
      backendPattern: { upsert: jest.fn(async () => ({})) },
    },
  }
})
jest.mock('@/lib/db', () => jest.requireMock('@/lib/db/prisma'))

// A region's database: bodies in a map, refused for a project whose region
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
        return body && body.projectId === projectId ? { payload: body.payload, responseBody: null, error: null } : null
      }
      return {
        region,
        set: async (kind: string, id: string, fields: any) => {
          reach()
          mockWrites.push(`body:${id}`)
          mockBodies.set(`${kind}:${id}`, { projectId, payload: fields.payload })
        },
        get: async (kind: string, id: string) => { reach(); return read(kind, id) },
        getMany: async (kind: string, ids: string[]) => {
          reach()
          return new Map(ids.flatMap((id) => (read(kind, id) ? [[id, read(kind, id)]] : [])) as any)
        },
        remove: async () => {},
        idsMatching: async () => [],
      }
    }),
  }
})
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  // The schema catalog the investigator is given: names only, none here.
  workspaceRawClient: jest.fn(async () => ({ $queryRawUnsafe: async () => [] })),
}))

// The executor and the loop's checks, which this suite drives rather than runs.
jest.mock('@/lib/ai/minimal-executor', () => ({
  executeAction: jest.fn(async (action: any) => { mockExecuted.push(action); return mockLoop.executor(action) }),
}))
jest.mock('@/lib/ai/build-runtime/build-lock', () => ({
  withBuildLock: jest.fn(async (_projectId: string, _kind: string, fn: () => Promise<unknown>) => ({ result: await fn() })),
}))
jest.mock('@/lib/execution/sql-recorder', () => ({
  installSqlRecorder: jest.fn(),
  withSqlCapture: jest.fn(async (fn: () => Promise<unknown>) => ({ result: await fn(), statements: [] })),
  outsideSqlCapture: jest.fn((fn: () => unknown) => fn()),
}))
jest.mock('@/lib/services/workspace-schema-snapshot', () => ({
  captureSchemaSnapshot: jest.fn(async () => null),
  rollbackToSchemaVersion: jest.fn(),
}))
jest.mock('@/lib/autonomy/desired-state', () => ({
  captureCheckBaseline: jest.fn(() => mockLoop.baseline()),
  evaluateFixOutcome: jest.fn(() => mockLoop.outcome()),
  recheckGap: jest.fn(async () => 'unknown'),
  gapIdentity: (type: string, d: any) => `${type}::${d?.tableName ?? ''}.${d?.columnName ?? ''}`,
}))
jest.mock('@/lib/autonomy/circuit-breaker', () => ({
  checkBreaker: jest.fn(async () => ({ allowed: true })),
  auditBreakerTrip: jest.fn(),
}))
jest.mock('@/lib/autonomy/maintenance/primitives/recovery-restore-policies', () => ({
  capturePolicies: jest.fn(),
  recoveryRestorePolicies: jest.fn(),
  samePolicies: jest.fn(),
}))
jest.mock('@/lib/memory/graph-schema', () => ({ upsertKnownIssue: jest.fn(async () => {}) }))

// The approve route's session and role checks: the project's owner, approving
// on the project the request names.
jest.mock('@/lib/auth/route-protection', () => ({
  withProjectAccess: (handler: any) => (req: any) =>
    handler(req, { user: { userId: 'u-owner', email: 'owner@backenly.test' }, project: {}, projectId: req.projectId }),
}))
jest.mock('@/lib/edition/guard', () => ({ canWriteProject: jest.fn(async () => true) }))

// The approval module's dispatcher and the owner's notice.
jest.mock('@/lib/ai/brain/tools', () => ({ dispatchTool: jest.fn() }))
jest.mock('@/lib/notifications/platform', () => ({ notifyApprovalRequested: jest.fn(async () => {}) }))

// The investigator's model and its deterministic pass.
jest.mock('@/lib/ai/llm', () => ({ AiError: class AiError extends Error {}, generate: jest.fn() }))
jest.mock('@/lib/autonomy/hypothesis', () => ({
  diagnoseFinding: jest.fn(async () => null),
  renderDiagnosis: jest.fn(),
  PROBE_REGISTRY: {},
}))
jest.mock('@/lib/autonomy/ai-proposals', () => ({ proposableFor: jest.fn(() => []), proposeRepair: jest.fn() }))
jest.mock('@/lib/autonomy/investigator', () => ({
  investigateFinding: jest.fn(async (input: any) => {
    mockInvestigated.push(input.finding.type)
    return {
      verdict: 'uncertain', rootCause: 'unclear', recommendation: 'look', riskNote: '', evidenceRefs: [], ruledOut: [],
      proposedAction: null, namedTables: [], namedColumns: [], evidence: [], validation: { ok: true, problems: [] }, model: 'test',
    }
  }),
}))

import { randomBytes } from 'crypto'
import { NOT_QUOTED, findingDetailsKeptHere, quotedError } from '@/lib/data-plane/residency'
import { settleTenantContract, withoutHandlerMessage } from '@/lib/services/contract-verifier'
import { queuePendingActionFinding } from '@/lib/operational-memory/ledger'
import { heldTargetStandIn, withHeldActions } from '@/lib/operational-memory/held-action-targets'
import { sealParams } from '@/lib/operational-memory/sealed-params'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { runAutoFix } from '@/lib/core/auto-fix-engine'
import { ensureFinding } from '@/lib/autonomy/reconciler'
import { diagnoseEscalatedFindings } from '@/lib/autonomy/escalation-diagnosis'
import { createApprovalRequest, getParkedActionForProject } from '@/lib/mcp/approvals'
import { notifyApprovalRequested } from '@/lib/notifications/platform'
import { POST as approve } from '@/app/api/projects/[id]/health/approve/route'

const ROW_ECHO = 'invalid input syntax for type uuid: "alice@example.com"'
// Shaped like nothing real, so the public repository's secret scanner passes it.
const SECRET = 'fixture-supersecret-value-1234567890abcdef'

// Sealing a held action's arguments refuses a short signing secret, as CI's
// is; a random sealing-grade one for this file only, never a literal.
const savedSecret = process.env.JWT_SECRET
beforeAll(() => { process.env.JWT_SECRET = randomBytes(48).toString('base64') })
afterAll(() => { process.env.JWT_SECRET = savedSecret })

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

const blockAlice = (projectId: string) => ({
  projectId,
  action: 'BLOCK_USER',
  params: { userId: 'u_123', email: 'alice@example.com' },
  target: 'alice@example.com',
  riskLevel: 'medium' as const,
  source: 'brain-risk' as const,
  reason: 'Blocking an end user needs the owner',
})

const forProject = (rows: any[], projectId: string) => rows.filter((row) => row.projectId === projectId)
const auditOf = (projectId: string, action: string) => {
  const row = mockAudits.find((a) => a.projectId === projectId && a.action === action)
  return row ? JSON.parse(row.details) : undefined
}

async function approveFinding(projectId: string, findingId: string) {
  const res: any = await approve({ projectId, json: async () => ({ findingId }) } as any)
  return { status: res.status as number, body: await res.json() }
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

  it('keeps every error text of a regional finding only as an error code', async () => {
    mockRegions.set('p-use1-texts', 'us-east-1')
    const details = await findingDetailsKeptHere('p-use1-texts', 'missing_fk_index', {
      tableName: 'orders',
      escalation: { reason: ROW_ECHO, retryCount: 1 },
      appliedUnverified: { verifierError: ROW_ECHO, reason: `The fix ran, but the check could not complete: ${ROW_ECHO}.`, statements: [] },
      rollbackData: { baselineError: ROW_ECHO, rollbackFormat: 2 },
    })
    expect(details).toEqual({
      tableName: 'orders',
      escalation: { reason: NOT_QUOTED, retryCount: 1 },
      appliedUnverified: { verifierError: NOT_QUOTED, reason: NOT_QUOTED, statements: [] },
      rollbackData: { baselineError: NOT_QUOTED, rollbackFormat: 2 },
    })
  })

  it('keeps a home finding\'s error texts as they are', async () => {
    mockRegions.set('p-home-texts', null)
    const kept = {
      tableName: 'orders',
      appliedUnverified: { verifierError: ROW_ECHO, reason: `The fix ran, but the check could not complete: ${ROW_ECHO}.`, statements: [] },
    }
    expect(await findingDetailsKeptHere('p-home-texts', 'missing_fk_index', kept)).toEqual(kept)
  })
})

describe('the loop\'s repairs', () => {
  const repairable = (projectId: string, region: string | null) => {
    mockRegions.set(projectId, region)
    const id = `fx-${projectId}`
    mockFindings.set(id, {
      id, projectId, type: 'missing_fk_index', severity: 'warning', status: 'open', detectedAt: new Date(),
      details: { tableName: 'orders', columnName: 'customer_id' },
    })
    return id
  }
  const human = { actor: { kind: 'human' as const, userId: 'u-owner' }, skipCooldown: true }
  const saved = { ...mockLoop }
  afterEach(() => Object.assign(mockLoop, saved))

  it.each([
    ['p-home-esc', null, ROW_ECHO],
    ['p-use1-esc', 'us-east-1', NOT_QUOTED],
  ])('escalate a failure with its text kept as the region allows (%s)', async (projectId, region, kept) => {
    const id = repairable(projectId, region)
    mockLoop.executor = () => ({ success: false, message: ROW_ECHO, error: ROW_ECHO })
    expect((await runAutoFix(id, projectId, human)).outcome).toBe('escalated')
    expect(mockFindings.get(id).details.escalation.reason).toBe(kept)
    expect(auditOf(projectId, 'HEALTH_FIX_ESCALATED').escalationReason).toBe(kept)
  })

  it.each([
    ['p-home-unv', null, ROW_ECHO],
    ['p-use1-unv', 'us-east-1', NOT_QUOTED],
  ])('record a repair whose check could not run with its error kept as the region allows (%s)', async (projectId, region, kept) => {
    const id = repairable(projectId, region)
    mockLoop.outcome = async () => { throw new Error(ROW_ECHO) }
    expect((await runAutoFix(id, projectId, human)).outcome).toBe('applied_unverified')
    const details = mockFindings.get(id).details
    expect(details.appliedUnverified.verifierError).toBe(kept)
    if (region) expect(details.escalation.reason).toBe(NOT_QUOTED)
    else expect(details.escalation.reason).toContain(ROW_ECHO)
    expect(auditOf(projectId, 'HEALTH_FIX_UNVERIFIED').verifierError).toBe(kept)
  })

  it.each([
    ['p-home-base', null, ROW_ECHO],
    ['p-use1-base', 'us-east-1', NOT_QUOTED],
  ])('record a repair whose baseline could not be read with that error kept as the region allows (%s)', async (projectId, region, kept) => {
    const id = repairable(projectId, region)
    mockLoop.baseline = async () => { throw new Error(ROW_ECHO) }
    mockLoop.executor = () => ({ success: true, message: `Indexed orders after ${ROW_ECHO}` })
    expect((await runAutoFix(id, projectId, human)).outcome).toBe('auto_fixed')
    expect(mockFindings.get(id).details.rollbackData.baselineError).toBe(kept)
    expect(auditOf(projectId, 'HEALTH_AUTO_FIXED').message).toBe(region ? NOT_QUOTED : `Indexed orders after ${ROW_ECHO}`)
  })

  it.each([
    ['p-home-retry', null, ROW_ECHO],
    ['p-use1-retry', 'us-east-1', NOT_QUOTED],
  ])('hand a failed repair back to the loop with its failure copied as the region allows (%s)', async (projectId, region, kept) => {
    mockRegions.set(projectId, region)
    const id = `esc-${projectId}`
    const details = { tableName: 'orders', columnName: 'customer_id' }
    mockFindings.set(id, {
      id, projectId, type: 'missing_fk_index', severity: 'warning', status: 'pending_approval', detectedAt: new Date(),
      details: { ...details, escalation: { reason: ROW_ECHO } },
    })
    const result = await ensureFinding(projectId, { invariantId: 'fk-indexed', type: 'missing_fk_index', severity: 'warning', tier: 1, details } as any)
    expect(result).toEqual({ findingId: id, skip: null })
    expect(auditOf(projectId, 'AUTONOMY_ESCALATION_RETRIED').priorFailure).toBe(kept)
  })
})

describe('an action held for approval', () => {
  it('keeps its target and arguments on the finding and names the target on the timeline for a home project', async () => {
    mockRegions.set('p-home-held', null)
    const finding = await queuePendingActionFinding(blockAlice('p-home-held'))
    const [event] = forProject(mockEvents, 'p-home-held')
    expect(event.summary).toContain('alice@example.com')
    expect(event.afterState).toEqual({ executorAction: 'BLOCK_USER', target: 'alice@example.com' })
    expect(mockFindings.get(finding.id).details).toMatchObject({
      title: 'Block user on alice@example.com',
      location: 'alice@example.com',
      executorAction: 'BLOCK_USER',
      executorParams: { userId: 'u_123', email: 'alice@example.com' },
    })
    expect(typeof mockFindings.get(finding.id).details.executorParamsSealed).toBe('string')
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-home-held')).toEqual([])
  })

  it('keeps its target and arguments in a regional project\'s region, written before the finding, under its id', async () => {
    mockRegions.set('p-use1-held', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-held'))
    const row = mockFindings.get(finding.id)

    // The platform row: the action, the arguments' shape and the target's stand-in.
    expect(row.details).toEqual({
      title: 'Block user',
      location: heldTargetStandIn('p-use1-held', 'alice@example.com'),
      executorParamsShape: { userId: '[string]', email: '[string]' },
      keptInRegion: true,
      description: 'Blocking an end user needs the owner',
      source: 'brain-risk',
      executorAction: 'BLOCK_USER',
      backendEventId: expect.any(String),
    })
    expect(JSON.stringify(row)).not.toContain('alice@example.com')

    // The region: the target, the display copy and the sealed copy.
    const body = mockBodies.get(`held_action:${finding.id}`)
    expect(body?.projectId).toBe('p-use1-held')
    expect(body?.payload).toMatchObject({
      title: 'Block user on alice@example.com',
      location: 'alice@example.com',
      executorParams: { userId: 'u_123', email: 'alice@example.com' },
      executorParamsSealed: expect.any(String),
    })
    expect(mockWrites.filter((w) => w.endsWith(finding.id))).toEqual([`body:${finding.id}`, `row:${finding.id}`])

    // The timeline names the action only.
    const [event] = forProject(mockEvents, 'p-use1-held')
    expect(event.summary).toBe('Held for your approval: Block user.')
    expect(event.afterState).toEqual({ executorAction: 'BLOCK_USER' })
    expect(JSON.stringify(event)).not.toContain('alice@example.com')
  })

  it('is found again by its target\'s stand-in instead of being held twice', async () => {
    mockRegions.set('p-use1-dup', 'us-east-1')
    const first = await queuePendingActionFinding(blockAlice('p-use1-dup'))
    const again = await queuePendingActionFinding(blockAlice('p-use1-dup'))
    expect(again.id).toBe(first.id)
    expect([...mockBodies.values()].filter((b) => b.projectId === 'p-use1-dup')).toHaveLength(1)
  })

  it('is shown to the approver with its target from the region, and as the platform row when the region cannot be read', async () => {
    mockRegions.set('p-use1-show', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-show'))
    const [shown] = await withHeldActions('p-use1-show', [mockFindings.get(finding.id)])
    expect(shown.details).toMatchObject({
      title: 'Block user on alice@example.com',
      location: 'alice@example.com',
      executorParams: { userId: 'u_123', email: 'alice@example.com' },
    })
    expect(shown.details.keptInRegion).toBeUndefined()
    expect(await getParkedActionForProject('p-use1-show', finding.id)).toMatchObject({ tool: 'BLOCK_USER', target: 'alice@example.com' })

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mockUnreachable.add('p-use1-show')
      const [unread] = await withHeldActions('p-use1-show', [mockFindings.get(finding.id)])
      expect(unread.details).toEqual(mockFindings.get(finding.id).details)
      // Not replayable as it stands, and the queue says why rather than "not recorded".
      expect(buildFixAction('ai_action_pending', unread.details as Record<string, unknown>)).toBeNull()
      expect(getManualRemediationHint('ai_action_pending', unread.details as Record<string, unknown>)).toMatch(/kept in your project’s region/)
      expect(await getParkedActionForProject('p-use1-show', finding.id)).toMatchObject({ tool: 'BLOCK_USER', target: null })
    } finally {
      mockUnreachable.delete('p-use1-show')
      warn.mockRestore()
    }
  })
})

describe('approving a held action', () => {
  beforeEach(() => {
    mockExecuted.length = 0
    mockLoop.baseline = async () => { throw new Error(ROW_ECHO) }
  })
  afterEach(() => {
    mockLoop.baseline = async () => ({})
  })

  it('replays the exact arguments from a regional project\'s region and keeps no copy of them or of the outcome\'s text', async () => {
    mockRegions.set('p-use1-ok', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-ok'))
    const { status, body } = await approveFinding('p-use1-ok', finding.id)

    expect(status).toBe(200)
    expect(mockExecuted).toEqual([{ action: 'BLOCK_USER', params: { userId: 'u_123', email: 'alice@example.com', confirmed: true } }])
    // The approver reads the outcome in full; nothing stored quotes it.
    expect(body.message).toBe('BLOCK_USER ran on alice@example.com')

    const row = mockFindings.get(finding.id)
    expect(row.status).toBe('auto_fixed')
    expect(row.details.rollbackData).toMatchObject({
      fixAction: { action: 'BLOCK_USER', params: { userId: '[string]', email: '[string]', confirmed: true } },
      fixResult: { success: true },
      baselineError: NOT_QUOTED,
    })
    expect(JSON.stringify(row)).not.toContain('alice@example.com')

    expect(auditOf('p-use1-ok', 'HEALTH_FIX_EXECUTED').message).toBe(NOT_QUOTED)
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-ok'))).not.toContain('alice@example.com')

    const [history] = forProject(mockCorrections, 'p-use1-ok')
    expect(history.correctionDetail.details).toMatchObject({
      executorAction: 'BLOCK_USER',
      executorParamsShape: { userId: '[string]', email: '[string]' },
    })
    expect(JSON.stringify(history)).not.toContain('alice@example.com')

    const events = forProject(mockEvents, 'p-use1-ok')
    expect(events.map((e) => e.summary)).toEqual(['Held for your approval: Block user.', 'You approved: Block user.'])
    expect(JSON.stringify(events)).not.toContain('alice@example.com')
  })

  it('keeps today\'s copies for a home project, except the arguments and the result, of which the record keeps the shape and whether it succeeded', async () => {
    mockRegions.set('p-home-ok', null)
    const finding = await queuePendingActionFinding({
      projectId: 'p-home-ok',
      action: 'SET_ENV_VAR',
      params: { key: 'STRIPE_SECRET_KEY', value: SECRET },
      target: 'STRIPE_SECRET_KEY',
      riskLevel: 'medium',
      source: 'brain-risk',
      reason: 'Setting a secret needs the owner',
    })
    const { status } = await approveFinding('p-home-ok', finding.id)

    expect(status).toBe(200)
    expect(mockExecuted).toEqual([{ action: 'SET_ENV_VAR', params: { key: 'STRIPE_SECRET_KEY', value: SECRET, confirmed: true } }])

    const row = mockFindings.get(finding.id)
    expect(row.details).toMatchObject({
      title: 'Set env var on STRIPE_SECRET_KEY',
      location: 'STRIPE_SECRET_KEY',
      executorParams: { key: 'STRIPE_SECRET_KEY', value: '[withheld]' },
    })
    expect(row.details.rollbackData).toMatchObject({
      fixAction: { action: 'SET_ENV_VAR', params: { key: '[string]', value: '[string]', confirmed: true } },
      baselineError: ROW_ECHO,
    })
    expect(row.details.rollbackData.fixResult).toEqual({ success: true })
    // The secret was replayed and is stored nowhere in the clear.
    expect(JSON.stringify(row)).not.toContain(SECRET)
    expect(JSON.stringify(forProject(mockAudits, 'p-home-ok'))).not.toContain(SECRET)

    expect(auditOf('p-home-ok', 'HEALTH_FIX_EXECUTED').message).toBe('Ran SET_ENV_VAR')
    expect(forProject(mockCorrections, 'p-home-ok')[0].correctionDetail.details.location).toBe('STRIPE_SECRET_KEY')
    expect(forProject(mockEvents, 'p-home-ok').map((e) => e.summary)).toEqual([
      'Held for your approval: Set env var on STRIPE_SECRET_KEY.',
      'You approved: Set env var on STRIPE_SECRET_KEY.',
    ])
  })

  it('runs nothing and says so when the region keeping the arguments cannot be reached', async () => {
    mockRegions.set('p-use1-down', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockUnreachable.add('p-use1-down')
    try {
      const { status, body } = await approveFinding('p-use1-down', finding.id)
      expect(status).toBe(503)
      expect(body.error).toMatch(/kept in the project’s region, which could not be reached, so nothing was run/)
    } finally {
      mockUnreachable.delete('p-use1-down')
      warn.mockRestore()
    }
    expect(mockExecuted).toEqual([])
    expect(mockFindings.get(finding.id).status).toBe('pending_approval')
    expect(auditOf('p-use1-down', 'HEALTH_FIX_EXECUTION_FAILED').error).toBe(NOT_QUOTED)
  })

  it('runs nothing when the region no longer has the arguments', async () => {
    mockRegions.set('p-use1-gone', 'us-east-1')
    const finding = await queuePendingActionFinding(blockAlice('p-use1-gone'))
    mockBodies.delete(`held_action:${finding.id}`)
    const { status, body } = await approveFinding('p-use1-gone', finding.id)
    expect(status).toBe(500)
    expect(body.error).toMatch(/not found in the project’s region, so it cannot be replayed and nothing was run/)
    expect(mockExecuted).toEqual([])
    expect(mockFindings.get(finding.id).status).toBe('pending_approval')
  })

  it('approves a regional row written before targets moved to the region, and its copies name only the action', async () => {
    mockRegions.set('p-use1-legacy', 'us-east-1')
    mockFindings.set('held-legacy', {
      id: 'held-legacy', projectId: 'p-use1-legacy', type: 'ai_action_pending', severity: 'warning',
      status: 'pending_approval', detectedAt: new Date(),
      details: {
        title: 'Block user on alice@example.com',
        location: 'alice@example.com',
        executorAction: 'BLOCK_USER',
        executorParams: { userId: 'u_123', email: 'alice@example.com' },
        executorParamsSealed: sealParams({ userId: 'u_123', email: 'alice@example.com' }),
      },
    })
    const { status } = await approveFinding('p-use1-legacy', 'held-legacy')

    expect(status).toBe(200)
    expect(mockExecuted).toEqual([{ action: 'BLOCK_USER', params: { userId: 'u_123', email: 'alice@example.com', confirmed: true } }])
    expect(forProject(mockEvents, 'p-use1-legacy').map((e) => e.summary)).toEqual(['You approved: Block user.'])
    expect(forProject(mockCorrections, 'p-use1-legacy')[0].correctionDetail.details).toMatchObject({
      executorAction: 'BLOCK_USER',
      executorParamsShape: { userId: '[string]', email: '[string]' },
    })
    expect(JSON.stringify(forProject(mockCorrections, 'p-use1-legacy'))).not.toContain('alice@example.com')
    expect(JSON.stringify(forProject(mockAudits, 'p-use1-legacy'))).not.toContain('alice@example.com')
    expect(JSON.stringify(mockFindings.get('held-legacy').details.rollbackData)).not.toContain('alice@example.com')
  })
})

describe('the investigator', () => {
  it.each([
    ['p-home-diag', null, ['ai_action_pending', 'missing_fk']],
    ['p-use1-diag', 'us-east-1', ['missing_fk']],
  ])('investigates a regional project\'s held action never, a home one\'s as before (%s)', async (projectId, region, investigated) => {
    mockRegions.set(projectId, region)
    mockInvestigated.length = 0
    await queuePendingActionFinding(blockAlice(projectId))
    mockFindings.set(`fk-${projectId}`, {
      id: `fk-${projectId}`, projectId, type: 'missing_fk', severity: 'warning', status: 'pending_approval',
      detectedAt: new Date(), details: { tableName: 'orders', columnName: 'customer_id' },
    })
    await diagnoseEscalatedFindings(projectId)
    expect([...mockInvestigated].sort()).toEqual(investigated)
  })
})

describe('an approval request\'s notice', () => {
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }
  const request = (projectId: string) =>
    createApprovalRequest({
      projectId,
      userId: 'u-owner',
      message: 'drop the customers table',
      danger: { tool: 'drop_table', target: 'customers', rowCount: 12, reversible: false },
      toolArgs: { table: 'customers' },
    })

  it.each([
    ['p-home-notice', null, 'customers'],
    ['p-use1-notice', 'us-east-1', null],
  ])('names the target for a home project and only the action for a regional one (%s)', async (projectId, region, target) => {
    mockRegions.set(projectId, region)
    const notify = notifyApprovalRequested as jest.Mock
    notify.mockClear()
    await request(projectId)
    await flush()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toMatchObject({ projectId, tool: 'drop_table', target })
  })

  it('says only the action when it has no target', async () => {
    const { notifyApprovalRequested: real } = jest.requireActual('@/lib/notifications/platform')
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      mockNotifications.length = 0
      const expiresAt = new Date('2026-10-19T12:00:00Z')
      await real('u-owner', { projectId: 'p-use1-notice', projectName: 'Shop', approvalId: 'a1', tool: 'drop_table', target: null, expiresAt })
      await real('u-owner', { projectId: 'p-home-notice', projectName: 'Shop', approvalId: 'a2', tool: 'drop_table', target: 'customers', expiresAt })
    } finally {
      log.mockRestore()
    }
    const [regional, home] = mockNotifications
    expect(regional.body).toMatch(/^It asked to run drop_table\. Approve or reject it/)
    expect(regional.metadata.target).toBeUndefined()
    expect(home.body).toMatch(/^It asked to run drop_table on customers\. Approve or reject it/)
    expect(home.metadata.target).toBe('customers')
  })
})
