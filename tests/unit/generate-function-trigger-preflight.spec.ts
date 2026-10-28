/**
 * generate_function refuses an unknown trigger in preflight instead of silently
 * turning it into a manual function (#231).
 */

const mockExecuted: Array<{ action: string; params: Record<string, unknown> }> = []

jest.mock('@/lib/ai/minimal-executor', () => ({
  ...jest.requireActual('@/lib/ai/minimal-executor'),
  executeAction: jest.fn(async (action: { action: string; params: Record<string, unknown> }) => {
    mockExecuted.push({ action: action.action, params: { ...action.params } })
    return { success: true, message: 'Created function' }
  }),
}))

import { dispatchTool } from '@/lib/ai/brain/tools'

const ctx = { projectId: 'p1' }

beforeEach(() => {
  mockExecuted.length = 0
})

describe('generate_function trigger preflight validation', () => {
  it('refuses a time-based trigger like on_cron, lists valid triggers, points at create_cron_job, and never reaches the executor', async () => {
    const events: unknown[] = []
    const res = await dispatchTool(
      'generate_function',
      {
        name: 'nightly_cleanup',
        trigger: 'on_cron',
        description: 'delete expired sessions from sessions table every night',
      },
      { ...ctx, onToolEvent: (ev) => events.push(ev) },
    )

    expect(res.ok).toBe(false)
    for (const valid of ['on_signup', 'on_insert', 'on_update', 'on_delete', 'http', 'manual']) {
      expect(res.summary).toContain(valid)
    }
    expect(res.summary).toContain('create_cron_job')
    expect(mockExecuted).toEqual([])
    expect(events).toEqual([])
  })

  it('refuses a typo trigger like on_inserts, lists valid triggers, and never reaches the executor', async () => {
    const res = await dispatchTool(
      'generate_function',
      {
        name: 'send_receipt',
        trigger: 'on_inserts',
        table: 'orders',
        description: 'send an email receipt when a row is inserted into orders',
      },
      ctx,
    )

    expect(res.ok).toBe(false)
    for (const valid of ['on_signup', 'on_insert', 'on_update', 'on_delete', 'http', 'manual']) {
      expect(res.summary).toContain(valid)
    }
    expect(res.summary).not.toContain('create_cron_job')
    expect(mockExecuted).toEqual([])
  })

  it('allows all declared valid triggers to reach the executor', async () => {
    const res = await dispatchTool(
      'generate_function',
      {
        name: 'recompute_totals',
        trigger: 'manual',
        description: 'recompute order totals across the orders and line_items tables',
      },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(mockExecuted).toHaveLength(1)
    expect(mockExecuted[0]).toMatchObject({
      action: 'CREATE_AI_FUNCTION',
      params: { name: 'recompute_totals', triggerType: 'manual' },
    })
  })
})
