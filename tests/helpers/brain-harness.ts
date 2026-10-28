/**
 * A deterministic harness for runBrain: the real brain, the real dispatcher and
 * executor, and the real test database, with only the model scripted.
 *
 * The model is the one thing a test cannot run. Everything else a turn touches
 * is a real table or a real function: the project and its workspace schema, the
 * conversation log, the pending-plan store, the usage rows. A turn is driven
 * with a list of scripted answers, in the order the brain asks for them, so a
 * test pins exactly which calls were made and what was done with each answer.
 *
 * Call setUpBrainProject() at the top level of a suite (or inside a describe):
 * it registers the hooks that create the project before the suite and reset the
 * model, the spend ledger and the conversation between tests.
 *
 *   const brain = setUpBrainProject({ name: 'brain-routing', tables: ['keep_me'] })
 *   it('...', async () => {
 *     const { result, provider } = await brain.turn([classified('QUESTION'), finished('Done.')], 'hi')
 *   })
 *
 * Spend reservations go to the gateway's in-memory ledger. The Postgres ledger
 * has its own suite (tests/integration/ai-spend-ledger.spec.ts); writing these
 * calls into the current month of a shared test database would leave spend
 * behind that no test can safely subtract.
 */

import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db/prisma'
import { AiError, setProviderForTests, setRetryDelayForTests, type AiErrorKind } from '@/lib/ai/llm'
import {
  scriptedMessage,
  scriptedProvider,
  type ScriptedProvider,
  type ScriptStep,
} from '@/lib/ai/llm/providers/scripted'
import { memorySpendLedger, setSpendLedgerForTests } from '@/lib/ai/llm/spend'
import { executorCalls, type ExecutorCall } from './brain-executor-recorder'
import { runBrain, type BrainEvent, type BrainInput, type BrainResult } from '@/lib/ai/brain/agent'

/** The classifier's answer: the intent the turn is routed by. */
export const classified = (intent: string, confidence = 0.9) =>
  scriptedMessage({ text: JSON.stringify({ intent, confidence, reasoning: 'scripted' }) })

/** One agent-loop step that calls a tool. */
export const toolCall = (name: string, input: Record<string, unknown> = {}, id = `toolu_${name}`) =>
  scriptedMessage({ toolUse: [{ id, name, input }] })

/** One agent-loop step that ends the turn with `summary`. */
export const finished = (summary: string) => toolCall('finish', { summary }, 'toolu_finish')

/** The clarifying question the brain asks for an UNCLEAR turn. */
export const clarification = (question: string, options: string[] = []) =>
  scriptedMessage({ text: JSON.stringify({ question, options }) })

/**
 * A provider that refuses a call before running it, as the script's answer to
 * it. The gateway repeats such a refusal, so the script holds one per attempt;
 * spread it into the script in place of a single answer.
 */
export const providerRefusal = (kind: AiErrorKind, status?: number): ScriptStep[] =>
  Array.from({ length: 3 }, () => new AiError(kind, `scripted ${kind}`, { retryable: true, consumption: 'none', status }))

/** Every system block of one recorded model call, as one text. */
export const systemOf = (provider: ScriptedProvider, call: number) =>
  ((provider.calls[call].params.system ?? []) as Anthropic.TextBlockParam[]).map((b) => b.text).join('\n')

/** The names of the tools one recorded model call was offered. */
export const toolNamesOf = (provider: ScriptedProvider, call: number) =>
  (provider.calls[call].params.tools ?? []).map((t) => t.name)

export interface BrainTurn {
  result: BrainResult
  events: BrainEvent[]
  /** What the model was sent, call by call. */
  provider: ScriptedProvider
  /** The model calls the turn made: `provider.calls`, under the name the issue gives it. */
  modelCalls: ScriptedProvider['calls']
  /**
   * The actions the turn handed to the executor, in order. Only recorded by a
   * suite that mocks the executor with brain-executor-recorder; empty otherwise.
   */
  executorCalls: ExecutorCall[]
  /** Tokens reported through onTokens, in the order they were spent. */
  spent: number[]
}

export interface BrainProject {
  readonly projectId: string
  readonly ownerId: string
  readonly schema: string
  /** Run one turn against this project. A step the script runs short of throws, which fails the test. */
  turn(script: ScriptStep[], message: string, extra?: Partial<BrainInput>): Promise<BrainTurn>
  tableExists(name: string): Promise<boolean>
}

export interface BrainProjectOptions {
  /** Used in the project's name and its owner's email. */
  name: string
  /** Tables to create in the workspace schema. None leaves the project brand new. */
  tables?: string[]
}

export function setUpBrainProject(options: BrainProjectOptions): BrainProject {
  const state = { ownerId: '', projectId: '', schema: '' }

  /** The workspace as the suite declared it: its tables, and nothing a turn built. */
  const resetWorkspace = async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${state.schema}" CASCADE`)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${state.schema}"`)
    for (const table of options.tables ?? []) {
      await prisma.$executeRawUnsafe(`CREATE TABLE "${state.schema}"."${table}" (id serial PRIMARY KEY, label text)`)
    }
  }

  beforeAll(async () => {
    state.ownerId = (await prisma.user.create({
      data: {
        email: `${options.name}-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'brain',
      },
    })).id
    state.projectId = (await prisma.project.create({ data: { name: options.name, userId: state.ownerId } })).id
    state.schema = `workspace_${state.projectId}`
    await resetWorkspace()
  }, 60_000)

  beforeEach(async () => {
    setSpendLedgerForTests(memorySpendLedger())
    setRetryDelayForTests(() => 0)
    // A table an earlier test built would make a brand-new project look built.
    await resetWorkspace()
    // Past 20 saved messages a turn starts a summary without waiting, and that
    // model call would take the next test's scripted answer. Each test starts
    // with no history, and with no plan or resume queue left by the last one.
    await prisma.conversationMessage.deleteMany({ where: { projectId: state.projectId } })
    await prisma.projectPreference.deleteMany({ where: { projectId: state.projectId, type: 'pending_plan' } })
  })

  afterEach(() => {
    setProviderForTests(null)
    setSpendLedgerForTests(null)
    setRetryDelayForTests(null)
  })

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${state.schema}" CASCADE`).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: state.projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: state.ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: state.ownerId } }).catch(() => {})
  }, 60_000)

  return {
    get projectId() { return state.projectId },
    get ownerId() { return state.ownerId },
    get schema() { return state.schema },
    async turn(script, message, extra = {}) {
      const provider = scriptedProvider(script)
      setProviderForTests(provider)
      const events: BrainEvent[] = []
      const spent: number[] = []
      const executorBefore = executorCalls.length
      const result = await runBrain(
        { projectId: state.projectId, userId: state.ownerId, message, onTokens: (n) => spent.push(n), ...extra },
        (e) => events.push(e),
      )
      return { result, events, provider, modelCalls: provider.calls, executorCalls: executorCalls.slice(executorBefore), spent }
    },
    async tableExists(name) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        state.schema,
        name,
      )
      return rows[0].n > 0
    },
  }
}
