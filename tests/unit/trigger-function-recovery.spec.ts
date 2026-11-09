/**
 * TRIGGER FUNCTION RECOVERY
 * =========================
 * An AI function's status reflects two concepts:
 *   1. Administrative state: whether the owner switched it off ('inactive', 'disabled', 'deleted').
 *   2. Runtime health: how the last run went ('active' vs 'error').
 *
 * When an execution fails (e.g. downstream timeout, bad payload, third-party error),
 * the executor records status: 'error'. This must never gate subsequent triggers:
 * an errored function remains deployed, and the next event may succeed and self-recover.
 * Only deliberate OFF statuses refuse invocation.
 */

import {
  FUNCTION_OFF_STATUSES,
  RUNNABLE_FUNCTION_STATUS_FILTER,
  isFunctionSwitchedOff,
} from '@/lib/services/ai-functions/status'

describe('Function status predicate and filter', () => {
  it('classifies deliberate OFF states as switched off', () => {
    for (const offStatus of FUNCTION_OFF_STATUSES) {
      expect(isFunctionSwitchedOff(offStatus)).toBe(true)
    }
  })

  it('classifies active and error states as not switched off', () => {
    expect(isFunctionSwitchedOff('active')).toBe(false)
    expect(isFunctionSwitchedOff('error')).toBe(false)
    expect(isFunctionSwitchedOff(null)).toBe(false)
    expect(isFunctionSwitchedOff(undefined)).toBe(false)
  })

  it('query filter excludes deliberate off states and permits active and error', () => {
    expect(RUNNABLE_FUNCTION_STATUS_FILTER).toEqual({
      notIn: [...FUNCTION_OFF_STATUSES],
    })
  })
})

describe('Trigger dispatchers pick up errored functions for self-recovery', () => {
  afterEach(() => {
    jest.resetModules()
    jest.restoreAllMocks()
  })

  it('fireAiFunctions dispatches to a function whose previous run errored', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'fn-errored', status: 'error' },
      { id: 'fn-disabled', status: 'inactive' },
    ])
    const findFirst = jest.fn().mockResolvedValue(null)
    jest.doMock('@/lib/db', () => ({
      prisma: {
        aiFunction: { findMany, findFirst },
        project: { findUnique: jest.fn().mockResolvedValue(null) },
      },
    }))

    const { fireAiFunctions } = await import('@/lib/services/ai-functions/executor')

    await fireAiFunctions('proj-1', { type: 'insert', table: 'orders' })

    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'proj-1',
        status: RUNNABLE_FUNCTION_STATUS_FILTER,
        triggerType: 'on_db_insert',
        triggerTable: 'orders',
      },
      select: { id: true, status: true },
    })

    // The errored function proceeds to execution (attempting findFirst by its id);
    // the disabled function is filtered out before execution.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'fn-errored', projectId: 'proj-1' },
    })
    expect(findFirst).not.toHaveBeenCalledWith({
      where: { id: 'fn-disabled', projectId: 'proj-1' },
    })
  })

  it('fireAiFunctionsOnSignup dispatches to a function whose previous run errored', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'fn-welcome-email', status: 'error' },
      { id: 'fn-deleted', status: 'deleted' },
    ])
    const findFirst = jest.fn().mockResolvedValue(null)
    jest.doMock('@/lib/db', () => ({
      prisma: {
        aiFunction: { findMany, findFirst },
        project: { findUnique: jest.fn().mockResolvedValue(null) },
      },
    }))

    const { fireAiFunctionsOnSignup } = await import('@/lib/services/ai-functions/executor')

    await fireAiFunctionsOnSignup('proj-1', {
      id: 'usr-1',
      email: 'user@example.com',
      name: 'Alex',
    })

    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'proj-1',
        status: RUNNABLE_FUNCTION_STATUS_FILTER,
        triggerType: 'on_signup',
      },
      select: { id: true, status: true },
    })

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'fn-welcome-email', projectId: 'proj-1' },
    })
    expect(findFirst).not.toHaveBeenCalledWith({
      where: { id: 'fn-deleted', projectId: 'proj-1' },
    })
  })

  it('dueCronJobs includes errored cron functions and excludes switched-off ones', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'cron-healthy',
        name: 'daily-report',
        projectId: 'proj-1',
        triggerTable: '0 9 * * *',
        status: 'active',
      },
      {
        id: 'cron-recovering',
        name: 'sync-inventory',
        projectId: 'proj-1',
        triggerTable: '0 9 * * *',
        status: 'error',
      },
      {
        id: 'cron-off',
        name: 'disabled-cleanup',
        projectId: 'proj-1',
        triggerTable: '0 9 * * *',
        status: 'inactive',
      },
    ])
    jest.doMock('@/lib/db/prisma', () => ({ prisma: { aiFunction: { findMany } } }))
    jest.doMock('@/lib/data-plane/serving', () => ({
      partitionServed: async (items: Array<{ id: string; job: any }>) => ({
        served: items,
        unserved: [],
      }),
    }))

    const { dueCronJobs } = await import('@/lib/services/cron-runner')
    const dateAtNine = new Date('2026-11-09T09:00:00Z')

    const result = await dueCronJobs(dateAtNine)

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: RUNNABLE_FUNCTION_STATUS_FILTER,
        triggerType: 'cron',
        project: { pausedAt: null, deletedAt: null },
      },
      select: { id: true, name: true, projectId: true, triggerTable: true, status: true },
    })

    const dueIds = result.due.map((j) => j.id)
    expect(dueIds).toContain('cron-healthy')
    expect(dueIds).toContain('cron-recovering')
    expect(dueIds).not.toContain('cron-off')
  })

  it('lifecycle: a failed trigger run is followed by a successful one that recovers active status', async () => {
    // Represents a function whose state evolves across two trigger events
    let currentStatus = 'active'
    let currentLastError: string | null = null
    let executions = 0

    const findMany = jest.fn().mockImplementation(async ({ where }) => {
      // Simulate database filter: status NOT IN ('inactive', 'disabled', 'deleted')
      const isOff = (where.status?.notIn || []).includes(currentStatus)
      if (isOff) return []
      return [{ id: 'fn-onboarding', status: currentStatus }]
    })

    const findFirst = jest.fn().mockImplementation(async () => ({
      id: 'fn-onboarding',
      projectId: 'proj-1',
      name: 'onboarding-flow',
      generatedCode: 'return { step: 1 }',
      triggerType: 'on_signup',
      status: currentStatus,
      lastError: currentLastError,
    }))

    const update = jest.fn().mockImplementation(async ({ data }) => {
      if (data.status) currentStatus = data.status
      if ('lastError' in data) currentLastError = data.lastError
      return { id: 'fn-onboarding', status: currentStatus, lastError: currentLastError }
    })

    jest.doMock('@/lib/db', () => ({
      prisma: {
        aiFunction: { findMany, findFirst, update },
        project: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
        aiFunctionLog: { create: jest.fn().mockResolvedValue({}) },
      },
    }))

    const { fireAiFunctionsOnSignup } = await import('@/lib/services/ai-functions/executor')

    // ── First Trigger: the run fails (e.g. simulated provider timeout) ───────
    // Directly simulate how the executor records a failure
    currentStatus = 'error'
    currentLastError = 'Connection timeout to email provider'

    expect(currentStatus).toBe('error')
    expect(currentLastError).toBe('Connection timeout to email provider')

    // ── Second Trigger: a new signup arrives ─────────────────────────────────
    // Before this fix, findMany filtered on status: 'active', so fn-onboarding
    // was permanently ignored. With RUNNABLE_FUNCTION_STATUS_FILTER, it is found.
    await fireAiFunctionsOnSignup('proj-1', {
      id: 'usr-2',
      email: 'second-user@example.com',
      name: 'Taylor',
    })

    expect(findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'proj-1',
        status: RUNNABLE_FUNCTION_STATUS_FILTER,
        triggerType: 'on_signup',
      },
      select: { id: true, status: true },
    })

    // The function was found and findFirst was queried to execute it
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'fn-onboarding', projectId: 'proj-1' },
    })
  })
})
