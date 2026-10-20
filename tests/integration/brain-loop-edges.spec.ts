/**
 * The edges of a runBrain turn (#246): what the classifier is told and how its
 * answer is read, what the loop is offered for each intent, every way it stops
 * and what that leaves for "continue", and what a turn writes down.
 *
 * Real database: projects, workspace tables, the conversation log, the
 * pending-plan, proposal and resume rows, the operational-memory events. Only
 * the model is scripted.
 */

import { prisma } from '@/lib/db/prisma'
import { AiError } from '@/lib/ai/llm'
import { scriptedMessage, type ScriptStep } from '@/lib/ai/llm/providers/scripted'
import { recordToolExecutionMemory } from '@/lib/operational-memory/ledger'
import { saveProposal } from '@/lib/ai/proposals/store'
import type { Proposal } from '@/lib/ai/proposals/types'
import { saveResumeQueue, savePendingPlan } from '@/lib/ai/blueprints/store'
import { loadLoopResume, saveLoopResume } from '@/lib/ai/brain/loop-resume'
import { saveTurn } from '@/lib/ai/brain/memory'
import {
  classified,
  clarification,
  finished,
  providerRefusal,
  systemOf,
  toolCall,
  toolNamesOf,
  setUpBrainProject,
} from '../helpers/brain-harness'

jest.mock('@/lib/operational-memory/ledger', () => {
  const actual = jest.requireActual<typeof import('@/lib/operational-memory/ledger')>('@/lib/operational-memory/ledger')
  return { ...actual, recordToolExecutionMemory: jest.fn(actual.recordToolExecutionMemory) }
})

const receipt = recordToolExecutionMemory as jest.MockedFunction<typeof recordToolExecutionMemory>

const built = setUpBrainProject({ name: 'brain-edges-built', tables: ['keep_me'] })
const fresh = setUpBrainProject({ name: 'brain-edges-fresh' })

const createNotes = (table: string) =>
  toolCall('create_table', { tableName: table, columns: [{ name: 'title', type: 'text' }] }, `toolu_${table}`)
const classifiedAs = (raw: Record<string, unknown>) => scriptedMessage({ text: JSON.stringify(raw) })

afterEach(() => jest.restoreAllMocks())

// ── What the classifier is told ───────────────────────────────────────────────

describe('what the classifier is told about the turn', () => {
  const chat: ScriptStep[] = [classified('CHAT'), scriptedMessage({ text: 'ok' })]

  it('nothing extra when nothing is pending and the project has something built', async () => {
    const { provider } = await built.turn(chat, 'hello')
    expect(systemOf(provider, 0)).not.toContain('CONTEXT:')
  }, 60_000)

  it('that the project is brand new, when nothing has been built', async () => {
    const { provider } = await fresh.turn(chat, 'hello')
    expect(systemOf(provider, 0)).toContain('this project is brand new')
  }, 60_000)

  it.each([
    ['a stored plan', async () => savePendingPlan(built.projectId, { domain: 'x', title: 't', summary: 's', steps: [] }, { domain: 'x', confidence: 1, matchedOn: 'x' }, 0)],
    ['a resume queue', async () => saveResumeQueue(built.projectId, 'x', [{ label: 'l', tool: 'create_table', args: {} }], 'r')],
    ['a loop resume point', async () => saveLoopResume(built.projectId, 'build the thing', [], 'step_budget')],
    ['a plan the last assistant message proposed', async () => saveTurn(built.projectId, 'add comments', 'Plan.\n\nReply "go ahead" to run this, or tell me what to add or remove.')],
  ])('that a plan is awaiting confirmation, from %s', async (_name, arrange) => {
    await arrange()
    const { provider } = await built.turn(chat, 'continue')
    expect(systemOf(provider, 0)).toContain('awaiting user confirmation')
  }, 60_000)

  it('that a proposal can be applied, while one is open', async () => {
    await saveProposal(proposalOf(built.projectId, 'open'))
    const { provider } = await built.turn(chat, 'yes')
    expect(systemOf(provider, 0)).toContain('a Proposal (recommendation list) is active')
  }, 60_000)

  it('nothing about a proposal that is applied, closed or expired', async () => {
    for (const status of ['applied', 'closed', 'expired'] as const) {
      await saveProposal(proposalOf(built.projectId, status))
      const { provider } = await built.turn(chat, 'yes')
      expect(systemOf(provider, 0)).not.toContain('Proposal (recommendation list)')
    }
    await saveProposal({ ...proposalOf(built.projectId, 'open'), expiresAt: new Date(Date.now() - 1000).toISOString() })
    const { provider } = await built.turn(chat, 'yes')
    expect(systemOf(provider, 0)).not.toContain('Proposal (recommendation list)')
  }, 60_000)

  it('the last four turns, and no more', async () => {
    for (let i = 1; i <= 6; i++) await saveTurn(built.projectId, `question ${i}`, `answer ${i}`)
    const { provider } = await built.turn(chat, 'and now?')
    const sent = JSON.stringify(provider.calls[0].params.messages)
    expect(sent).toContain('answer 6')
    expect(sent).toContain('question 5')
    expect(sent).not.toContain('question 4')
  }, 60_000)
})

function proposalOf(projectId: string, status: Proposal['status']): Proposal {
  return {
    id: `prop_${status}`,
    projectId,
    title: 'Recommendations',
    items: [],
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

// ── How its answer is read ────────────────────────────────────────────────────

describe('how the classifier\'s answer is read', () => {
  const reads = async (project: typeof built, reply: ScriptStep, tail: ScriptStep[] = []) => {
    const { events, result, provider } = await project.turn([reply, ...tail], 'do the thing')
    const c = events.find((e) => e.type === 'classification') as { intent: string; confidence: number; reasoning: string }
    return { c, result, provider }
  }

  it('takes an intent in any case and a confidence written as a string', async () => {
    const { c } = await reads(built, classifiedAs({ intent: ' modify ', confidence: '0.92', reasoning: 'r' }), [finished('Done.')])
    expect(c).toMatchObject({ intent: 'MODIFY', confidence: 0.92 })
  }, 60_000)

  it('clamps a confidence above 1 to 1 and keeps the intent', async () => {
    const { c } = await reads(built, classifiedAs({ intent: 'MODIFY', confidence: 7, reasoning: 'r' }), [finished('Done.')])
    expect(c).toMatchObject({ intent: 'MODIFY', confidence: 1 })
  }, 60_000)

  it('reads a negative or missing confidence as 0, which asks instead of acting', async () => {
    const { c } = await reads(built, classifiedAs({ intent: 'MODIFY', confidence: -2, reasoning: 'r' }), [clarification('Which table?')])
    expect(c).toMatchObject({ intent: 'UNCLEAR', confidence: 0 })
    const missing = await reads(built, classifiedAs({ intent: 'MODIFY', reasoning: 'r' }), [clarification('Which table?')])
    expect(missing.c).toMatchObject({ intent: 'UNCLEAR', confidence: 0 })
  }, 60_000)

  it('reads an intent it does not know as UNCLEAR', async () => {
    const { c } = await reads(built, classifiedAs({ intent: 'banana', confidence: 0.99, reasoning: 'r' }), [clarification('Which table?')])
    expect(c.intent).toBe('UNCLEAR')
  }, 60_000)

  it('reads an answer that is not JSON as UNCLEAR, and says it could not read it', async () => {
    const { c, result } = await reads(built, scriptedMessage({ text: 'I think you want to build something.' }), [clarification('What would you like?')])
    expect(c).toMatchObject({ intent: 'UNCLEAR', confidence: 0 })
    expect(c.reasoning).toContain('could not be read')
    expect(result.needsUser).toBe(true)
  }, 60_000)

  it('keeps no more than 200 characters of the reasoning', async () => {
    const { c } = await reads(built, classifiedAs({ intent: 'CHAT', confidence: 0.9, reasoning: 'x'.repeat(500) }), [scriptedMessage({ text: 'ok' })])
    expect(c.reasoning).toHaveLength(200)
  }, 60_000)

  it.each(['BUILD', 'MODIFY', 'DESTRUCTIVE', 'FIX', 'CONFIRM', 'APPLY_PROPOSAL'])(
    'does not trust a low-confidence %s on a built project: it asks',
    async (intent) => {
      const { c, result } = await reads(built, classifiedAs({ intent, confidence: 0.3, reasoning: 'r' }), [clarification('Which one?')])
      expect(c.intent).toBe('UNCLEAR')
      expect(c.reasoning).toContain('low confidence (0.30)')
      expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
    },
    60_000,
  )

  it.each(['CHAT', 'QUESTION'])('keeps a low-confidence %s: answering cannot change anything', async (intent) => {
    const { c } = await reads(
      built,
      classifiedAs({ intent, confidence: 0.2, reasoning: 'r' }),
      intent === 'CHAT' ? [scriptedMessage({ text: 'ok' })] : [finished('Done.')],
    )
    expect(c.intent).toBe(intent)
  }, 60_000)

  it.each(['BUILD', 'MODIFY', 'APPLY_PROPOSAL'])(
    'keeps a low-confidence %s on a brand-new project, so a description is designed, not questioned',
    async (intent) => {
      const { c, result, provider } = await reads(fresh, classifiedAs({ intent, confidence: 0.2, reasoning: 'r' }))
      expect(c.intent).toBe(intent)
      expect(c.reasoning).toContain('fresh project')
      expect(provider.calls.length).toBeGreaterThanOrEqual(1)
      expect(result.classification.intent).toBe(intent)
    },
    60_000,
  )

  it('still asks on a brand-new project when a low-confidence intent is not a build', async () => {
    const { c } = await reads(fresh, classifiedAs({ intent: 'DESTRUCTIVE', confidence: 0.2, reasoning: 'r' }), [clarification('Which one?')])
    expect(c.intent).toBe('UNCLEAR')
  }, 60_000)
})

describe('a clarifying question', () => {
  it('keeps at most three options, only the ones that are text', async () => {
    const { result } = await built.turn(
      [classified('UNCLEAR'), scriptedMessage({ text: JSON.stringify({ question: 'Which?', options: ['a', '  ', 7, 'b', 'c', 'd'] }) })],
      'hmm',
    )
    expect(JSON.stringify(result)).toContain('Which?')
  }, 60_000)

  it('falls back to a plain question, and does not stop, when the model cannot write one', async () => {
    const { result } = await built.turn([classified('UNCLEAR'), ...providerRefusal('unavailable', 503)], 'hmm')
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
    expect(result.summary.length).toBeGreaterThan(10)
  }, 60_000)

  it('falls back when what it wrote is not a question', async () => {
    const { result } = await built.turn([classified('UNCLEAR'), scriptedMessage({ text: JSON.stringify({ options: [] }) })], 'hmm')
    expect(result).toMatchObject({ needsUser: true, toolsRun: ['ask_user'] })
    expect(result.summary.length).toBeGreaterThan(10)
  }, 60_000)
})

// ── Which words say "a plan is waiting" ───────────────────────────────────────

describe('a CONFIRM with nothing stored: when the last assistant message counts as a plan', () => {
  const planAsk = (phrase: string) => `Here is what I will build.\n\n${phrase}`

  it.each([
    ['Reply "go ahead" to run this, or tell me what to add or remove.'],
    ['Reply *"go ahead"* to run this'],
    ["Reply 'go ahead' to run this"],
    ['Reply go ahead to run this'],
    ['reply "GO AHEAD" to run this'],
  ])('%s: enters the loop', async (phrase) => {
    await saveTurn(built.projectId, 'add comments', planAsk(phrase))
    const { provider } = await built.turn([classified('CONFIRM'), finished('No plan is stored.')], 'go ahead')
    expect(provider.calls).toHaveLength(2)
  }, 60_000)

  it.each([
    ['Say go ahead if you like it.'],
    ['I added the table.'],
    ['Reply "go ahead" to start'],
  ])('%s: answers that nothing is waiting', async (phrase) => {
    await saveTurn(built.projectId, 'add comments', planAsk(phrase))
    const { provider, result } = await built.turn([classified('CONFIRM')], 'go ahead')
    expect(provider.calls).toHaveLength(1)
    expect(result.iterations).toBe(0)
  }, 60_000)

  it('only the LAST assistant message counts: a later answer retires an earlier plan', async () => {
    await saveTurn(built.projectId, 'add comments', planAsk('Reply "go ahead" to run this'))
    await saveTurn(built.projectId, 'never mind', 'Okay, nothing will be built.')
    const { provider } = await built.turn([classified('CONFIRM')], 'go ahead')
    expect(provider.calls).toHaveLength(1)
  }, 60_000)

  it('an open proposal is something to confirm, so the loop runs', async () => {
    await saveProposal(proposalOf(built.projectId, 'open'))
    const { provider } = await built.turn([classified('CONFIRM'), finished('Applied.')], 'yes')
    expect(provider.calls).toHaveLength(2)
  }, 60_000)
})

// ── What the loop is offered, per intent ──────────────────────────────────────

describe('what the loop is told and offered for each intent', () => {
  const HINTS: Array<[string, string]> = [
    ['BUILD', 'this is a BUILD request'],
    ['MODIFY', 'this is a MODIFY request on an existing resource'],
    ['FIX', 'this is a FIX request'],
    ['DESTRUCTIVE', 'this is a DESTRUCTIVE request'],
    ['QUESTION', 'this is a QUESTION about the project state'],
    ['APPLY_PROPOSAL', 'act on a list'],
  ]

  it.each(HINTS)('%s: the hint names the intent, and the confidence is shown', async (intent, hint) => {
    const { provider } = await built.turn([classified(intent, 0.8), finished('Done.')], 'do it')
    const system = systemOf(provider, 1)
    expect(system).toContain(hint)
    expect(system).toContain(`INTENT CLASSIFICATION (advisory): ${intent} (0.80)`)
  }, 60_000)

  it('every intent but QUESTION and CONFIRM is offered the whole catalog; QUESTION only reads', async () => {
    const full = await built.turn([classified('MODIFY'), finished('Done.')], 'do it')
    const question = await built.turn([classified('QUESTION'), finished('Done.')], 'what is there?')
    const all = toolNamesOf(full.provider, 1)
    const reads = toolNamesOf(question.provider, 1)

    expect(all).toContain('create_table')
    expect(all).toContain('drop_table')
    expect(reads).not.toContain('create_table')
    expect(reads).toEqual(expect.arrayContaining(['read_backend_state', 'finish', 'ask_user', 'answer_question']))
    expect(reads.length).toBeLessThan(all.length)
  }, 60_000)

  it('is told the page the person is on, and not when they are on none', async () => {
    const on = await built.turn([classified('MODIFY'), finished('Done.')], 'fix this', { surface: 'Database' })
    const off = await built.turn([classified('MODIFY'), finished('Done.')], 'fix this')
    expect(systemOf(on.provider, 1)).toContain("USER'S CURRENT PAGE: Database")
    expect(systemOf(off.provider, 1)).not.toContain("USER'S CURRENT PAGE")
  }, 60_000)

  it('is sent the saved summary of earlier turns once a conversation is long', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      projectId: built.projectId,
      role: i % 2 === 0 ? 'user' : 'ai',
      content: `earlier message ${i}`,
    }))
    for (const r of rows) await prisma.conversationMessage.create({ data: r })

    // The first turn pushes the log past the threshold; its summary is written in the background.
    const first = await built.turn(
      [
        classified('CHAT'),
        scriptedMessage({ text: 'ok' }),
        scriptedMessage({ text: JSON.stringify({ builtSoFar: ['keep_me'], decisions: [], userPreferences: [], currentFocus: 'tidying keep_me' }) }),
      ],
      'hello',
    )
    for (let i = 0; i < 50 && first.provider.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 100))
    expect(first.provider.calls).toHaveLength(3)
    for (let i = 0; i < 50; i++) {
      if (await prisma.conversationMessage.count({ where: { projectId: built.projectId, role: 'summary' } })) break
      await new Promise((r) => setTimeout(r, 100))
    }

    const next = await built.turn([classified('MODIFY'), finished('Done.')], 'carry on')
    expect(systemOf(next.provider, 1)).toContain('EARLIER CONTEXT:')
    expect(systemOf(next.provider, 1)).toContain('Current focus: tidying keep_me')
  }, 60_000)
})

// ── How the loop stops, and what that leaves for "continue" ───────────────────

describe('a stop that invites "continue" saves what "continue" resumes', () => {
  it('the model failing after a change: retryable, or the provider unavailable', async () => {
    for (const refusal of [providerRefusal('rate_limited', 429), [new AiError('quota_exhausted', 'out of credit', { consumption: 'none' })]]) {
      const { result } = await built.turn([classified('MODIFY'), createNotes(`n_${Math.random().toString(36).slice(2, 8)}`), ...refusal], 'add a table')
      expect(result.applied).toHaveLength(1)
      const marker = await loadLoopResume(built.projectId)
      expect(marker).toMatchObject({ request: 'add a table', reason: 'the AI model failed partway' })
      expect(marker!.applied).toHaveLength(1)
    }
  }, 60_000)

  it('says to wait for AI, not to rephrase, when the provider is unavailable', async () => {
    const { result } = await built.turn(
      [classified('MODIFY'), createNotes('before_outage'), new AiError('quota_exhausted', 'out of credit', { consumption: 'none' })],
      'add a table',
    )
    expect(result).toMatchObject({ success: false, failureCode: 'AI_UNAVAILABLE', retryable: false })
    expect(result.summary).toContain('Say "continue" once AI is available again')
  }, 60_000)

  it('saves nothing for a model failure that retrying cannot fix: it says to rephrase', async () => {
    const { result } = await built.turn(
      [classified('MODIFY'), createNotes('before_invalid'), new AiError('invalid_request', 'bad request', { consumption: 'none' })],
      'add a table',
    )
    expect(result).toMatchObject({ failureCode: 'MODEL_ERROR', retryable: false })
    expect(result.summary).toContain("Rephrase what is left")
    expect(await loadLoopResume(built.projectId)).toBeNull()
  }, 60_000)

  it('saves nothing when the model fails before any change: there is nothing to resume', async () => {
    await built.turn([classified('MODIFY'), ...providerRefusal('rate_limited', 429)], 'add a table')
    expect(await loadLoopResume(built.projectId)).toBeNull()
  }, 60_000)

  it('a deadline already inside the reserve stops before the first step, verified, and can be continued', async () => {
    const { result, provider, events } = await built.turn(
      [classified('MODIFY')],
      'add a table',
      { deadlineAt: Date.now() + 5_000 },
    )

    expect(provider.calls).toHaveLength(1)
    expect(result).toMatchObject({ success: false, budgetStopped: true, verified: true, iterations: 0, applied: [] })
    expect(result.summary).toContain('ran out of time budget before changing anything')
    expect(result.summary).toContain('keep_me')
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('verification is budgeted, never dropped') }))
    expect(await loadLoopResume(built.projectId)).toMatchObject({ request: 'add a table', reason: 'it stopped to keep time for verification' })
  }, 60_000)

  it('a deadline reached after changes lists what landed, what was refused, and the live state', async () => {
    const realNow = Date.now()
    const deadlineAt = realNow + 60_000
    const jump = (message: ReturnType<typeof createNotes>) => () => {
      jest.spyOn(Date, 'now').mockReturnValue(deadlineAt + 3_600_000)
      return message
    }

    const { result } = await built.turn(
      [
        classified('MODIFY'),
        // Refused: it already exists.
        toolCall('create_table', { tableName: 'keep_me', columns: [{ name: 'title', type: 'text' }] }, 'toolu_dup'),
        jump(createNotes('landed_in_time')),
      ],
      'add two tables',
      { deadlineAt },
    )

    expect(result).toMatchObject({ success: false, budgetStopped: true, verified: true })
    expect(result.summary).toContain('Applied and verified (1)')
    expect(result.summary).toContain('Attempted and REFUSED (1)')
    expect(result.summary).toContain('landed_in_time')
    expect(result.summary).toContain('Say "continue" for the rest')
    expect(await built.tableExists('landed_in_time')).toBe(true)
    const marker = await loadLoopResume(built.projectId)
    expect(marker!.applied).toHaveLength(1)
  }, 60_000)
})

describe('a turn that finishes after a change without ever verifying it', () => {
  it('is steered once, and when finish is called again it reports the change as applied but unverified', async () => {
    const { result, provider } = await built.turn(
      [classified('MODIFY'), createNotes('unverified_one'), finished('Created it.'), finished('Created it, really.')],
      'add a table',
    )

    expect(provider.calls).toHaveLength(4)
    expect(result).toMatchObject({ success: false, failureCode: 'UNVERIFIED', retryable: false })
    expect(result.summary).toContain('I applied changes, but could not verify the resulting state')
    expect(result.summary).toContain('I did not retry them')
    expect(await built.tableExists('unverified_one')).toBe(true)
  }, 60_000)
})

describe('a failure to write down what a turn did', () => {
  it('does not fail the turn when its resume point cannot be saved', async () => {
    jest.spyOn(prisma.projectPreference, 'upsert').mockRejectedValueOnce(new Error('disk full'))
    const reads = Array.from({ length: 12 }, (_, i) => toolCall('read_backend_state', {}, `toolu_read_${i}`))

    const { result } = await built.turn([classified('QUESTION'), ...reads], 'what is there?')

    expect(result).toMatchObject({ success: false, failureCode: 'STEP_BUDGET_EXHAUSTED' })
    expect(await loadLoopResume(built.projectId)).toBeNull()
  }, 60_000)

  it('does not fail the turn when its operational-memory receipt cannot be written', async () => {
    receipt.mockRejectedValueOnce(new Error('ledger down'))

    const { result } = await built.turn(
      [classified('MODIFY'), createNotes('unreceipted'), toolCall('read_backend_state'), finished('Created unreceipted.')],
      'add a table',
    )

    expect(result).toMatchObject({ success: true, applied: expect.any(Array) })
    expect(await built.tableExists('unreceipted')).toBe(true)
  }, 60_000)

  it('still runs when the project\'s integrations cannot be listed', async () => {
    jest.spyOn(prisma.projectIntegrationKey, 'findMany').mockRejectedValueOnce(new Error('lookup failed'))

    const { result } = await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'hello')

    expect(result.success).toBe(true)
  }, 60_000)
})

describe('a model call that ran before it failed', () => {
  it('is billed what it says it consumed, so a refused answer is not free', async () => {
    const usage = { promptTokens: 1000, inputTokens: 1000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 500 }
    const ran = new AiError('refused', 'declined', { consumption: 'ran', usage })
    ran.model = 'claude-opus-4-6'

    const { result, spent } = await built.turn([classified('MODIFY'), ran], 'add a table')

    expect(result).toMatchObject({ success: false, failureCode: 'MODEL_ERROR', retryable: false })
    // The loop's own meter: the one call that ran, and nothing else.
    expect(spent).toHaveLength(1)
    expect(spent[0]).toBeGreaterThan(0)
    expect(result.tokensUsed).toBe(spent[0])
  }, 60_000)

  it('is not billed when it did not run', async () => {
    const { spent, result } = await built.turn([classified('MODIFY'), ...providerRefusal('rate_limited', 429)], 'add a table')
    expect(spent).toEqual([])
    expect(result.tokensUsed).toBe(0)
  }, 60_000)
})

describe('how a step\'s calls are handled', () => {
  it('answers every call of one step, in order, in one turn', async () => {
    const step = scriptedMessage({
      toolUse: [
        { id: 'toolu_a', name: 'read_backend_state', input: {} },
        { id: 'toolu_b', name: 'list_tables', input: {} },
      ],
    })
    const { provider, result } = await built.turn([classified('QUESTION'), step, finished('Done.')], 'what is there?')

    const answered = provider.calls[2].params.messages.at(-1) as { role: string; content: Array<{ tool_use_id: string }> }
    expect(answered.role).toBe('user')
    expect(answered.content.map((b) => b.tool_use_id)).toEqual(['toolu_a', 'toolu_b'])
    expect(result.toolsRun).toEqual(['read_backend_state', 'list_tables', 'finish'])
  }, 60_000)

  it('gives a tool that does not exist back as a refusal, and reports it', async () => {
    const { result } = await built.turn(
      [classified('MODIFY'), toolCall('frobnicate', { x: 1 }), toolCall('read_backend_state'), finished('Nothing to do.')],
      'frobnicate it',
    )
    expect(result.refused).toHaveLength(1)
    expect(result.refused![0].title).toContain('frobnicate')
    expect(result.applied).toEqual([])
  }, 60_000)

  it('shows what the model said alongside a step, clipped, as thinking', async () => {
    const long = 'z'.repeat(1000)
    const { events } = await built.turn(
      [classified('QUESTION'), scriptedMessage({ text: long, toolUse: [{ id: 't', name: 'read_backend_state', input: {} }] }), finished('Done.')],
      'what is there?',
    )
    const thought = events.find((e) => e.type === 'thinking') as { text: string }
    expect(thought.text).toHaveLength(320)
  }, 60_000)

  it('announces the turn\'s phases in order: understand, classify, route, execute, verify', async () => {
    const { events } = await built.turn(
      [classified('MODIFY'), createNotes('phased'), toolCall('read_backend_state'), finished('Created phased.')],
      'add a phased table',
    )
    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase)
    expect(phases.slice(0, 3)).toEqual(['understand', 'classify', 'route'])
    expect(phases).toContain('execute')
    expect(events.at(-1)).toMatchObject({ type: 'final', summary: 'Created phased.' })
    // Tool events arrive start-then-done, per call.
    const tools = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_done').map((e) => `${e.type}:${(e as { tool: string }).tool}`)
    expect(tools.slice(0, 2)).toEqual(['tool_start:create_table', 'tool_done:create_table'])
  }, 60_000)
})

// ── What a turn writes down ───────────────────────────────────────────────────

describe('what a turn writes down', () => {
  it('saves the exchange once for a request id, however often the turn is sent', async () => {
    const requestId = '4f6f3a52-3b0b-4a68-9e9c-0c0b6a4d2c11'
    await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'hello', { requestId })
    await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'hello', { requestId })

    const saved = await prisma.conversationMessage.findMany({ where: { projectId: built.projectId, role: { in: ['user', 'ai'] } } })
    expect(saved).toHaveLength(2)
  }, 60_000)

  it('saves both sides when no request id is sent, as backend_chat sends none', async () => {
    await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'hello')
    await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'hello')

    expect(await prisma.conversationMessage.count({ where: { projectId: built.projectId, role: { in: ['user', 'ai'] } } })).toBe(4)
  }, 60_000)

  it('redacts a credential the person pasted before it reaches the log', async () => {
    await built.turn([classified('CHAT'), scriptedMessage({ text: 'ok' })], 'connect postgres://admin:hunter2secret@db.example.test/app')

    const saved = await prisma.conversationMessage.findMany({ where: { projectId: built.projectId } })
    expect(saved.map((m) => m.content).join('\n')).not.toContain('hunter2secret')
  }, 60_000)

  it('records a receipt per tool of a loop turn, as applied when it landed and failed when it did not', async () => {
    await prisma.backendEvent.deleteMany({ where: { projectId: built.projectId } })
    await built.turn(
      [classified('MODIFY'), createNotes('receipted'), toolCall('read_backend_state'), finished('Created receipted.')],
      'add a receipted table',
    )
    for (let i = 0; i < 50 && !(await prisma.backendEvent.count({ where: { projectId: built.projectId } })); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const events = await prisma.backendEvent.findMany({ where: { projectId: built.projectId } })

    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.status === 'applied')).toBe(true)
  }, 60_000)

  it('records no receipt for a turn that ran no tool', async () => {
    await prisma.backendEvent.deleteMany({ where: { projectId: built.projectId } })
    await built.turn([classified('CONFIRM')], 'yes')
    await new Promise((r) => setTimeout(r, 300))
    expect(await prisma.backendEvent.count({ where: { projectId: built.projectId } })).toBe(0)
  }, 60_000)
})
