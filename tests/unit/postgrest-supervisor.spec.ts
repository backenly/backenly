/**
 * The supervisor restarts a process that serves EVERY tenant. It is the widest
 * blast radius the autonomy loop can reach for, so the tests here are about the
 * branches where it must decline to act — a needless restart of a healthy data
 * plane is a real outage, not a degraded path.
 *
 * The four properties that make the restart safe to automate, one describe
 * block each:
 *
 *   1. Verified, not reported  — the per-project finding never decides; the
 *      independent platform probe does, and a healthy probe means no restart.
 *   2. Single-flight           — every project detects the same outage at once;
 *      that must collapse to one restart, not N.
 *   3. Rate-ceilinged          — a fault that survives a restart must degrade
 *      into one honest escalation, never a restart loop.
 *   4. Verified recovery       — the restart command returning 0 is not the
 *      data plane answering, and must never be reported as a fix.
 */

const mockDiagnoseAndHeal = jest.fn()
const mockProbePostgrest = jest.fn()
const mockExec = jest.fn()

jest.mock('@/lib/postgrest/health', () => ({
  diagnoseAndHeal: (...a: unknown[]) => mockDiagnoseAndHeal(...a),
  probePostgrest: (...a: unknown[]) => mockProbePostgrest(...a),
}))

// `$queryRaw` is the advisory lock (tagged template) and `auditLog` records the
// restart history the cooldown reads. Both are driven per-test.
const mockQueryRaw = jest.fn()
const mockAuditFindFirst = jest.fn()
const mockAuditCreate = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    auditLog: {
      findFirst: (...a: unknown[]) => mockAuditFindFirst(...a),
      create: (...a: unknown[]) => mockAuditCreate(...a),
    },
  },
}))

jest.mock('node:child_process', () => ({ exec: (...a: unknown[]) => mockExec(...a) }))

import { healDataPlane, describeHeal } from '@/lib/postgrest/supervisor'

const HEALTHY = { state: 'healthy', latencyMs: 3 } as const
const DOWN = { state: 'unreachable', detail: 'ECONNREFUSED' } as const

/** promisify(exec) resolves when the callback is called with (null, stdout, stderr). */
function execSucceeds() {
  mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
    cb(null, 'ok', '')
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.POSTGREST_RESTART_COMMAND
  delete process.env.POSTGREST_LOCAL_RESTART_COMMAND
  // Default: lock is free, no restart history.
  mockQueryRaw.mockResolvedValue([{ acquired: true }])
  mockAuditFindFirst.mockResolvedValue(null)
  mockAuditCreate.mockResolvedValue({})
})

// ── 1. Verified, not reported ────────────────────────────────────────────────

describe('the platform probe decides, not the finding', () => {
  it('does not restart when PostgREST answers, however loudly the project reported', async () => {
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    execSucceeds()
    mockDiagnoseAndHeal.mockResolvedValue({
      status: HEALTHY, prunedSchemas: 0, restartRequired: false, notes: [],
    })

    const r = await healDataPlane('project-that-reported-502')

    expect(r.outcome).toBe('already_healthy')
    expect(r.healthy).toBe(true)
    expect(r.restarted).toBe(false)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('reports a prune-only recovery as exactly that', async () => {
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    mockDiagnoseAndHeal.mockResolvedValue({
      status: HEALTHY, prunedSchemas: 2, restartRequired: false, notes: ['Pruned 2 dangling schema(s).'],
    })

    const r = await healDataPlane()

    expect(r.outcome).toBe('healed_without_restart')
    expect(r.prunedSchemas).toBe(2)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('treats an unconfigured POSTGREST_URL as nothing to heal', async () => {
    mockDiagnoseAndHeal.mockResolvedValue({
      status: { state: 'not_configured' }, prunedSchemas: 0, restartRequired: false, notes: [],
    })

    const r = await healDataPlane()

    expect(r.healthy).toBe(true)
    expect(mockExec).not.toHaveBeenCalled()
  })
})

// ── 2. Single-flight ─────────────────────────────────────────────────────────

describe('platform-wide single flight', () => {
  it('declines when another heal holds the lock', async () => {
    mockQueryRaw.mockResolvedValue([{ acquired: false }])
    mockProbePostgrest.mockResolvedValue(DOWN)

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('in_progress')
    // The diagnosis is never even run — the point is to not stack a second one.
    expect(mockDiagnoseAndHeal).not.toHaveBeenCalled()
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('declines rather than fanning out when the control-plane DB is unreachable', async () => {
    // Without the lock this could become one restart per project, and a data
    // plane whose own database is down will not be fixed by restarting it.
    mockQueryRaw.mockRejectedValue(new Error('control plane down'))
    mockProbePostgrest.mockResolvedValue(DOWN)

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('in_progress')
    expect(mockExec).not.toHaveBeenCalled()
  })
})

// ── 3. Rate ceiling ──────────────────────────────────────────────────────────

describe('restart rate ceiling', () => {
  it('refuses to restart again inside the cooldown window', async () => {
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    execSucceeds()
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })
    mockAuditFindFirst.mockResolvedValue({ timestamp: new Date(Date.now() - 30_000) })

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('cooling_down')
    expect(r.healthy).toBe(false)
    expect(mockExec).not.toHaveBeenCalled()
    expect(describeHeal(r)).toMatch(/not restarting it again|escalated/i)
  })

  it('records the restart BEFORE running it, so a mid-restart crash still cools down', async () => {
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })
    mockProbePostgrest.mockResolvedValue(HEALTHY)

    const order: string[] = []
    mockAuditCreate.mockImplementation(async (arg: any) => {
      order.push(`audit:${arg.data.action}`)
      return {}
    })
    mockExec.mockImplementation((_c: string, _o: unknown, cb: Function) => {
      order.push('exec')
      cb(null, 'ok', '')
    })

    await healDataPlane('p1')

    expect(order.indexOf('audit:DATA_PLANE_RESTARTED')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('audit:DATA_PLANE_RESTARTED'))
      .toBeLessThan(order.indexOf('exec'))
  })
})

// ── The restart channel is configuration, never inference ────────────────────

describe('restart channel', () => {
  it('reports honestly instead of guessing a supervisor command', async () => {
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('restart_channel_unconfigured')
    expect(r.healthy).toBe(false)
    expect(mockExec).not.toHaveBeenCalled()
    expect(r.notes.join(' ')).toMatch(/POSTGREST_LOCAL_RESTART_COMMAND/)
  })

  it('uses the deprecated variable when only it is set, and names the replacement', async () => {
    // A host predating the rename must not lose its emergency fallback merely
    // because nobody renamed the variable on the box.
    process.env.POSTGREST_RESTART_COMMAND = 'legacy-restart'
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })

    const r = await healDataPlane('p1')

    expect(mockExec).toHaveBeenCalledTimes(1)
    expect(mockExec.mock.calls[0][0]).toBe('legacy-restart')
    const notes = r.notes.join(' ')
    expect(notes).toMatch(/deprecated/i)
    expect(notes).toMatch(/POSTGREST_LOCAL_RESTART_COMMAND/)
  })

  it('prefers the new variable when both are set', async () => {
    process.env.POSTGREST_RESTART_COMMAND = 'legacy-restart'
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'preferred-restart'
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })

    await healDataPlane('p1')

    expect(mockExec.mock.calls[0][0]).toBe('preferred-restart')
  })

  it('never shells out when no restart channel is configured', async () => {
    // The branch that matters under an orchestrator: unavailable must stay
    // UNHEALTHY rather than read as healed, and must not run an empty command.
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })

    const r = await healDataPlane('p1')

    expect(mockExec).not.toHaveBeenCalled()
    expect(r.restarted).toBe(false)
    expect(r.healthy).toBe(false)
    expect(r.outcome).toBe('restart_channel_unconfigured')
  })

  it('does not put the command text in the notes', async () => {
    // Operators may legitimately put credentials in this command, and notes
    // travel into findings a customer can read.
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'systemctl restart postgrest --token=SUPERSECRET'
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })

    const r = await healDataPlane('p1')

    expect(r.notes.join(' ')).not.toContain('SUPERSECRET')
  })
})

// ── 4. Verified recovery ─────────────────────────────────────────────────────

describe('recovery is verified, never assumed', () => {
  it('reports healed only once the plane answers again', async () => {
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    execSucceeds()
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 1, restartRequired: true, notes: [],
    })
    mockProbePostgrest.mockResolvedValue(HEALTHY)

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('healed_by_restart')
    expect(r.healthy).toBe(true)
    expect(r.restarted).toBe(true)
  })

  it('does NOT report success when the command exits 0 but the plane stays down', async () => {
    // The exact failure the auto-fix engine's re-check guard exists to prevent:
    // a fix recorded as applied while the backend is still serving 502s.
    process.env.POSTGREST_LOCAL_RESTART_COMMAND = 'restart-me'
    execSucceeds()
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })
    mockProbePostgrest.mockResolvedValue(DOWN)

    const r = await healDataPlane('p1')

    expect(r.outcome).toBe('unrecovered')
    expect(r.healthy).toBe(false)
  }, 45_000)

  it('never throws, even when the diagnosis itself blows up', async () => {
    mockDiagnoseAndHeal.mockRejectedValue(new Error('prisma exploded'))

    const r = await healDataPlane('p1')

    expect(r.healthy).toBe(false)
    expect(r.outcome).toBe('unrecovered')
    expect(r.notes.join(' ')).toMatch(/prisma exploded/)
  })
})

describe('describeHeal', () => {
  const OUTCOMES = [
    'already_healthy', 'healed_without_restart', 'healed_by_restart',
    'in_progress', 'cooling_down', 'restart_channel_unconfigured', 'unrecovered',
  ] as const

  const say = (outcome: (typeof OUTCOMES)[number]) => describeHeal({
    outcome, healthy: false, status: DOWN, prunedSchemas: 0, restarted: false, notes: [],
  })

  it('has a sentence for every outcome, including the ones that did nothing', () => {
    for (const outcome of OUTCOMES) {
      expect(say(outcome).length).toBeGreaterThan(20)
    }
  })

  it('never shows a project owner platform internals they cannot act on', () => {
    // The data plane is Backenly's infrastructure. Naming an env var the
    // customer cannot reach, in a system they did not deploy, reads as the
    // platform blaming its own config at them. Operator detail belongs in
    // `notes` → the audit log, which is what the operator actually reads.
    for (const outcome of OUTCOMES) {
      expect(say(outcome)).not.toMatch(/POSTGREST|PGRST|env var|pm2|systemctl/i)
    }
  })

  it('tells the owner when a failure is ours and needs nothing from them', () => {
    for (const outcome of ['restart_channel_unconfigured', 'unrecovered', 'cooling_down'] as const) {
      expect(say(outcome)).toMatch(/platform infrastructure/i)
    }
  })

  it('still records the operator detail on the unconfigured path', async () => {
    mockDiagnoseAndHeal.mockResolvedValue({
      status: DOWN, prunedSchemas: 0, restartRequired: true, notes: [],
    })
    const r = await healDataPlane('p1')
    expect(r.notes.join(' ')).toMatch(/POSTGREST_LOCAL_RESTART_COMMAND/)
  })
})
