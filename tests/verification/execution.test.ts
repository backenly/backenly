/**
 * Phase 13 — Verification Executor tests
 * ----------------------------------------
 * Verifies that:
 *   1. dry_run mode skips all scenarios (no live execution)
 *   2. safe_live mode only runs SAFE_LIVE_CATEGORIES (auth, rls, state_machine, security)
 *   3. blocked categories (billing, webhook, storage, admin, runtime) are always skipped
 *   4. Scenarios not marked safeLiveEligible are skipped even in safe_live mode
 *   5. Failed scenarios produce correct ScenarioResult shape
 *   6. Passed scenarios produce correct ScenarioResult shape
 *   7. runBuiltInVerification returns the expected structure (no real DB calls — mocked)
 *   8. No external side effects occur during any mode
 *
 * No real DB is used. DB calls inside the executor are mocked so these tests
 * are fully offline.
 */

// `jest` is deliberately NOT imported from '@jest/globals' here. ts-jest hoists
// `jest.mock(...)` above the imports only when `jest` is the global; importing
// the identifier shadows it, the hoist does not happen, and the real modules get
// imported before the mock factories are registered. That is what broke this
// suite: `queryWorkspaceSchema` arrived as the real function, `mockImplementation
// is not a function` cascaded through 24 of its 25 cases, and the Phase-13 safety
// gates below — the assertion that billing/webhook/storage/admin/runtime
// verification NEVER executes live — silently stopped being checked at all.
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals'
import {
  executeVerificationScenarios,
  runBuiltInVerification,
  type VerificationExecutionMode,
} from '@/lib/verification/verification-executor'
import type { ScenarioDryRunResult } from '@/lib/verification/behavior-runner'

// ─── Mock DB dependencies ─────────────────────────────────────────────────────

jest.mock('@/lib/services/workspaceDatabase', () => ({
  queryWorkspaceSchema: jest.fn(),
}))
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: {
      findUnique: jest.fn(),
    },
  },
}))

import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { prisma } from '@/lib/db/prisma'

const mockQuery = queryWorkspaceSchema as jest.MockedFunction<typeof queryWorkspaceSchema>
const mockFindUnique = (prisma.project.findUnique as jest.MockedFunction<any>)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScenario(
  overrides: Partial<ScenarioDryRunResult> = {},
): ScenarioDryRunResult {
  return {
    scenarioId: 'test_scenario',
    name: 'Test scenario',
    category: 'auth',
    severity: 'high',
    status: 'planned',
    reason: 'Planned',
    steps: [],
    expectedResult: 'Should pass',
    failureMeaning: 'Auth broken',
    blockedBy: [],
    safeLiveEligible: true,
    ...overrides,
  }
}

// ─── dry_run mode ─────────────────────────────────────────────────────────────

describe('dry_run mode', () => {
  test('skips all scenarios regardless of category', async () => {
    const scenarios = [
      makeScenario({ scenarioId: 'a', category: 'auth', safeLiveEligible: true }),
      makeScenario({ scenarioId: 'b', category: 'rls', safeLiveEligible: true }),
      makeScenario({ scenarioId: 'c', category: 'billing', safeLiveEligible: false }),
    ]
    const result = await executeVerificationScenarios(scenarios, {
      projectId: 'proj1',
      mode: 'dry_run',
    })
    expect(result.passed).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
    expect(result.skipped).toHaveLength(3)
    expect(result.total).toBe(3)
  })

  test('makes no DB calls in dry_run mode', async () => {
    const scenarios = [makeScenario({ safeLiveEligible: true })]
    await executeVerificationScenarios(scenarios, { projectId: 'proj1', mode: 'dry_run' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  test('skipped reason references dry_run', async () => {
    const result = await executeVerificationScenarios(
      [makeScenario()],
      { projectId: 'proj1', mode: 'dry_run' },
    )
    expect(result.skipped[0].reason).toContain('dry_run')
  })
})

// ─── safe_live category restrictions ─────────────────────────────────────────

describe('safe_live mode — category safety gates', () => {
  beforeEach(() => {
    // Default: workspace has users table + JWT configured + RLS clean + no status tables
    mockQuery.mockImplementation(async (_pid: string, sql: string) => {
      if (sql.includes("table_name = 'users'")) return { rows: [{ cnt: '1' }] }
      if (sql.includes('relrowsecurity')) return { rows: [] }          // no unprotected tables
      if (sql.includes("column_name = 'status'")) return { rows: [] } // no status columns
      if (sql.includes("user_id") && sql.includes('NOT COALESCE')) return { rows: [] }
      return { rows: [] }
    })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'super-secret' })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  const BLOCKED = ['billing', 'webhook', 'storage', 'admin', 'runtime'] as const
  for (const cat of BLOCKED) {
    test(`category "${cat}" is skipped even when safeLiveEligible=true`, async () => {
      const result = await executeVerificationScenarios(
        [makeScenario({ category: cat as any, safeLiveEligible: true })],
        { projectId: 'proj1', mode: 'safe_live' },
      )
      expect(result.skipped).toHaveLength(1)
      expect(result.passed).toHaveLength(0)
      expect(result.failed).toHaveLength(0)
    })
  }

  const ALLOWED = ['auth', 'rls', 'state_machine', 'security'] as const
  for (const cat of ALLOWED) {
    test(`category "${cat}" runs in safe_live mode when eligible`, async () => {
      const result = await executeVerificationScenarios(
        [makeScenario({ scenarioId: cat, category: cat as any, safeLiveEligible: true })],
        { projectId: 'proj1', mode: 'safe_live' },
      )
      // Should have processed the scenario (passed or failed, not skipped)
      expect(result.skipped).toHaveLength(0)
      expect(result.passed.length + result.failed.length).toBe(1)
    })
  }

  test('scenario with safeLiveEligible=false is skipped in safe_live mode', async () => {
    const result = await executeVerificationScenarios(
      [makeScenario({ category: 'auth', safeLiveEligible: false })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toContain('safeLiveEligible')
  })

  test('blocked scenario (status!=planned) is skipped', async () => {
    const result = await executeVerificationScenarios(
      [makeScenario({ category: 'auth', status: 'blocked', safeLiveEligible: false })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.skipped).toHaveLength(1)
  })
})

// ─── Structural check outcomes ────────────────────────────────────────────────

describe('safe_live structural checks — pass conditions', () => {
  afterEach(() => jest.clearAllMocks())

  test('auth scenario passes when users table exists + JWT configured', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cnt: '1' }] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'secret123' })

    const result = await executeVerificationScenarios(
      [makeScenario({ scenarioId: 'auth_pass', category: 'auth', safeLiveEligible: true })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.passed).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
    expect(result.passed[0].outcome).toBe('passed')
  })

  test('auth scenario fails when users table is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cnt: '0' }] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'secret123' })

    const result = await executeVerificationScenarios(
      [makeScenario({ scenarioId: 'auth_fail', category: 'auth', safeLiveEligible: true })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].outcome).toBe('failed')
    expect(result.failed[0].checks.some(c => !c.passed)).toBe(true)
  })

  test('auth scenario fails when JWT secret is empty', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cnt: '1' }] })
    mockFindUnique.mockResolvedValue({ jwtSecret: '' })

    const result = await executeVerificationScenarios(
      [makeScenario({ scenarioId: 'auth_no_jwt', category: 'auth', safeLiveEligible: true })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.failed).toHaveLength(1)
  })

  test('rls scenario passes when no unprotected user tables', async () => {
    mockQuery.mockResolvedValue({ rows: [] }) // no unprotected tables
    const result = await executeVerificationScenarios(
      [makeScenario({ scenarioId: 'rls_pass', category: 'rls', safeLiveEligible: true })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.passed).toHaveLength(1)
  })

  test('rls scenario fails when unprotected tables found', async () => {
    mockQuery.mockResolvedValue({ rows: [{ tablename: 'posts' }] })
    const result = await executeVerificationScenarios(
      [makeScenario({ scenarioId: 'rls_fail', category: 'rls', safeLiveEligible: true })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].checks[0].message).toContain('posts')
  })
})

// ─── ScenarioResult shape ─────────────────────────────────────────────────────

describe('ScenarioResult shape', () => {
  afterEach(() => jest.clearAllMocks())

  test('result carries correct scenarioId, name, category, severity', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cnt: '1' }] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'x' })

    const result = await executeVerificationScenarios(
      [makeScenario({
        scenarioId: 'my_scenario',
        name: 'My auth scenario',
        category: 'auth',
        severity: 'critical',
        safeLiveEligible: true,
      })],
      { projectId: 'proj1', mode: 'safe_live' },
    )
    const sr = result.passed[0] ?? result.failed[0]
    expect(sr.scenarioId).toBe('my_scenario')
    expect(sr.name).toBe('My auth scenario')
    expect(sr.category).toBe('auth')
    expect(sr.severity).toBe('critical')
    expect(typeof sr.durationMs).toBe('number')
    expect(typeof sr.executedAt).toBe('string')
    expect(Array.isArray(sr.checks)).toBe(true)
  })

  test('result totals are consistent', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'x' })

    const scenarios = [
      makeScenario({ scenarioId: 'a', category: 'auth', safeLiveEligible: true }),
      makeScenario({ scenarioId: 'b', category: 'billing', safeLiveEligible: false }),
    ]
    const result = await executeVerificationScenarios(scenarios, {
      projectId: 'proj1',
      mode: 'safe_live',
    })
    expect(result.total).toBe(2)
    expect(result.passed.length + result.failed.length + result.skipped.length).toBe(2)
  })
})

// ─── runBuiltInVerification ───────────────────────────────────────────────────

describe('runBuiltInVerification', () => {
  afterEach(() => jest.clearAllMocks())

  test('returns the expected result shape', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'x' })

    const result = await runBuiltInVerification('proj1')
    expect(typeof result.total).toBe('number')
    expect(typeof result.durationMs).toBe('number')
    expect(typeof result.executedAt).toBe('string')
    expect(Array.isArray(result.passed)).toBe(true)
    expect(Array.isArray(result.failed)).toBe(true)
    expect(Array.isArray(result.skipped)).toBe(true)
    expect(result.passed.length + result.failed.length + result.skipped.length).toBe(result.total)
  })

  test('all checks pass on a healthy workspace', async () => {
    mockQuery.mockImplementation(async (_pid: string, sql: string) => {
      if (sql.includes("table_name = 'users'")) return { rows: [{ cnt: '1' }] }
      if (sql.includes("column_name = 'status'")) return { rows: [] } // no status columns
      if (sql.includes('relrowsecurity') || sql.includes('user_id')) return { rows: [] }
      return { rows: [] }
    })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'secure-secret' })

    const result = await runBuiltInVerification('healthy_proj')
    expect(result.failed).toHaveLength(0)
    expect(result.passed.length).toBeGreaterThan(0)
  })

  test('auth checks fail when project has no jwtSecret', async () => {
    mockQuery.mockImplementation(async (_pid: string, sql: string) => {
      if (sql.includes("table_name = 'users'")) return { rows: [{ cnt: '0' }] }
      return { rows: [] }
    })
    mockFindUnique.mockResolvedValue({ jwtSecret: null })

    const result = await runBuiltInVerification('unhealthy_proj')
    const authFailed = result.failed.filter(s => s.category === 'auth')
    expect(authFailed.length).toBeGreaterThan(0)
  })

  test('no external HTTP calls are made', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    mockFindUnique.mockResolvedValue({ jwtSecret: 'x' })

    const originalFetch = global.fetch
    const fetchSpy = jest.fn()
    global.fetch = fetchSpy

    await runBuiltInVerification('proj_nofetch')

    global.fetch = originalFetch
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
