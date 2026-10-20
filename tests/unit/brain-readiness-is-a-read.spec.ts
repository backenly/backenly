/**
 * Readiness through the brain is a read unless fixing is asked for.
 *
 * The readiness executor applies fixes when it is passed `autoFix: true`: owner
 * RLS policies, the project JWT secret, the auth flag, switching off placeholder
 * functions with live triggers. get_readiness is listed with the reads and the
 * agent prompt calls it before every deploy, so a call that fixed and was
 * counted as a read left its changes out of the turn's `applied` and was never
 * verified (#240). The MCP door serves it the same way
 * (mcp-readiness-is-a-read.spec.ts).
 *
 * The executor is replaced with a recorder; nothing here reaches a database.
 */

const mockExecuted: Array<{ action: string; params: Record<string, unknown> }> = []

jest.mock('@/lib/ai/minimal-executor', () => ({
  ...jest.requireActual('@/lib/ai/minimal-executor'),
  executeAction: jest.fn(async (action: { action: string; params: Record<string, unknown> }) => {
    mockExecuted.push({ action: action.action, params: { ...action.params } })
    return { success: true, message: 'Readiness 100/100' }
  }),
}))

import { dispatchTool } from '@/lib/ai/brain/tools'
import { isMutationCall } from '@/lib/ai/brain/agent'

const ctx = { projectId: 'p1' }

beforeEach(() => {
  mockExecuted.length = 0
})

describe('get_readiness through the brain', () => {
  it('reaches the executor as a read when the model passes nothing', async () => {
    await dispatchTool('get_readiness', {}, ctx)
    expect(mockExecuted).toEqual([{ action: 'GET_READINESS', params: { autoFix: false } }])
  })

  it('fixes only when asked for in so many words', async () => {
    for (const autoFix of [true, false, 'true', 1]) await dispatchTool('get_readiness', { autoFix }, ctx)
    expect(mockExecuted.map((e) => e.params.autoFix)).toEqual([true, false, false, false])
  })

  it('counts a call that fixes as a change, and every other readiness call as a read', () => {
    expect(isMutationCall('get_readiness', { autoFix: true })).toBe(true)
    for (const args of [{}, { autoFix: false }, { autoFix: 'true' }, { autoFix: 1 }]) {
      expect({ args, change: isMutationCall('get_readiness', args) }).toEqual({ args, change: false })
    }
  })

  it('counts a call as a change exactly when the executor is told to fix', async () => {
    const calls = [{}, { autoFix: true }, { autoFix: false }, { autoFix: 'true' }]
    for (const args of calls) await dispatchTool('get_readiness', args, ctx)
    expect(calls.map((args) => isMutationCall('get_readiness', args))).toEqual(
      mockExecuted.map((e) => e.params.autoFix === true),
    )
  })
})
