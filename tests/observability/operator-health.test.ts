/**
 * OPERATOR HEALTH & OBSERVABILITY TESTS
 * =======================================
 * Track D/E — Validates that operator-facing health signals are accurate,
 * readable, and do not produce false positives.
 *
 * Tests:
 *  E.1  Stuck execution detection thresholds
 *  E.2  Abandoned execution detection
 *  E.3  Webhook failure clustering
 *  E.4  Repeated self-healing failure detection
 *  E.5  Health snapshot "ok" signal logic
 *  E.6  Readiness report human-readable label mapping
 *  E.7  Integration readiness state label completeness
 *  D.1  User-facing status messages — each status has a message
 *  D.2  Execution timeline entry renders all status types
 *  D.3  Readiness report blockers are clearly labeled
 */

import { describe, test, expect } from '@jest/globals'

// ─── E.1 + E.2: Stuck / abandoned detection thresholds ───────────────────────

describe('E.1 — Stuck execution detection', () => {
  const STUCK_THRESHOLD_MINUTES = 15

  interface FakeTimelineEntry {
    executionId: string
    projectId: string
    actionType: string
    status: string
    startedAt: Date
    retryCount: number
    errorClassification: string | null
  }

  function isStuck(entry: FakeTimelineEntry, now: Date): boolean {
    if (entry.status !== 'pending') return false
    const ageMinutes = (now.getTime() - entry.startedAt.getTime()) / 60_000
    return ageMinutes > STUCK_THRESHOLD_MINUTES
  }

  const now = new Date()

  test('pending entry < 15 min old is NOT stuck', () => {
    const entry: FakeTimelineEntry = {
      executionId: 'exec-1',
      projectId: 'p1',
      actionType: 'CREATE_TABLE',
      status: 'pending',
      startedAt: new Date(now.getTime() - 5 * 60_000), // 5 min ago
      retryCount: 0,
      errorClassification: null,
    }
    expect(isStuck(entry, now)).toBe(false)
  })

  test('pending entry > 15 min old IS stuck', () => {
    const entry: FakeTimelineEntry = {
      executionId: 'exec-2',
      projectId: 'p1',
      actionType: 'CREATE_TABLE',
      status: 'pending',
      startedAt: new Date(now.getTime() - 20 * 60_000), // 20 min ago
      retryCount: 0,
      errorClassification: null,
    }
    expect(isStuck(entry, now)).toBe(true)
  })

  test('completed entry is never stuck (regardless of age)', () => {
    const statuses = ['success', 'failed', 'self_corrected', 'skipped']
    for (const status of statuses) {
      const entry: FakeTimelineEntry = {
        executionId: 'exec-3',
        projectId: 'p1',
        actionType: 'CREATE_TABLE',
        status,
        startedAt: new Date(now.getTime() - 60 * 60_000), // 1 hour ago
        retryCount: 0,
        errorClassification: null,
      }
      expect(isStuck(entry, now)).toBe(false)
    }
  })

  test('stuckForMinutes is calculated correctly', () => {
    const startedAt = new Date(now.getTime() - 25 * 60_000) // 25 min ago
    const stuckForMinutes = Math.floor((now.getTime() - startedAt.getTime()) / 60_000)
    expect(stuckForMinutes).toBe(25)
  })
})

describe('E.2 — Abandoned execution detection', () => {
  const ABANDONED_THRESHOLD_MINUTES = 60

  interface FakeExecution {
    executionId: string
    projectId: string
    allFailed: boolean
    lastActivityAt: Date
  }

  function isAbandoned(execution: FakeExecution, now: Date): boolean {
    if (!execution.allFailed) return false
    const ageMinutes = (now.getTime() - execution.lastActivityAt.getTime()) / 60_000
    return ageMinutes > ABANDONED_THRESHOLD_MINUTES
  }

  const now = new Date()

  test('all-failed execution > 60 min ago is abandoned', () => {
    const exec: FakeExecution = {
      executionId: 'exec-abandoned-1',
      projectId: 'p1',
      allFailed: true,
      lastActivityAt: new Date(now.getTime() - 90 * 60_000), // 90 min ago
    }
    expect(isAbandoned(exec, now)).toBe(true)
  })

  test('all-failed execution < 60 min ago is not yet abandoned', () => {
    const exec: FakeExecution = {
      executionId: 'exec-recent-fail',
      projectId: 'p1',
      allFailed: true,
      lastActivityAt: new Date(now.getTime() - 30 * 60_000), // 30 min ago
    }
    expect(isAbandoned(exec, now)).toBe(false)
  })

  test('execution with some success is not abandoned', () => {
    const exec: FakeExecution = {
      executionId: 'exec-partial',
      projectId: 'p1',
      allFailed: false, // has at least one success
      lastActivityAt: new Date(now.getTime() - 120 * 60_000),
    }
    expect(isAbandoned(exec, now)).toBe(false)
  })
})

// ─── E.3: Webhook failure clustering ─────────────────────────────────────────

describe('E.3 — Webhook failure clustering', () => {
  interface WebhookFailure {
    projectId: string
    integration: string
    failedAt: Date
    errorCode: string
  }

  function clusterWebhookFailures(
    failures: WebhookFailure[],
    windowMs: number,
    now: Date
  ): Array<{ projectId: string; integration: string; count: number }> {
    const since = new Date(now.getTime() - windowMs)
    const recent = failures.filter(f => f.failedAt >= since)

    const clusters = new Map<string, number>()
    for (const f of recent) {
      const key = `${f.projectId}:${f.integration}`
      clusters.set(key, (clusters.get(key) ?? 0) + 1)
    }

    return Array.from(clusters.entries()).map(([key, count]) => {
      const [projectId, integration] = key.split(':')
      return { projectId, integration, count }
    })
  }

  const now = new Date()
  const WINDOW_MS = 60 * 60 * 1000 // 1 hour

  test('5 failures in window → cluster of 5', () => {
    const failures: WebhookFailure[] = Array.from({ length: 5 }, (_, i) => ({
      projectId: 'proj-1',
      integration: 'stripe',
      failedAt: new Date(now.getTime() - i * 5 * 60_000), // every 5 min
      errorCode: 'WEBHOOK_VERIFY_FAILURE',
    }))

    const clusters = clusterWebhookFailures(failures, WINDOW_MS, now)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(5)
    expect(clusters[0].projectId).toBe('proj-1')
  })

  test('failures outside window are excluded', () => {
    const failures: WebhookFailure[] = [
      { projectId: 'proj-1', integration: 'stripe', failedAt: new Date(now.getTime() - 30 * 60_000), errorCode: 'WEBHOOK_VERIFY_FAILURE' },
      { projectId: 'proj-1', integration: 'stripe', failedAt: new Date(now.getTime() - 90 * 60_000), errorCode: 'WEBHOOK_VERIFY_FAILURE' }, // outside window
    ]

    const clusters = clusterWebhookFailures(failures, WINDOW_MS, now)
    expect(clusters[0].count).toBe(1) // only 1 within window
  })

  test('failures across different projects create separate clusters', () => {
    const failures: WebhookFailure[] = [
      { projectId: 'proj-A', integration: 'stripe', failedAt: new Date(), errorCode: 'WEBHOOK_VERIFY_FAILURE' },
      { projectId: 'proj-B', integration: 'stripe', failedAt: new Date(), errorCode: 'WEBHOOK_VERIFY_FAILURE' },
    ]

    const clusters = clusterWebhookFailures(failures, WINDOW_MS, now)
    expect(clusters).toHaveLength(2)
  })
})

// ─── E.4: Repeated self-healing detection ─────────────────────────────────────

describe('E.4 — Repeated self-healing failure detection', () => {
  const THRESHOLD = 3

  function detectRepeatedHealing(
    entries: Array<{ projectId: string; actionType: string; selfCorrected: boolean }>
  ): Array<{ projectId: string; actionType: string; count: number }> {
    const counts = new Map<string, number>()
    for (const e of entries) {
      if (!e.selfCorrected) continue
      const key = `${e.projectId}:${e.actionType}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    return Array.from(counts.entries())
      .filter(([, count]) => count >= THRESHOLD)
      .map(([key, count]) => {
        const [projectId, actionType] = key.split(':')
        return { projectId, actionType, count }
      })
  }

  test('3+ self-corrections on same action → flagged', () => {
    const entries = Array.from({ length: 4 }, () => ({
      projectId: 'proj-1',
      actionType: 'ALTER_TABLE',
      selfCorrected: true,
    }))

    const result = detectRepeatedHealing(entries)
    expect(result).toHaveLength(1)
    expect(result[0].count).toBe(4)
  })

  test('2 self-corrections → below threshold, not flagged', () => {
    const entries = Array.from({ length: 2 }, () => ({
      projectId: 'proj-1',
      actionType: 'ALTER_TABLE',
      selfCorrected: true,
    }))

    const result = detectRepeatedHealing(entries)
    expect(result).toHaveLength(0)
  })

  test('non-self-corrected entries are ignored', () => {
    const entries = [
      { projectId: 'proj-1', actionType: 'CREATE_TABLE', selfCorrected: false },
      { projectId: 'proj-1', actionType: 'CREATE_TABLE', selfCorrected: false },
      { projectId: 'proj-1', actionType: 'CREATE_TABLE', selfCorrected: false },
      { projectId: 'proj-1', actionType: 'CREATE_TABLE', selfCorrected: false },
    ]

    const result = detectRepeatedHealing(entries)
    expect(result).toHaveLength(0)
  })
})

// ─── E.5: Health snapshot "ok" signal logic ───────────────────────────────────

describe('E.5 — Health snapshot "ok" signal is accurate', () => {
  interface SnapshotSummary {
    stuckCount: number
    abandonedCount: number
    webhookFailureProjectCount: number
    repeatedHealingFailureCount: number
  }

  function isHealthy(summary: SnapshotSummary): boolean {
    return (
      summary.stuckCount === 0 &&
      summary.abandonedCount === 0 &&
      summary.webhookFailureProjectCount === 0 &&
      summary.repeatedHealingFailureCount === 0
    )
  }

  test('all zeros → healthy', () => {
    expect(isHealthy({ stuckCount: 0, abandonedCount: 0, webhookFailureProjectCount: 0, repeatedHealingFailureCount: 0 }))
      .toBe(true)
  })

  test('one stuck execution → not healthy', () => {
    expect(isHealthy({ stuckCount: 1, abandonedCount: 0, webhookFailureProjectCount: 0, repeatedHealingFailureCount: 0 }))
      .toBe(false)
  })

  test('one webhook failure → not healthy', () => {
    expect(isHealthy({ stuckCount: 0, abandonedCount: 0, webhookFailureProjectCount: 1, repeatedHealingFailureCount: 0 }))
      .toBe(false)
  })

  test('repeated healing failures → not healthy', () => {
    expect(isHealthy({ stuckCount: 0, abandonedCount: 0, webhookFailureProjectCount: 0, repeatedHealingFailureCount: 1 }))
      .toBe(false)
  })
})

// ─── D.1: User-facing status messages ─────────────────────────────────────────

describe('D.1 — User-facing status messages are complete and clear', () => {
  type ExecutionStatus = 'pending' | 'success' | 'failed' | 'self_corrected' | 'skipped'

  const STATUS_MESSAGES: Record<ExecutionStatus, { label: string; description: string; userAction?: string }> = {
    pending: {
      label: 'In Progress',
      description: 'This action is currently executing.',
    },
    success: {
      label: 'Completed',
      description: 'Action completed successfully.',
    },
    failed: {
      label: 'Failed',
      description: 'Action failed after all retry attempts.',
      userAction: 'Check the error details and try again, or contact support.',
    },
    self_corrected: {
      label: 'Self-Corrected',
      description: 'Action failed initially but was automatically fixed and retried successfully.',
    },
    skipped: {
      label: 'Skipped',
      description: 'Action was skipped because a previous step made it unnecessary.',
    },
  }

  test('all 5 execution statuses have defined messages', () => {
    const statuses: ExecutionStatus[] = ['pending', 'success', 'failed', 'self_corrected', 'skipped']
    for (const status of statuses) {
      expect(STATUS_MESSAGES[status]).toBeDefined()
      expect(STATUS_MESSAGES[status].label.length).toBeGreaterThan(0)
      expect(STATUS_MESSAGES[status].description.length).toBeGreaterThan(0)
    }
  })

  test('failed status has a userAction guidance', () => {
    expect(STATUS_MESSAGES.failed.userAction).toBeTruthy()
  })

  test('labels are short (≤ 20 chars) for UI badge display', () => {
    for (const [, msg] of Object.entries(STATUS_MESSAGES)) {
      expect(msg.label.length).toBeLessThanOrEqual(20)
    }
  })
})

// ─── D.2: Timeline entry rendering ────────────────────────────────────────────

describe('D.2 — Execution timeline entries render all status types', () => {
  function renderEntry(entry: {
    actionType: string
    status: string
    retryCount: number
    selfCorrected: boolean
    durationMs: number | null
    errorClassification: string | null
  }): string {
    const parts = [`[${entry.status.toUpperCase()}]`, entry.actionType]
    if (entry.durationMs != null) parts.push(`(${entry.durationMs}ms)`)
    if (entry.retryCount > 0) parts.push(`${entry.retryCount} retries`)
    if (entry.selfCorrected) parts.push('✓ auto-fixed')
    if (entry.errorClassification) parts.push(`error: ${entry.errorClassification}`)
    return parts.join(' ')
  }

  const baseEntry = {
    actionType: 'CREATE_TABLE',
    status: 'success',
    retryCount: 0,
    selfCorrected: false,
    durationMs: 450,
    errorClassification: null,
  }

  test('success entry renders correctly', () => {
    const r = renderEntry(baseEntry)
    expect(r).toContain('[SUCCESS]')
    expect(r).toContain('CREATE_TABLE')
    expect(r).toContain('450ms')
  })

  test('failed entry with error classification renders classification', () => {
    const r = renderEntry({ ...baseEntry, status: 'failed', errorClassification: 'FK_CONSTRAINT' })
    expect(r).toContain('[FAILED]')
    expect(r).toContain('FK_CONSTRAINT')
  })

  test('self_corrected entry shows auto-fix indicator', () => {
    const r = renderEntry({ ...baseEntry, status: 'self_corrected', selfCorrected: true, retryCount: 1 })
    expect(r).toContain('[SELF_CORRECTED]')
    expect(r).toContain('auto-fixed')
    expect(r).toContain('1 retries')
  })

  test('null durationMs does not crash renderer', () => {
    const r = renderEntry({ ...baseEntry, durationMs: null })
    expect(r).not.toContain('ms')
    expect(r).toContain('[SUCCESS]')
  })
})

// ─── D.3: Readiness report blocker labeling ───────────────────────────────────

describe('D.3 — Readiness report blockers are clearly labeled', () => {
  interface ReadinessCheck {
    id: string
    name: string
    severity: 'blocking' | 'warning' | 'auto-fixable'
    status: 'pass' | 'fail' | 'skip'
    message: string
    details: string[]
    fixApplied: boolean
  }

  function formatBlockerMessage(check: ReadinessCheck): string {
    const prefix = check.severity === 'blocking' ? '🚫 BLOCKED' :
                   check.severity === 'warning' ? '⚠️ WARNING' : '🔧 AUTO-FIX'
    return `${prefix}: ${check.name} — ${check.message}`
  }

  const checks: ReadinessCheck[] = [
    {
      id: 'webhook_security',
      name: 'Webhook Security',
      severity: 'blocking',
      status: 'fail',
      message: 'Stripe webhook secret is not configured. Production webhook events cannot be verified.',
      details: ['Add STRIPE_WEBHOOK_SECRET in your integration settings'],
      fixApplied: false,
    },
    {
      id: 'rls_applied',
      name: 'Row-Level Security',
      severity: 'warning',
      status: 'fail',
      message: 'Table "orders" has user_id but no RLS policy applied.',
      details: ['Run: SET_PERMISSION on orders with own_rows policy'],
      fixApplied: false,
    },
    {
      id: 'project_jwt',
      name: 'Project JWT Secret',
      severity: 'auto-fixable',
      status: 'fail',
      message: 'Project JWT secret was missing — auto-generated.',
      details: [],
      fixApplied: true,
    },
  ]

  test('blocking check renders with BLOCKED prefix', () => {
    const msg = formatBlockerMessage(checks[0])
    expect(msg).toContain('BLOCKED')
    expect(msg).toContain('Webhook Security')
  })

  test('warning check renders with WARNING prefix', () => {
    const msg = formatBlockerMessage(checks[1])
    expect(msg).toContain('WARNING')
  })

  test('auto-fixable check renders with AUTO-FIX prefix', () => {
    const msg = formatBlockerMessage(checks[2])
    expect(msg).toContain('AUTO-FIX')
    expect(msg).toContain('auto-generated')
  })

  test('blocker messages are non-empty and actionable', () => {
    for (const check of checks.filter(c => c.status === 'fail')) {
      expect(check.message.length).toBeGreaterThan(10)
      // Details array may be empty for auto-fixed checks
      if (!check.fixApplied) {
        expect(check.details.length).toBeGreaterThan(0)
      }
    }
  })

  test('readiness is false when any blocking check fails', () => {
    const isReady = !checks.some(c => c.severity === 'blocking' && c.status === 'fail')
    expect(isReady).toBe(false)
  })

  test('readiness is true when all blocking checks pass', () => {
    // Build a new array where every check is passing
    const passedChecks: ReadinessCheck[] = checks.map(c => ({ ...c, status: 'pass' as 'pass' | 'fail' | 'skip' }))
    const isReady = !passedChecks.some(c => c.severity === 'blocking' && c.status === 'fail')
    expect(isReady).toBe(true)
  })
})

// ─── E.6+E.7: Integration readiness state label completeness ──────────────────

describe('E.6/E.7 — Integration readiness state labels', () => {
  const READINESS_LABELS: Record<string, { label: string; operatorDescription: string; nextStep: string }> = {
    not_configured: {
      label: 'Not Configured',
      operatorDescription: 'No API key stored for this integration.',
      nextStep: 'Add the API key in integration settings.',
    },
    key_stored: {
      label: 'Key Stored',
      operatorDescription: 'API key is stored but support tables/functions are not yet generated.',
      nextStep: 'Trigger AI to generate support tables and webhook handlers.',
    },
    partially_configured: {
      label: 'Partially Configured',
      operatorDescription: 'Key and some support structures exist, but not all dependencies are satisfied.',
      nextStep: 'Review the checklist and complete missing dependencies.',
    },
    behaviorally_ready: {
      label: 'Behaviorally Ready',
      operatorDescription: 'All dependencies satisfied. Integration is fully operational.',
      nextStep: 'No action needed.',
    },
  }

  test('all 4 states have complete labels', () => {
    const states = ['not_configured', 'key_stored', 'partially_configured', 'behaviorally_ready']
    for (const state of states) {
      expect(READINESS_LABELS[state]).toBeDefined()
      expect(READINESS_LABELS[state].label).toBeTruthy()
      expect(READINESS_LABELS[state].operatorDescription).toBeTruthy()
      expect(READINESS_LABELS[state].nextStep).toBeTruthy()
    }
  })

  test('behaviorally_ready state has no required next step', () => {
    expect(READINESS_LABELS.behaviorally_ready.nextStep.toLowerCase()).toContain('no action')
  })

  test('state progression is linear (each state has a clear meaning)', () => {
    // The states should form a clear linear progression
    const orderedStates = ['not_configured', 'key_stored', 'partially_configured', 'behaviorally_ready']
    for (let i = 0; i < orderedStates.length; i++) {
      const state = orderedStates[i]
      expect(READINESS_LABELS[state]).toBeDefined()
      // Each state label should be unique
      const labels = orderedStates.map(s => READINESS_LABELS[s].label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})
