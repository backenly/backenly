/**
 * Agentic Loop v2 tests
 * =====================
 * The loop's control logic is verified with fully injected deps (scripted
 * OpenAI completions, fake proof, fake tool dispatch) — no OpenAI, Prisma,
 * or the 80-action executor are loaded. This is the payoff of the DI seam.
 *
 * Covered:
 *   - happy path: understand → tool → verify → finish
 *   - verify-nudge: model finishes after mutating without verifying → loop
 *     forces a read_backend_state pass before accepting finish
 *   - destructive gate: drop_table without confirmation is blocked
 *   - no-tool answer: model replies in prose → treated as final
 *   - MAX_ITERATIONS guard: never loops forever
 */

import { describe, it, expect } from '@jest/globals'
import { runAgentLoop, type AgentLoopDeps } from '../../lib/ai/agent/agent-loop-v2'

// ── Scripted OpenAI ─────────────────────────────────────────────────────────
type ToolCall = { id: string; name: string; args: Record<string, unknown> }

function asCompletion(opts: { content?: string; toolCalls?: ToolCall[] }): any {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: opts.content ?? '',
          tool_calls: (opts.toolCalls ?? []).map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

/** Build a deps bundle with a scripted completion queue. */
function makeDeps(
  script: any[],
  dispatchImpl?: AgentLoopDeps['dispatch'],
): { deps: AgentLoopDeps; calls: string[] } {
  const calls: string[] = []
  let i = 0
  const deps: AgentLoopDeps = {
    openai: {
      chat: {
        completions: {
          create: async () => {
            const next = script[Math.min(i, script.length - 1)]
            i++
            return next
          },
        },
      },
    } as any,
    collectProof: (async () => ({
      tables: ['users'], apis: [], authEnabled: false, authProviders: [],
      rlsPolicies: [], integrations: [], buckets: [], nothingBuilt: false,
    })) as any,
    getSchema: async () => 'Table: users',
    dispatch: dispatchImpl ?? (async (name: string, args: Record<string, unknown>) => {
      calls.push(name)
      if (name === 'finish') {
        return {
          ok: !args.needsUser,
          summary: String(args.summary ?? 'Done.'),
          terminal: true,
          data: { needsUser: !!args.needsUser },
        }
      }
      if (name === 'read_backend_state') {
        return { ok: true, summary: 'state', data: { tables: ['users', 'posts'] } }
      }
      return { ok: true, summary: `${name} ok` }
    }),
  }
  return { deps, calls }
}

const baseInput = {
  projectId: 'proj_1',
  userId: 'user_1',
  message: 'add a posts table',
}

describe('runAgentLoop — happy path', () => {
  it('drives understand → tool → verify → finish and returns success', async () => {
    const script = [
      asCompletion({ toolCalls: [{ id: 'c1', name: 'create_table', args: { tableName: 'posts', columns: [] } }] }),
      asCompletion({ toolCalls: [{ id: 'c2', name: 'read_backend_state', args: {} }] }),
      asCompletion({ toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'Created the posts table.' } }] }),
    ]
    const { deps, calls } = makeDeps(script)
    const events: string[] = []

    const result = await runAgentLoop(baseInput, e => events.push(e.type), deps)

    expect(calls).toEqual(['create_table', 'read_backend_state', 'finish'])
    expect(result.success).toBe(true)
    expect(result.summary).toBe('Created the posts table.')
    expect(result.needsUser).toBe(false)
    expect(events).toContain('final')
  })
})

describe('runAgentLoop — verify nudge', () => {
  it('rejects finish straight after a mutation and forces a verify pass', async () => {
    const script = [
      asCompletion({ toolCalls: [{ id: 'c1', name: 'create_table', args: { tableName: 'posts', columns: [] } }] }),
      // Model tries to finish without verifying →
      asCompletion({ toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'Done (unverified).' } }] }),
      // Loop nudged it — now it verifies →
      asCompletion({ toolCalls: [{ id: 'c3', name: 'read_backend_state', args: {} }] }),
      // Then finishes for real
      asCompletion({ toolCalls: [{ id: 'c4', name: 'finish', args: { summary: 'Verified and done.' } }] }),
    ]
    const { deps, calls } = makeDeps(script)
    const result = await runAgentLoop(baseInput, () => {}, deps)

    expect(calls).toContain('read_backend_state')
    // The first finish must NOT have terminated the loop.
    expect(result.summary).toBe('Verified and done.')
    expect(calls.filter(c => c === 'finish').length).toBe(2)
  })
})

describe('runAgentLoop — destructive gate', () => {
  it('blocks drop_table when not confirmed and never dispatches it', async () => {
    const dispatched: string[] = []
    const script = [
      asCompletion({ toolCalls: [{ id: 'c1', name: 'drop_table', args: { tableName: 'users' } }] }),
      asCompletion({ toolCalls: [{ id: 'c2', name: 'finish', args: { summary: 'I need you to confirm dropping users.', needsUser: true } }] }),
    ]
    const { deps } = makeDeps(script, async (name: string) => {
      dispatched.push(name)
      if (name === 'finish') return { ok: true, summary: 'need confirm', terminal: true, data: { needsUser: true } }
      return { ok: true, summary: 'ok' }
    })

    const result = await runAgentLoop(baseInput, () => {}, deps)

    expect(dispatched).not.toContain('drop_table')
    expect(result.needsUser).toBe(true)
    expect(result.success).toBe(false)
  })

  it('allows drop_table when destructiveConfirmed is set', async () => {
    const dispatched: string[] = []
    const script = [
      asCompletion({ toolCalls: [{ id: 'c1', name: 'drop_table', args: { tableName: 'old' } }] }),
      asCompletion({ toolCalls: [{ id: 'c2', name: 'read_backend_state', args: {} }] }),
      asCompletion({ toolCalls: [{ id: 'c3', name: 'finish', args: { summary: 'Dropped old.' } }] }),
    ]
    const { deps } = makeDeps(script, async (name: string) => {
      dispatched.push(name)
      if (name === 'finish') return { ok: true, summary: 'Dropped old.', terminal: true, data: { needsUser: false } }
      return { ok: true, summary: 'ok' }
    })

    const result = await runAgentLoop(
      { ...baseInput, destructiveConfirmed: true },
      () => {},
      deps,
    )
    expect(dispatched).toContain('drop_table')
    expect(result.success).toBe(true)
  })
})

describe('runAgentLoop — prose answer', () => {
  it('treats a no-tool model reply as the final summary', async () => {
    const script = [
      asCompletion({ content: 'Your backend already has everything you asked for.' }),
    ]
    const { deps, calls } = makeDeps(script)
    const result = await runAgentLoop(baseInput, () => {}, deps)

    expect(calls).toEqual([])
    expect(result.success).toBe(true)
    expect(result.summary).toBe('Your backend already has everything you asked for.')
  })
})

describe('runAgentLoop — runaway guard', () => {
  it('stops at MAX_ITERATIONS and returns an honest continue-able summary', async () => {
    // Model keeps calling a read tool forever, never finishes.
    const loopForever = asCompletion({
      toolCalls: [{ id: 'cx', name: 'read_backend_state', args: {} }],
    })
    const { deps } = makeDeps(Array(30).fill(loopForever))
    const result = await runAgentLoop(baseInput, () => {}, deps)

    expect(result.iterations).toBeLessThanOrEqual(12)
    expect(result.summary).toMatch(/ran out of steps|continue/i)
  })
})
